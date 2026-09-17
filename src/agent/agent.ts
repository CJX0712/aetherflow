/**
 * Agent 运行时核心。
 *
 * 一个 Agent = 指令 + 模型 + 工具 + 护栏，围绕一个可观测的事件流循环运行。
 *
 * 关键设计：
 *  1. **流式优先**：`run()` 只是 `stream()` 的收敛，UI 与持久化共享同一份事件流
 *  2. **护栏内建**：步数 / 预算 / 超时 / 中断在循环内统一检查，失控的 Agent 会被主动终止
 *  3. **工具失败不致命**：工具错误作为 tool_result 回喂模型，触发自我修正而非崩溃
 *  4. **上下文自适应**：每轮调用前按预算压缩，保证长任务不会因溢出而崩塌
 */

import { randomUUID } from "node:crypto";

import { AetherError, MaxStepsExceededError, isAbortError, toError } from "../core/errors.js";
import { withRetry } from "../core/retry.js";
import { Stream } from "../core/stream.js";
import {
  addUsage,
  computeCost,
  emptyUsage,
  type ContentPart,
  type FinishReason,
  type Message,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ToolCallPart,
  type Usage,
  assistantMessage,
  partsOf,
  systemMessage,
  textOf,
  toolCallsOf,
  toolResultMessage,
  userMessage,
} from "../models/types.js";
import { createDefaultRegistry } from "../models/index.js";
import { lookupPricing } from "../models/pricing.js";
import { ToolRegistry, type AnyTool } from "../tools/tool.js";
import { toJsonSchema } from "../tools/schema.js";
import { compactMessages, estimateTokens, renderTemplate, summarizeWithModel } from "./context.js";
import type {
  AgentConfig,
  AgentEvent,
  RunFinishReason,
  RunOptions,
  RunResult,
} from "./types.js";

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_CONTEXT_TOKENS = 120_000;
const DEFAULT_RESERVE_TOKENS = 8_000;
const DEFAULT_OUTPUT_REPAIR_ATTEMPTS = 2;

export interface Agent<O = unknown> {
  readonly name: string;
  readonly config: AgentConfig<O>;
  /** 完整运行一次并返回结果。 */
  run(options?: RunOptions): Promise<RunResult<O>>;
  /** 以事件流方式运行，可实时渲染 / 持久化。 */
  stream(options?: RunOptions): Stream<AgentEvent>;
}

let defaultRegistryCache: ReturnType<typeof createDefaultRegistry> | undefined;

function getDefaultRegistry(): ReturnType<typeof createDefaultRegistry> {
  defaultRegistryCache ??= createDefaultRegistry();
  return defaultRegistryCache;
}

