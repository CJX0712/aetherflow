/**
 * OpenAI Chat Completions 适配器（含全生态兼容）。
 *
 * 之所以把「OpenAI 兼容」单独作为一个适配器：业界事实标准是 OpenAI 的
 * /chat/completions 协议 —— DeepSeek、Moonshot(Kimi)、通义千问、智谱、Groq、
 * xAI、OpenRouter、vLLM、Ollama、LM Studio 乃至各类网关都实现了它。
 * 一个适配器即可覆盖十余家供应商，这是「复用顶尖成果」的最高杠杆点。
 */

import { ModelError } from "../core/errors.js";
import { Stream } from "../core/stream.js";
import { requestJson, requestStream, type FetchLike } from "./http.js";
import { bytesOf, parseSse } from "./sse.js";
import {
  addUsage,
  emptyUsage,
  type AssistantMessage,
  type ContentPart,
  type FinishReason,
  type JsonSchema,
  type Message,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type Pricing,
  type ToolSpec,
  type Usage,
  partsOf,
} from "./types.js";

export interface OpenAICompatConfig {
  /** provider 标识，用于注册表与 trace。 */
  readonly id: string;
  readonly baseURL: string;
  /** 缺省 API Key 时读取的环境变量名。 */
  readonly apiKeyEnv?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly capabilities?: Partial<ModelCapabilities>;
  /** 该供应商是否需要在请求中显式指定 stream_options 才返回 usage。 */
  readonly supportsUsageInStream?: boolean;
  /** 是否支持在 stream 中返回 reasoning_content（深度思考）。 */
  readonly supportsReasoningInStream?: boolean;
}

export interface OpenAIProviderOptions {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly pricing?: Readonly<Record<string, Pricing>>;
  /** OpenAI 组织 / 项目头。 */
  readonly organization?: string;
  readonly project?: string;
  /** 不校验 API Key 是否存在（用于本地模型如 Ollama）。 */
  readonly allowMissingApiKey?: boolean;
}

/** OpenAI 兼容供应商预设。 */
export const OPENAI_COMPAT_PRESETS = {
  openai: {
    id: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    supportsUsageInStream: true,
  },
  deepseek: {
    id: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    supportsUsageInStream: true,
    supportsReasoningInStream: true,
  },
  moonshot: {
    id: "moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    supportsUsageInStream: true,
  },
  qwen: {
    id: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    supportsUsageInStream: true,
  },
  zhipu: {
    id: "zhipu",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    supportsUsageInStream: true,
  },
  groq: {
    id: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    supportsUsageInStream: true,
  },
  xai: {
    id: "xai",
    baseURL: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    supportsUsageInStream: true,
  },
  openrouter: {
    id: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    supportsUsageInStream: true,
  },
  together: {
    id: "together",
    baseURL: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    supportsUsageInStream: true,
  },
  ollama: {
    id: "ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    supportsUsageInStream: false,
  },
  vllm: {
    id: "vllm",
    baseURL: "http://127.0.0.1:8000/v1",
    supportsUsageInStream: true,
  },
} as const satisfies Record<string, OpenAICompatConfig>;

export type OpenAICompatPreset = keyof typeof OPENAI_COMPAT_PRESETS;

const BASE_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  reasoning: true,
  vision: true,
  promptCaching: false,
  jsonSchema: true,
};

