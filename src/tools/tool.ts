/**
 * 工具系统。
 *
 * 核心设计决策：**工具失败不是异常，而是给模型的反馈**。
 * 当工具不存在、参数不合法、执行报错时，运行时不会中断 Agent，
 * 而是把结构化错误作为 tool_result 回喂给模型 —— 这正是模型自我修正
 * （"我调用错了工具名，换个名字重试"）所必需的回路。
 */

import { z, type ZodTypeAny } from "zod";

import { ToolError } from "../core/errors.js";
import { mapLimit } from "../core/task.js";
import type { JsonSchema, ToolCallPart, ToolResultPart, ToolSpec } from "../models/types.js";
import { normalizeSchema } from "./schema.js";

export interface ToolContext {
  /** 中断信号；取消时正在执行的工具应尽快退出。 */
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly agentName: string;
  readonly sessionId?: string;
  /** 结构化日志出口，默认走 trace。 */
  readonly log?: (message: string, data?: unknown) => void;
}

/**
 * 任意工具的通用类型。
 *
 * 为什么需要它：`Tool<I, O>` 的 `execute` 参数是**逆变**的，因此
 * `Tool<{path: string}>` 无法赋值给 `Tool<unknown>`。用 `any` 打破逆变限制，
 * 使 Registry 能统一持有不同输入输出类型的工具（类型安全由 defineTool 在定义处保证）。
 */
export type AnyTool = Tool<any, any>;

export type ToolExecute<I, O> = (input: I, context: ToolContext) => Promise<O> | O;

export interface ToolConfig<I, O> {
  readonly name: string;
  /** 描述会直接发给模型，质量决定调用准确率 —— 这是工具最重要的字段。 */
  readonly description: string;
  readonly inputSchema: ZodTypeAny | JsonSchema;
  readonly execute: ToolExecute<I, O>;
  readonly timeoutMs?: number;
  /** 需要人工审批（如执行 shell、写文件）。 */
  readonly requiresApproval?: boolean | ((input: I) => boolean);
  /** 输出超过该字符数时截断，避免撑爆上下文。 */
  readonly maxOutputChars?: number;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny | JsonSchema;
  readonly jsonSchema: JsonSchema;
  readonly execute: ToolExecute<I, O>;
  readonly timeoutMs?: number;
  readonly requiresApproval?: boolean | ((input: I) => boolean);
  readonly maxOutputChars?: number;
}

export function defineTool<S extends ZodTypeAny, O>(config: {
  name: string;
  description: string;
  inputSchema: S;
  execute: ToolExecute<z.infer<S>, O>;
  timeoutMs?: number;
  requiresApproval?: boolean | ((input: z.infer<S>) => boolean);
  maxOutputChars?: number;
}): Tool<z.infer<S>, O>;

export function defineTool<I, O>(config: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute: ToolExecute<I, O>;
  timeoutMs?: number;
  requiresApproval?: boolean | ((input: I) => boolean);
  maxOutputChars?: number;
}): Tool<I, O>;

export function defineTool<I, O>(config: ToolConfig<I, O>): Tool<I, O> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    jsonSchema: normalizeSchema(config.inputSchema),
    execute: config.execute,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.requiresApproval !== undefined ? { requiresApproval: config.requiresApproval } : {}),
    ...(config.maxOutputChars !== undefined ? { maxOutputChars: config.maxOutputChars } : {}),
  };
}

export type ApprovalDecision = "approve" | "deny";
export type ApprovalHandler = (request: {
  readonly toolName: string;
  readonly input: unknown;
  readonly callId: string;
}) => Promise<ApprovalDecision> | ApprovalDecision;

export interface ToolRegistryOptions {
  /** 需要审批的工具会先经过该钩子。 */
  readonly approvalHandler?: ApprovalHandler;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly options: ToolRegistryOptions;

  constructor(options: ToolRegistryOptions = {}) {
    this.options = options;
  }

  register(tool: AnyTool): this {
    this.tools.set(tool.name, tool as AnyTool);
    return this;
  }

