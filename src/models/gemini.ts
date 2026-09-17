/**
 * Google Gemini 适配器（generateContent 协议）。
 *
 * 差异点：Gemini 把「系统指令」放在 systemInstruction、把角色简化为 user/model，
 * 工具结果用 functionResponse 承载，且流式通过 `alt=sse` 查询参数开启。
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

export interface GeminiProviderOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly pricing?: Readonly<Record<string, Pricing>>;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiProvider(options: GeminiProviderOptions = {}): ModelProvider {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;

  const resolveKey = (): string => {
    const apiKey = options.apiKey ?? process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
    if (!apiKey) {
      throw new ModelError("Missing Gemini API key. Set GEMINI_API_KEY or pass apiKey.", {
        code: "model_invalid_request",
        retryable: false,
      });
    }
    return apiKey;
  };

  const buildBody = (request: ModelRequest): Record<string, unknown> => {
    const systemText = request.messages
      .filter((m) => m.role === "system")
      .map((m) => partsOf(m).map((p) => (p.type === "text" ? p.text : "")).join(""))
      .join("\n");

    const body: Record<string, unknown> = {
      contents: toGeminiContents(request.messages.filter((m) => m.role !== "system")),
    };
    if (systemText) body["systemInstruction"] = { parts: [{ text: systemText }] };
    if (request.tools && request.tools.length > 0) {
      body["tools"] = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? { type: "object", properties: {} },
          })),
        },
      ];
      if (request.toolChoice && request.toolChoice !== "auto") {
        body["toolConfig"] = {
          functionCallingConfig:
            request.toolChoice === "none"
              ? { mode: "NONE" }
              : request.toolChoice === "required"
                ? { mode: "ANY" }
                : { mode: "ANY", allowedFunctionNames: [request.toolChoice.name] },
        };
      }
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) generationConfig["maxOutputTokens"] = request.maxTokens;
    if (request.topP !== undefined) generationConfig["topP"] = request.topP;
    if (request.stopSequences?.length) generationConfig["stopSequences"] = [...request.stopSequences];
    if (request.responseFormat?.type === "json_object") {
      generationConfig["responseMimeType"] = "application/json";
    } else if (request.responseFormat?.type === "json_schema") {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseSchema"] = request.responseFormat.schema;
    }
    if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;
    if (request.providerOptions) Object.assign(body, request.providerOptions);

    return body;
  };

  return {
    id: "gemini",
    capabilities: {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      reasoning: false,
      vision: true,
      promptCaching: true,
      jsonSchema: true,
    },

    async generate(request: ModelRequest): Promise<ModelResponse> {
      const url = `${baseURL}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(resolveKey())}`;
      const response = await requestJson<GeminiResponse>(
        url,
        {
          method: "POST",
          headers: { ...(options.headers ?? {}), ...(request.headers ?? {}) },
          body: buildBody(request),
          signal: request.signal,
          timeoutMs: options.timeoutMs,
        },
        options.fetch,
      );
      return fromGeminiResponse(response.body, request.model);
    },

    stream(request: ModelRequest): Stream<ModelStreamEvent> {
      return new Stream<ModelStreamEvent>(async function* () {
        const url = `${baseURL}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(resolveKey())}`;
        const response = await requestStream(
          url,
          {
            method: "POST",
            headers: { ...(options.headers ?? {}), ...(request.headers ?? {}) },
            body: buildBody(request),
            signal: request.signal,
            timeoutMs: options.timeoutMs,
          },
          options.fetch,
        );
        if (!response.body) {
          yield { type: "error", error: new ModelError("Empty response body from Gemini") };
          return;
        }

        yield { type: "stream_start", model: request.model };
        const parts: ContentPart[] = [];
        let usage = emptyUsage;
        let finishReason: FinishReason = "stop";
        let textBuffer = "";

        for await (const event of parseSse(bytesOf(response.body))) {
          let chunk: GeminiResponse;
          try {
            chunk = JSON.parse(event.data) as GeminiResponse;
          } catch {
            continue;
          }
          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (typeof part.text === "string" && part.text.length > 0) {
                textBuffer += part.text;
                yield { type: "text_delta", delta: part.text };
              }
              if (part.functionCall) {
                const id = `call_${parts.length}_${Date.now()}`;
                const args = part.functionCall.args ?? {};
                yield { type: "tool_call_start", id, name: part.functionCall.name ?? "" };
                parts.push({ type: "tool_call", id, name: part.functionCall.name ?? "", args });
                yield { type: "tool_call_end", id, name: part.functionCall.name ?? "", args };
              }
            }
          }
          if (chunk.usageMetadata) {
            usage = fromGeminiUsage(chunk.usageMetadata);
            yield { type: "usage", usage };
          }
          if (candidate?.finishReason) finishReason = mapGeminiFinish(candidate.finishReason);
        }

        if (textBuffer.length > 0) parts.unshift({ type: "text", text: textBuffer });
        yield { type: "finish", message: { role: "assistant", content: parts }, finishReason, usage };
      });
    },

    pricing: (model: string): Pricing | undefined => options.pricing?.[model],
  };
}

// ── 协议转换 ──────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: unknown };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

function toGeminiContents(messages: readonly Message[]): Array<{ role: string; parts: GeminiPart[] }> {
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    for (const part of partsOf(message)) {
      switch (part.type) {
        case "text":
          parts.push({ text: part.text });
          break;
        case "tool_call":
          parts.push({ functionCall: { name: part.name, args: (part.args ?? {}) as Record<string, unknown> } });
          break;
        case "tool_result":
          parts.push({ functionResponse: { name: part.name, response: { output: part.output } } });
          break;
        default:
          break;
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

function fromGeminiUsage(usage: GeminiResponse["usageMetadata"]): Usage {
  if (!usage) return emptyUsage;
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens,
    ...(usage.cachedContentTokenCount ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
    ...(usage.thoughtsTokenCount ? { reasoningTokens: usage.thoughtsTokenCount } : {}),
  };
}

function fromGeminiResponse(body: GeminiResponse, requestedModel: string): ModelResponse {
  const candidate = body.candidates?.[0];
  const parts: ContentPart[] = [];
  let text = "";
  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === "string") text += part.text;
    if (part.functionCall) {
      parts.push({
        type: "tool_call",
        id: `call_${parts.length}`,
        name: part.functionCall.name ?? "",
        args: part.functionCall.args ?? {},
      });
    }
  }
  if (text) parts.unshift({ type: "text", text });
  return {
    message: { role: "assistant", content: parts },
    usage: fromGeminiUsage(body.usageMetadata),
    finishReason: mapGeminiFinish(candidate?.finishReason),
    model: requestedModel,
    raw: body,
  };
}

function mapGeminiFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
}