export function createOpenAICompatProvider(
  config: OpenAICompatConfig,
  options: OpenAIProviderOptions = {},
): ModelProvider {
  const capabilities: ModelCapabilities = { ...BASE_CAPABILITIES, ...config.capabilities };
  const apiKey = options.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);

  const buildHeaders = (request: ModelRequest): Record<string, string> => {
    const headers: Record<string, string> = {
      ...(config.defaultHeaders ?? {}),
      ...(options.headers ?? {}),
      ...(request.headers ?? {}),
    };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    else if (config.id !== "ollama" && !options.allowMissingApiKey) {
      throw new ModelError(
        `Missing API key for provider "${config.id}". Set ${config.apiKeyEnv ?? "an apiKey"} or the corresponding environment variable.`,
        { code: "model_invalid_request", retryable: false },
      );
    }
    if (options.organization) headers["openai-organization"] = options.organization;
    if (options.project) headers["openai-project"] = options.project;
    return headers;
  };

  const buildBody = (request: ModelRequest, stream: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream,
    };
    if (stream && config.supportsUsageInStream !== false) {
      body["stream_options"] = { include_usage: true };
    }
    if (request.tools && request.tools.length > 0) {
      body["tools"] = request.tools.map(toOpenAITool);
      if (request.toolChoice) body["tool_choice"] = toOpenAIToolChoice(request.toolChoice);
      else body["tool_choice"] = "auto";
    }
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) {
      // 新一代推理模型（o1/o3/gpt-5 系列）使用 max_completion_tokens
      body["max_tokens"] = request.maxTokens;
    }
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.stopSequences?.length) body["stop"] = [...request.stopSequences];
    if (request.responseFormat) body["response_format"] = toOpenAIResponseFormat(request.responseFormat);
    if (request.providerOptions) Object.assign(body, request.providerOptions);
    return body;
  };

  const provider: ModelProvider = {
    id: config.id,
    capabilities,

    async generate(request: ModelRequest): Promise<ModelResponse> {
      const response = await requestJson<OpenAIChatResponse>(
        `${config.baseURL}/chat/completions`,
        {
          method: "POST",
          headers: buildHeaders(request),
          body: buildBody(request, false),
          signal: request.signal,
          timeoutMs: options.timeoutMs,
        },
        options.fetch,
      );
      return fromOpenAIResponse(response.body, request.model);
    },

    stream(request: ModelRequest): Stream<ModelStreamEvent> {
      const source = request;
      return new Stream<ModelStreamEvent>(async function* () {
        const response = await requestStream(
          `${config.baseURL}/chat/completions`,
          {
            method: "POST",
            headers: buildHeaders(source),
            body: buildBody(source, true),
            signal: source.signal,
            timeoutMs: options.timeoutMs,
          },
          options.fetch,
        );
        if (!response.body) {
          yield { type: "error", error: new ModelError("Empty response body from provider") };
          return;
        }

        yield { type: "stream_start", model: source.model };

        const parts: ContentPart[] = [];
        let textBuffer = "";
        let reasoningBuffer = "";
        let usage: Usage = emptyUsage;
        let finishReason: FinishReason = "stop";
        // index -> 累积中的工具调用
        const toolCalls = new Map<number, { id: string; name: string; args: string }>();

        const flushText = function* (): Generator<ModelStreamEvent> {
          if (textBuffer.length > 0) {
            parts.push({ type: "text", text: textBuffer });
            textBuffer = "";
          }
        };

        for await (const event of parseSse(bytesOf(response.body))) {
          if (event.data === "[DONE]") break;
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(event.data) as OpenAIStreamChunk;
          } catch {
            continue; // 心跳或非法 JSON，安全忽略
          }

          if (chunk.usage) {
            usage = fromOpenAIUsage(chunk.usage);
            yield { type: "usage", usage };
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;

          if (delta?.content) {
            textBuffer += delta.content;
            yield { type: "text_delta", delta: delta.content };
          }

          const reasoning = delta?.["reasoning_content"] ?? delta?.["reasoning"];
          if (typeof reasoning === "string" && reasoning.length > 0) {
            reasoningBuffer += reasoning;
            yield { type: "reasoning_delta", delta: reasoning };
          }

          if (delta?.tool_calls) {
            for (const call of delta.tool_calls) {
              const index = call.index ?? 0;
              const existing = toolCalls.get(index);
              if (!existing) {
                const id = call.id ?? `call_${index}_${Date.now()}`;
                toolCalls.set(index, { id, name: call.function?.name ?? "", args: call.function?.arguments ?? "" });
                yield { type: "tool_call_start", id, name: call.function?.name ?? "" };
              } else {
                if (call.id) existing.id = call.id;
                if (call.function?.name) existing.name = call.function?.name;
                if (call.function?.arguments) {
                  existing.args += call.function.arguments;
                  yield {
                    type: "tool_call_args_delta",
                    id: existing.id,
                    delta: call.function.arguments,
                  };
                }
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = mapFinishReason(choice.finish_reason);
          }
        }

        yield* flushText();
        if (reasoningBuffer.length > 0) {
          parts.unshift({ type: "reasoning", text: reasoningBuffer });
        }
        for (const call of toolCalls.values()) {
          const args = safeParseJson(call.args);
          parts.push({ type: "tool_call", id: call.id, name: call.name, args });
          yield { type: "tool_call_end", id: call.id, name: call.name, args };
        }

        if (usage.totalTokens === 0) {
          usage = addUsage(usage, emptyUsage);
        }

        yield {
          type: "finish",
          message: { role: "assistant", content: parts },
          finishReason,
          usage,
        };
      });
    },

    pricing: (model: string): Pricing | undefined => options.pricing?.[model],
  };

  return provider;
}

// ── 协议转换 ──────────────────────────────────────────────────────────────

type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; name?: string; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function toOpenAIMessages(messages: readonly Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const message of messages) {
    const parts = partsOf(message);
    switch (message.role) {
      case "system":
      case "user": {
        const text = parts
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("");
        result.push(
          message.name ? { role: message.role, content: text, name: message.name } : { role: message.role, content: text },
        );
        break;
      }
      case "assistant": {
        const content = parts
          .filter((p) => p.type === "text" || p.type === "reasoning")
          .map((p) => ("text" in p ? p.text : ""))
          .join("");
        const toolCalls = parts
          .filter((p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call")
          .map<OpenAIToolCall>((p) => ({
            id: p.id,
            type: "function",
            function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) },
          }));
        result.push({
          role: "assistant",
          content: content.length > 0 ? content : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "tool": {
        for (const part of parts) {
          if (part.type === "tool_result") {
            result.push({
              role: "tool",
              tool_call_id: part.id,
              content: part.output,
              ...(part.name ? { name: part.name } : {}),
            });
          }
        }
        break;
      }
    }
  }
  return result;
}

export function toOpenAITool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.parameters ?? { type: "object", properties: {} }) as JsonSchema,
      ...(tool.strict ? { strict: true } : {}),
    },
  };
}