export function createAgent<O = unknown>(config: AgentConfig<O>): Agent<O> {
  const tools = new ToolRegistry();
  if (config.tools) tools.registerAll(config.tools);

  const outputSchema = config.output;

  // 结构化输出策略在 createAgent 时一次定下：优先用供应商原生 JSON Schema（省 token、
  // 保证格式），不支持时才回退为 final_answer 工具（几乎所有支持工具调用的模型都可用）。
  let preferNativeJson = config.outputStrategy === "native";
  if (outputSchema !== undefined && config.outputStrategy === undefined) {
    try {
      preferNativeJson =
        (config.registry ?? getDefaultRegistry()).resolve(config.model).provider.capabilities
          .jsonSchema === true;
    } catch {
      preferNativeJson = false; // 注册表尚不可用时回退到工具模式（最通用）
    }
  }

  // 结构化输出：在不支持原生 JSON Schema 的供应商上，改用 final_answer 工具承载
  let finalAnswerTool: AnyTool | undefined;
  if (outputSchema !== undefined && !preferNativeJson) {
    finalAnswerTool = {
      name: "final_answer",
      description: "Submit the final structured answer and end the run.",
      inputSchema: toJsonSchema(outputSchema),
      jsonSchema: toJsonSchema(outputSchema),
      execute: (input: unknown) => input,
    };
    tools.register(finalAnswerTool);
  }

  const stream = (options: RunOptions = {}): Stream<AgentEvent> =>
    new Stream<AgentEvent>(async function* () {
      const runId = options.runId ?? randomUUID();
      const startedAt = Date.now();
      const registry = config.registry ?? getDefaultRegistry();
      const resolved = registry.resolve(config.model);
      const provider: ModelProvider = resolved.provider;

      const externalSignal = options.signal;
      const controller = new AbortController();
      const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort(externalSignal.reason);
        else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
      const signal = controller.signal;

      // 超时护栏
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      if (config.timeoutMs && config.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          controller.abort(new AetherError("timeout", "Agent run timed out"));
        }, config.timeoutMs);
      }

      // ── 初始化对话 ────────────────────────────────────────────────────────
      const instructions = renderTemplate(config.instructions, options.context ?? {});
      const messages: Message[] = [];
      messages.push(systemMessage(instructions));

      if (options.messages && options.messages.length > 0) {
        messages.push(...options.messages.filter((m) => m.role !== "system"));
      }

      let inputText = "";
      if (typeof options.input === "string") {
        inputText = options.input;
        messages.push(userMessage(inputText));
      } else if (Array.isArray(options.input)) {
        messages.push(...options.input);
        inputText = options.input.map((m) => textOf(m)).join("\n");
      } else if (options.messages && options.messages.length > 0) {
        inputText = options.messages.filter((m) => m.role === "user").map((m) => textOf(m)).join("\n");
      }

      const maxSteps = options.maxSteps ?? config.maxSteps ?? DEFAULT_MAX_STEPS;
      const maxContextTokens = config.context?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
      const reserveTokens = config.context?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

      let steps = 0;
      let totalUsage: Usage = emptyUsage;
      let costUsd = 0;
      let output: O | undefined;
      let finalText = "";
      let finishReason: RunFinishReason = "completed";
      let failure: Error | undefined;

      config.hooks?.onRunStart?.({ runId, agentName: config.name, input: inputText });
      yield { type: "run_start", runId, agentName: config.name, input: inputText };

      try {
        while (steps < maxSteps) {
          if (signal.aborted) {
            finishReason = isAbortError(signal.reason) ? "aborted" : "timeout";
            break;
          }
          if (config.maxCostUsd !== undefined && costUsd >= config.maxCostUsd) {
            finishReason = "budget";
            break;
          }
          if (config.maxTokens !== undefined && totalUsage.totalTokens >= config.maxTokens) {
            finishReason = "budget";
            break;
          }

          steps++;
          config.hooks?.onStepStart?.({ runId, step: steps });
          yield { type: "step_start", step: steps };

          // ── 上下文压缩 ───────────────────────────────────────────────────
          const contextBudget = maxContextTokens - reserveTokens;
          if (estimateTokens(messages) > contextBudget) {
            const compacted = await compactMessages(messages, {
              maxTokens: contextBudget,
              strategy: config.context?.strategy ?? "truncate",
              ...(config.context?.strategy === "summarize"
                ? {
                    summarize: (toSummarize) =>
                      summarizeWithModel(
                        provider,
                        config.context?.summarizerModel ?? resolved.model,
                        toSummarize,
                        signal,
                      ),
                  }
                : {}),
            });
            if (compacted.removedMessages > 0) {
              messages.length = 0;
              messages.push(...compacted.messages);
              if (compacted.usage) {
                totalUsage = addUsage(totalUsage, compacted.usage);
              }
              yield {
                type: "context_compacted",
                removedMessages: compacted.removedMessages,
                strategy: compacted.strategy,
              };
            }
          }

          // ── 调用模型 ──────────────────────────────────────────────────────
          const toolSpecs = tools.specs();
          const useNativeJson = outputSchema !== undefined && preferNativeJson;

          const request: ModelRequest = {
            model: resolved.model,
            messages: [...messages],
            ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.maxOutputTokens !== undefined ? { maxTokens: config.maxOutputTokens } : {}),
            ...(useNativeJson && outputSchema
              ? {
                  responseFormat: {
                    type: "json_schema" as const,
                    name: "output",
                    schema: toJsonSchema(outputSchema),
                  },
                }
              : {}),
            ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
            ...(options.metadata ? { metadata: options.metadata } : {}),
            signal,
          };

          config.hooks?.onStepStart?.({ runId, step: steps });
          yield { type: "model_start", step: steps, model: resolved.model };

          let stepMessage: Message | undefined;
          let stepUsage: Usage = emptyUsage;
          let stepFinish: FinishReason = "stop";

          try {
            for await (const event of streamWithRetry(provider, request, config.retry, signal)) {
              switch (event.type) {
                case "text_delta":
                  yield { type: "text_delta", delta: event.delta };
                  break;
                case "reasoning_delta":
                  yield { type: "reasoning_delta", delta: event.delta };
                  break;
                case "usage":
                  stepUsage = event.usage;
                  break;
                case "finish":
                  stepMessage = event.message;
                  stepUsage = event.usage.totalTokens > 0 ? event.usage : stepUsage;
                  stepFinish = event.finishReason;
                  break;
                case "error":
                  throw event.error;
                default:
                  break;
              }
            }
          } catch (thrown) {
            const error = toError(thrown);
            config.hooks?.onError?.({ runId, error, recoverable: false });
            yield { type: "error", error, recoverable: false };
            failure = error;
            finishReason = isAbortError(error) ? "aborted" : "error";
            break;
          }

          if (!stepMessage) {
            failure = new AetherError("model_error", "Model returned no message");
            finishReason = "error";
            break;
          }

          messages.push(stepMessage);
          totalUsage = addUsage(totalUsage, stepUsage);
          const pricing = lookupPricing(resolved.model);
          const stepCost = computeCost(stepUsage, pricing).total;
          costUsd += stepCost;

          const stepText = textOf(stepMessage);
          if (stepText) finalText = stepText;
          config.hooks?.onModelResponse?.({ runId, step: steps, text: stepText });
          yield { type: "model_end", step: steps, usage: stepUsage };
          yield { type: "usage", usage: totalUsage, costUsd };

          const calls = toolCallsOf(stepMessage);

          // ── 无工具调用：尝试结束 ─────────────────────────────────────────
          if (calls.length === 0) {
            if (!outputSchema) {
              finishReason = stepFinish === "length" ? "max_steps" : "completed";
              break;
            }

            const parsed = parseOutput(stepText, outputSchema);
            if (parsed.ok) {
              output = parsed.value;
              finishReason = "completed";
              break;
            }

            // 结构化输出校验失败：把错误回喂模型，让它自我修复
            const repairAttempts = config.outputRepairAttempts ?? DEFAULT_OUTPUT_REPAIR_ATTEMPTS;
            const repairCount = repairAttemptsUsed.get(runId) ?? 0;
            if (repairCount >= repairAttempts) {
              failure = parsed.error;
              finishReason = "error";
              break;
            }
            repairAttemptsUsed.set(runId, repairCount + 1);
            messages.push(
              userMessage(
                `Your previous response did not match the required output schema:\n` +
                  `${parsed.error.message}\n\n` +
                  `Return only the corrected JSON object, with no extra prose.`,
              ),
            );
            yield { type: "error", error: parsed.error, recoverable: true };
            continue;
          }

          // ── 执行工具 ──────────────────────────────────────────────────────
          const finalCall = calls.find((call) => call.name === "final_answer");
          if (finalCall && outputSchema) {
            const parsed = outputSchema.safeParse(finalCall.args);
            if (parsed.success) {
              output = parsed.data;
              messages.push(
                ...calls.map((call) =>
                  toolResultMessage(call.id, call.name, JSON.stringify(call.args ?? {}), false),
                ),
              );
              finishReason = "completed";
              break;
            }
            // 参数不合法：回喂错误让它修正
            messages.push(assistantMessage(partsOf(stepMessage)));
            messages.push(
              toolResultMessage(
                finalCall.id,
                finalCall.name,
                `Invalid final_answer payload: ${parsed.error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; ")}`,
                true,
              ),
            );
            continue;
          }

          for (const call of calls) {
            config.hooks?.onToolCall?.({ runId, toolName: call.name, args: call.args, callId: call.id });
            yield { type: "tool_start", callId: call.id, name: call.name, args: call.args };
          }

          const toolStartedAt = Date.now();
          const results = await tools.executeMany(
            calls,
            {
              signal,
              agentName: config.name,
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            },
            config.toolConcurrency,
          );

          for (const result of results) {
            const durationMs = Date.now() - toolStartedAt;
            config.hooks?.onToolResult?.({
              runId,
              toolName: result.name,
              callId: result.id,
              output: result.output,
              isError: result.isError,
              durationMs,
            });
            yield {
              type: "tool_end",
              callId: result.id,
              name: result.name,
              output: result.output,
              isError: result.isError,
              durationMs,
            };
          }
          messages.push(
            ...results.map((result) =>
              toolResultMessage(result.id, result.name, result.output, result.isError),
            ),
          );

          config.hooks?.onStepEnd?.({ runId, step: steps, usage: stepUsage });
          yield { type: "step_end", step: steps };

          if (signal.aborted) {
            finishReason = isAbortError(signal.reason) ? "aborted" : "timeout";
            break;
          }
        }

        if (steps >= maxSteps && finishReason === "completed") {
          finishReason = "max_steps";
          failure = new MaxStepsExceededError(`Agent "${config.name}" exceeded ${maxSteps} steps`);
        }
      } catch (thrown) {
        const error = toError(thrown);
        failure = error;
        finishReason = isAbortError(error) ? "aborted" : "error";
        config.hooks?.onError?.({ runId, error, recoverable: false });
        yield { type: "error", error, recoverable: false };
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        repairAttemptsUsed.delete(runId);
      }

      const result: RunResult<O> = {
        runId,
        agentName: config.name,
        output,
        text: finalText,
        messages: [...messages],
        steps,
        usage: totalUsage,
        costUsd,
        finishReason,
        ...(failure ? { error: failure } : {}),
        durationMs: Date.now() - startedAt,
      };

      config.hooks?.onRunEnd?.({ runId, steps, usage: totalUsage, durationMs: result.durationMs });
      yield { type: "run_end", finishReason, result: result as RunResult<unknown> };
    });

  return {
    name: config.name,
    config,

    async run(options: RunOptions = {}): Promise<RunResult<O>> {
      let finalResult: RunResult<O> | undefined;
      for await (const event of stream(options)) {
        if (event.type === "run_end") {
          finalResult = event.result as RunResult<O>;
        }
      }
      if (!finalResult) {
        throw new AetherError("internal", "Agent run finished without a result");
      }
      return finalResult;
    },

    stream,
  };
}

