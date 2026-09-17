/**
 * Anthropic Messages API 适配器。
 *
 * 与 OpenAI 协议的关键差异（都在这里被抹平）：
 *  - system 是独立字段，不在 messages 数组里
 *  - max_tokens 是**必填**项
 *  - 工具结果以 `tool_result` 内容块的形式嵌在 user 消息中，而非独立的 tool 角色
 *  - 扩展思考（thinking）与 prompt caching 是原生能力，向上暴露为 reasoning / cache 用量
 */

import { ModelError } from "../core/errors.js";
import { Stream } from "../core/stream.js";
import { requestJson, requestStream, type FetchLike } from "./http.js";
import { bytesOf, parseSse } from "./sse.js";
import {
  emptyUsage,
  type ContentPart,
  type FinishReason,
  type Message,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type Pricing,
  type Usage,
  partsOf,
} from "./types.js";

export interface AnthropicProviderOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly version?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly pricing?: Readonly<Record<string, Pricing>>;
  /** 未显式指定 max_tokens 时使用的默认值（Anthropic 强制要求该字段）。 */
  readonly defaultMaxTokens?: number;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];

  const buildHeaders = (request: ModelRequest): Record<string, string> => {
    if (!apiKey) {
      throw new ModelError("Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey.", {
        code: "model_invalid_request",
        retryable: false,
      });
    }
    return {
      "x-api-key": apiKey,
      "anthropic-version": options.version ?? DEFAULT_VERSION,
      ...(options.headers ?? {}),
      ...(request.headers ?? {}),
    };
  };

  const buildBody = (request: ModelRequest, stream: boolean): Record<string, unknown> => {
    const { system, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      stream,
    };
    if (system.length > 0) body["system"] = system;
    if (request.tools && request.tools.length > 0) {
      body["tools"] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters ?? { type: "object", properties: {} },
      }));
      if (request.toolChoice) {
        body["tool_choice"] =
          request.toolChoice === "auto"
            ? { type: "auto" }
            : request.toolChoice === "none"
              ? { type: "none" }
              : request.toolChoice === "required"
                ? { type: "any" }
                : { type: "tool", name: request.toolChoice.name };
      }
    }
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.stopSequences?.length) body["stop_sequences"] = [...request.stopSequences];
    if (request.providerOptions) Object.assign(body, request.providerOptions);
    return body;
  };

  return {
    id: "anthropic",
    capabilities: {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      reasoning: true,
      vision: true,
      promptCaching: true,
      jsonSchema: false,
    },

    async generate(request: ModelRequest): Promise<ModelResponse> {
      const response = await requestJson<AnthropicResponse>(
        `${baseURL}/messages`,
        {
          method: "POST",
          headers: buildHeaders(request),
          body: buildBody(request, false),
          signal: request.signal,
          timeoutMs: options.timeoutMs,
        },
        options.fetch,
      );
      const body = response.body;
      const parts = toParts(body.content ?? []);
      return {
        message: { role: "assistant", content: parts },
        usage: fromAnthropicUsage(body.usage),
        finishReason: mapStopReason(body.stop_reason),
        model: body.model ?? request.model,
        raw: body,
      };
    },

    stream(request: ModelRequest): Stream<ModelStreamEvent> {
      return new Stream<ModelStreamEvent>(async function* () {
        const response = await requestStream(
          `${baseURL}/messages`,
          {
            method: "POST",
            headers: buildHeaders(request),
            body: buildBody(request, true),
            signal: request.signal,
            timeoutMs: options.timeoutMs,
          },
          options.fetch,
        );
        if (!response.body) {
          yield { type: "error", error: new ModelError("Empty response body from Anthropic") };
          return;
        }

        yield { type: "stream_start", model: request.model };

        const parts: ContentPart[] = [];
        let usage: Usage = emptyUsage;
        let stopReason: FinishReason = "stop";
        // 内容块索引 -> 累积状态
        const blocks = new Map<
          number,
          { type: "text" | "tool_use" | "thinking"; id: string; name: string; buffer: string; signature?: string }
        >();

        for await (const event of parseSse(bytesOf(response.body))) {
          let payload: AnthropicStreamEvent;
          try {
            payload = JSON.parse(event.data) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          switch (payload.type) {
            case "message_start": {
              usage = fromAnthropicUsage(payload.message?.usage);
              yield { type: "usage", usage };
              break;
            }
            case "content_block_start": {
              const block = payload.content_block;
              const index = payload.index ?? 0;
              if (block?.type === "tool_use") {
                blocks.set(index, { type: "tool_use", id: block.id ?? "", name: block.name ?? "", buffer: "" });
                yield { type: "tool_call_start", id: block.id ?? "", name: block.name ?? "" };
              } else if (block?.type === "thinking") {
                blocks.set(index, { type: "thinking", id: "", name: "", buffer: "" });
              } else {
                blocks.set(index, { type: "text", id: "", name: "", buffer: "" });
              }
              break;
            }
            case "content_block_delta": {
              const index = payload.index ?? 0;
              const delta = payload.delta;
              const block = blocks.get(index);
              if (!block) break;
              if (delta?.type === "text_delta" && delta.text) {
                block.buffer += delta.text;
                yield { type: "text_delta", delta: delta.text };
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                block.buffer += delta.thinking;
                yield { type: "reasoning_delta", delta: delta.thinking };
              } else if (delta?.type === "signature_delta" && delta.signature) {
                block.signature = delta.signature;
              } else if (delta?.type === "input_json_delta" && delta.partial_json) {
                block.buffer += delta.partial_json;
                yield {
                  type: "tool_call_args_delta",
                  id: block.id,
                  delta: delta.partial_json,
                };
              }
              break;
            }
            case "content_block_stop": {
              const index = payload.index ?? 0;
              const block = blocks.get(index);
              if (!block) break;
              if (block.type === "tool_use") {
                const args = safeParse(block.buffer);
                parts.push({ type: "tool_call", id: block.id, name: block.name, args });
                yield { type: "tool_call_end", id: block.id, name: block.name, args };
              } else if (block.type === "thinking") {
                parts.push({ type: "reasoning", text: block.buffer, ...(block.signature ? { signature: block.signature } : {}) });
              } else if (block.buffer.length > 0) {
                parts.push({ type: "text", text: block.buffer });
              }
              blocks.delete(index);
              break;
            }
            case "message_delta": {
              if (payload.usage) {
                usage = mergeAnthropicUsage(usage, payload.usage);
                yield { type: "usage", usage };
              }
              if (payload.delta?.stop_reason) stopReason = mapStopReason(payload.delta.stop_reason);
              break;
            }
            case "error": {
              yield {
                type: "error",
                error: new ModelError(payload.error?.message ?? "Anthropic stream error", {
                  code: "model_error",
                  retryable: false,
                }),
              };
              return;
            }
            default:
              break;
          }
        }

        yield { type: "finish", message: { role: "assistant", content: parts }, finishReason: stopReason, usage };
      });
    },

    pricing: (model: string): Pricing | undefined => options.pricing?.[model],
  };
}