export function toOpenAIToolChoice(choice: NonNullable<ModelRequest["toolChoice"]>): unknown {
  return typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
}

function toOpenAIResponseFormat(format: NonNullable<ModelRequest["responseFormat"]>): unknown {
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, strict: true },
    };
  }
  return { type: format.type };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

function fromOpenAIUsage(usage: OpenAIUsage | undefined): Usage {
  if (!usage) return emptyUsage;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
  };
}

function fromOpenAIResponse(response: OpenAIChatResponse, requestedModel: string): ModelResponse {
  const choice = response.choices?.[0];
  const parts: ContentPart[] = [];
  const reasoning = choice?.message?.reasoning_content;
  if (reasoning) parts.push({ type: "reasoning", text: reasoning });
  const content = choice?.message?.content;
  if (content) parts.push({ type: "text", text: content });
  for (const call of choice?.message?.tool_calls ?? []) {
    parts.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      args: safeParseJson(call.function.arguments),
    });
  }
  const message: AssistantMessage = { role: "assistant", content: parts };
  return {
    message,
    usage: fromOpenAIUsage(response.usage),
    finishReason: mapFinishReason(choice?.finish_reason),
    model: response.model ?? requestedModel,
    raw: response,
  };
}

export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

/** 模型返回的工具参数不一定是合法 JSON（常见截断），降级为原始字符串而非抛错。 */
export function safeParseJson(value: string | undefined): unknown {
  if (!value || value.trim().length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { __raw: value, __parseError: true };
  }
}
