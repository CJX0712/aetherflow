/**
 * 统一模型协议。
 *
 * 这一层是整个运行时的「反腐蚀层」：无论底层是 OpenAI 的 Chat Completions、
 * Anthropic 的 Messages、还是 Google 的 Gemini，向上暴露的都是同一套类型。
 * 上层编排逻辑因此与供应商彻底解耦 —— 换模型只是改一个字符串。
 */

import type { Stream } from "../core/stream.js";

// ── 消息 ──────────────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  /** 部分供应商（如 Anthropic）返回加密签名，回传时需要原样带回。 */
  readonly signature?: string;
}

export interface ToolCallPart {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolResultPart {
  readonly type: "tool_result";
  readonly id: string;
  readonly name: string;
  readonly output: string;
  readonly isError: boolean;
}

export type ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

export interface Message {
  readonly role: Role;
  readonly content: string | readonly ContentPart[];
  /** 多智能体场景下标记发言者。 */
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface SystemMessage extends Message {
  readonly role: "system";
}

export interface AssistantMessage extends Message {
  readonly role: "assistant";
}

// ── 工具规格 ──────────────────────────────────────────────────────────────

export type JsonSchema = {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly default?: unknown;
  readonly [key: string]: unknown;
};

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** OpenAI strict mode / Anthropic 结构化工具：要求 JSON Schema 严格可校验。 */
  readonly strict?: boolean;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "tool"; readonly name: string };

// ── 用量与成本 ────────────────────────────────────────────────────────────

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** 命中 prompt cache 的输入 token（成本显著更低）。 */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  const inputTokens = a.inputTokens + b.inputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens:
      a.cacheReadTokens || b.cacheReadTokens
        ? (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
        : undefined,
    cacheWriteTokens:
      a.cacheWriteTokens || b.cacheWriteTokens
        ? (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
        : undefined,
    reasoningTokens:
      a.reasoningTokens || b.reasoningTokens
        ? (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
        : undefined,
  };
}

/** 每百万 token 单价（美元）。用于成本归因。 */
export interface Pricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

export interface CostBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly currency: "USD";
}

export function computeCost(usage: Usage, pricing: Pricing | undefined): CostBreakdown {
  if (!pricing) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, currency: "USD" };
  }
  const input = ((usage.inputTokens - (usage.cacheReadTokens ?? 0)) / 1_000_000) * pricing.inputPerMTok;
  const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok;
  const cacheRead =
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok);
  const cacheWrite =
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) *
    (pricing.cacheWritePerMTok ?? pricing.inputPerMTok);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    currency: "USD",
  };
}

// ── 请求 / 响应 ───────────────────────────────────────────────────────────

export type ResponseFormat =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | { readonly type: "json_schema"; readonly name: string; readonly schema: JsonSchema };

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly toolChoice?: ToolChoice;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly responseFormat?: ResponseFormat;
  /** 透传给供应商的额外字段（如 reasoning_effort、thinking budget）。 */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  /** 用于 trace 与计费归因的业务标记。 */
  readonly metadata?: Readonly<Record<string, string>>;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "aborted";

export interface ModelResponse {
  readonly message: AssistantMessage;
  readonly usage: Usage;
  readonly finishReason: FinishReason;
  /** 供应商实际使用的模型名（可能被网关重写）。 */
  readonly model: string;
  /** 原始响应体，用于调试与灰度对比。 */
  readonly raw?: unknown;
}

// ── 流式事件 ──────────────────────────────────────────────────────────────

export type ModelStreamEvent =
  | { readonly type: "stream_start"; readonly model: string }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "reasoning_delta"; readonly delta: string }
  | { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_args_delta"; readonly id: string; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "finish";
      readonly message: AssistantMessage;
      readonly finishReason: FinishReason;
      readonly usage: Usage;
    }
  | { readonly type: "error"; readonly error: Error };

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalls: boolean;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly promptCaching: boolean;
  readonly jsonSchema: boolean;
}

export const fullCapabilities: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  reasoning: true,
  vision: true,
  promptCaching: true,
  jsonSchema: true,
};

export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): Stream<ModelStreamEvent>;
  /** 估算 token 数；无精确实现时返回 undefined，由上层降级为字符数估算。 */
  countTokens?(request: Pick<ModelRequest, "messages" | "tools" | "model">): number | undefined;
  /** 返回该模型的价格，用于成本统计；未知返回 undefined。 */
  pricing?(model: string): Pricing | undefined;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────

export function partsOf(message: Message): readonly ContentPart[] {
  if (typeof message.content === "string") {
    return message.content.length > 0 ? [{ type: "text", text: message.content }] : [];
  }
  return message.content;
}

export function textOf(message: Message): string {
  return partsOf(message)
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function reasoningOf(message: Message): string {
  return partsOf(message)
    .filter((part): part is ReasoningPart => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

export function toolCallsOf(message: Message): readonly ToolCallPart[] {
  return partsOf(message).filter((part): part is ToolCallPart => part.type === "tool_call");
}

export function hasToolCalls(message: Message): boolean {
  return toolCallsOf(message).length > 0;
}

export const userMessage = (content: string, name?: string): Message =>
  name ? { role: "user", content, name } : { role: "user", content };

export const systemMessage = (content: string): SystemMessage => ({ role: "system", content });

export const assistantMessage = (
  content: string | readonly ContentPart[],
): AssistantMessage => ({ role: "assistant", content });

export const toolResultMessage = (
  id: string,
  name: string,
  output: string,
  isError = false,
): Message => ({
  role: "tool",
  content: [{ type: "tool_result", id, name, output, isError }],
});