// ── 协议转换 ──────────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  cache_control?: { type: string };
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

function fromAnthropicUsage(usage: AnthropicUsage | undefined): Usage {
  if (!usage) return emptyUsage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {}),
  };
}

/** message_delta 只带 output_tokens，需要与 message_start 的输入用量合并。 */
function mergeAnthropicUsage(base: Usage, delta: AnthropicUsage): Usage {
  return {
    inputTokens: base.inputTokens,
    outputTokens: delta.output_tokens ?? base.outputTokens,
    totalTokens: (delta.output_tokens ?? base.outputTokens) + base.inputTokens,
    ...(base.cacheReadTokens !== undefined ? { cacheReadTokens: base.cacheReadTokens } : {}),
    ...(base.cacheWriteTokens !== undefined ? { cacheWriteTokens: base.cacheWriteTokens } : {}),
  };
}

function toParts(blocks: readonly AnthropicContentBlock[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "thinking":
        parts.push({
          type: "reasoning",
          text: block.thinking ?? "",
          ...(block.signature ? { signature: block.signature } : {}),
        });
        break;
      case "text":
        if (block.text) parts.push({ type: "text", text: block.text });
        break;
      case "tool_use":
        parts.push({
          type: "tool_call",
          id: block.id ?? "",
          name: block.name ?? "",
          args: block.input ?? {},
        });
        break;
      default:
        break;
    }
  }
  return parts;
}

/**
 * 转换为 Anthropic 的 messages 数组。
 * 注意：Anthropic 不允许连续相同 role 的消息，工具结果也必须以 user 消息承载，
 * 因此这里会把相邻的同类消息合并，避免出现 API 拒绝。
 */
function toAnthropicMessages(messages: readonly Message[]): {
  system: Array<{ type: "text"; text: string }>;
  messages: Array<{ role: "user" | "assistant"; content: unknown[] }>;
} {
  const system: Array<{ type: "text"; text: string }> = [];
  const result: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  const push = (role: "user" | "assistant", content: unknown[]): void => {
    const last = result[result.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else result.push({ role, content: [...content] });
  };

  for (const message of messages) {
    const parts = partsOf(message);
    if (message.role === "system") {
      const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text) system.push({ type: "text", text });
      continue;
    }

    const content: unknown[] = [];
    for (const part of parts) {
      switch (part.type) {
        case "text":
          content.push({ type: "text", text: part.text });
          break;
        case "reasoning":
          content.push({
            type: "thinking",
            thinking: part.text,
            ...(part.signature ? { signature: part.signature } : {}),
          });
          break;
        case "tool_call":
          content.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.args ?? {},
          });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: part.id,
            content: part.output,
            ...(part.isError ? { is_error: true } : {}),
          });
          break;
        default:
          break;
      }
    }

    if (content.length === 0) continue;
    push(message.role === "assistant" ? "assistant" : "user", content);
  }

  return { system, messages: result };
}

export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

function safeParse(value: string): unknown {
  if (!value || value.trim().length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { __raw: value, __parseError: true };
  }
}