/** 每次运行的结构化输出修复计数（用于实现 repair 次数上限）。 */
const repairAttemptsUsed = new Map<string, number>();

/**
 * 流式调用 + 重试。
 * 只有在**收到第一个事件之前**失败才会重试 —— 一旦已经开始向下游产出 token，
 * 重试会导致内容重复，因此直接把错误抛给调用方。
 */
async function* streamWithRetry(
  provider: ModelProvider,
  request: ModelRequest,
  retry: AgentConfig["retry"],
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (maxAttempts <= 1) {
    yield* provider.stream(request);
    return;
  }

  const acquired = await withRetry(
    async () => {
      const iterator = provider.stream(request)[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { iterator, first };
    },
    { maxAttempts, ...(retry?.initialDelayMs ? { initialDelayMs: retry.initialDelayMs } : {}) },
    signal,
  );

  if (!acquired.first.done) yield acquired.first.value;
  while (true) {
    const next = await acquired.iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

/** 从模型输出中稳健地提取并校验结构化结果（容忍 code fence 与前后废话）。 */
function parseOutput<O>(
  text: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: O; error?: { issues: readonly { path: readonly (string | number)[]; message: string }[] } } },
): { ok: true; value: O } | { ok: false; error: Error } {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      return { ok: true, value: parsed.data as O };
    }
  }
  const lastError = candidates.length > 0 ? "JSON did not match the required schema" : "No JSON found in the response";
  return { ok: false, error: new AetherError("validation", lastError, { retryable: true }) };
}

/** 提取文本中所有可能是 JSON 的片段（优先整体解析，其次 code fence，最后括号匹配）。 */
export function extractJsonCandidates(text: string): unknown[] {
  const trimmed = text.trim();
  const candidates: unknown[] = [];

  const tryParse = (value: string): void => {
    try {
      candidates.push(JSON.parse(value));
    } catch {
      /* ignore */
    }
  };

  tryParse(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fenced) {
    for (const block of fenced) {
      const inner = block.replace(/^```(?:json)?\s*/, "").replace(/```$/, "").trim();
      tryParse(inner);
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    tryParse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    tryParse(trimmed.slice(firstBracket, lastBracket + 1));
  }

  return candidates;
}

export type { AgentConfig, AgentEvent, RunOptions, RunResult, ContentPart, ToolCallPart, Message };