  registerAll(tools: readonly AnyTool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly AnyTool[] {
    return [...this.tools.values()];
  }

  get names(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** 交给模型的工具规格列表。 */
  specs(): readonly ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    }));
  }

  /** 从另一个 registry 合入工具（用于组合内置工具集与业务工具）。 */
  merge(other: ToolRegistry): this {
    for (const tool of other.list()) this.register(tool);
    return this;
  }

  /**
   * 执行单个工具调用，永不抛错 —— 所有失败都以 isError 结果返回。
   */
  async execute(
    call: Pick<ToolCallPart, "id" | "name" | "args">,
    context: Omit<ToolContext, "callId"> & { readonly callId?: string },
  ): Promise<ToolResultPart> {
    const callId = context.callId ?? call.id;
    const fullContext: ToolContext = { ...context, callId };
    const tool = this.tools.get(call.name);

    if (!tool) {
      return {
        type: "tool_result",
        id: call.id,
        name: call.name,
        isError: true,
        output: `Tool "${call.name}" does not exist. Available tools: ${this.names.join(", ") || "(none)"}`,
      };
    }

    // 1) 输入校验
    const validated = validateInput(tool, call.args);
    if (!validated.ok) {
      return {
        type: "tool_result",
        id: call.id,
        name: call.name,
        isError: true,
        output: `Invalid arguments for tool "${call.name}":\n${validated.error}`,
      };
    }

    // 2) 审批
    const requires =
      typeof tool.requiresApproval === "function"
        ? tool.requiresApproval(validated.value)
        : (tool.requiresApproval ?? false);
    if (requires) {
      const decision = await this.options.approvalHandler?.({
        toolName: call.name,
        input: validated.value,
        callId,
      });
      if (decision !== "approve") {
        return {
          type: "tool_result",
          id: call.id,
          name: call.name,
          isError: true,
          output: `Execution of tool "${call.name}" was denied by the approval policy.`,
        };
      }
    }

    // 3) 执行（含超时与中断）
    const timeoutMs = tool.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const output = await withToolTimeout(
        Promise.resolve(tool.execute(validated.value, fullContext)),
        timeoutMs,
        context.signal,
      );
      return {
        type: "tool_result",
        id: call.id,
        name: call.name,
        isError: false,
        output: serializeOutput(output, tool.maxOutputChars ?? this.options.defaultMaxOutputChars),
      };
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      return {
        type: "tool_result",
        id: call.id,
        name: call.name,
        isError: true,
        output: `Tool "${call.name}" failed: ${error.message}`,
      };
    }
  }

  /**
   * 并行执行多个工具调用。
   * 用 mapLimit 而非 Promise.all：可限制并发、且中断时已启动的任务会被取消。
   */
  async executeMany(
    calls: readonly Pick<ToolCallPart, "id" | "name" | "args">[],
    context: Omit<ToolContext, "callId">,
    concurrency?: number,
  ): Promise<readonly ToolResultPart[]> {
    if (calls.length === 0) return [];
    return mapLimit(
      calls,
      concurrency ?? calls.length,
      (call, _index, signal) =>
        this.execute(call, { ...context, signal, callId: call.id }),
      { signal: context.signal, failFast: false },
    ).then((results) =>
      results.map((result, index) => {
        const call = calls[index]!;
        if (result.ok) return result.value;
        return {
          type: "tool_result" as const,
          id: call.id,
          name: call.name,
          isError: true,
          output: `Tool "${call.name}" could not be executed: ${result.error.message}`,
        };
      }),
    );
  }
}

function validateInput(
  tool: AnyTool,
  args: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (tool.inputSchema instanceof z.ZodType) {
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (parsed.success) return { ok: true, value: parsed.data };
    return {
      ok: false,
      error: parsed.error.issues
        .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n"),
    };
  }
  // 裸 JSON Schema 场景：只做最小必要校验
  if (args === null || typeof args !== "object") {
    return { ok: false, error: "Arguments must be an object" };
  }
  return { ok: true, value: args };
}

async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (timer) clearTimeout(timer);
  };
  signal.addEventListener?.("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolError("timeout", `Tool execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener?.("abort", onAbort);
  }
}

export function serializeOutput(output: unknown, maxChars = DEFAULT_MAX_OUTPUT_CHARS): string {
  let text: string;
  if (typeof output === "string") {
    text = output;
  } else if (output === undefined) {
    text = "";
  } else {
    try {
      text = JSON.stringify(output, null, 2) ?? String(output);
    } catch {
      text = String(output);
    }
  }
  if (maxChars > 0 && text.length > maxChars) {
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n…[truncated ${omitted} chars]`;
  }
  return text;
}
