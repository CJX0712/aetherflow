/**
 * 脚本化 Mock Provider —— 整个测试体系与离线演示的基石。
 *
 * 设计目标：
 *  1. 不花一分钱、不联网，就能端到端跑通「多轮工具调用 + 上下文管理」的全部逻辑
 *  2. 支持「根据输入动态决策」的响应函数，可精确模拟真实模型的反应式行为
 *  3. 记录全部请求，让测试可以断言「模型到底看到了什么」（上下文压缩是否正确）
 *  4. 逐 token 吐出，真实还原流式语义（包括中断、错误注入）
 */

import { Stream } from "../core/stream.js";
import {
  emptyUsage,
  type AssistantMessage,
  type ContentPart,
  type FinishReason,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type Usage,
  toolCallsOf,
} from "./types.js";

export interface MockResponse {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly { readonly name: string; readonly args?: unknown; readonly id?: string }[];
  readonly finishReason?: FinishReason;
  readonly usage?: Partial<Usage>;
  /** 每个 token 之间的延迟，用于验证流式的时序行为。 */
  readonly tokenDelayMs?: number;
  /** 注入错误，用于测试重试与降级路径。 */
  readonly error?: Error;
  /** 返回前的整体延迟。 */
  readonly delayMs?: number;
}

export type MockResponder = MockResponse | ((request: ModelRequest, callIndex: number) => MockResponse | Promise<MockResponse>);

export interface MockProviderOptions {
  /** 响应序列；用完后回落到 fallback 或返回空响应。 */
  readonly responses?: readonly MockResponder[];
  /** 序列耗尽后的行为，默认返回空文本。 */
  readonly fallback?: MockResponder;
  /** 是否逐 token 流式吐出，默认 true。 */
  readonly streamTokens?: boolean;
}

export interface MockProvider extends ModelProvider {
  /** 所有收到的请求，按调用顺序。用于断言上下文构造是否正确。 */
  readonly calls: readonly ModelRequest[];
  /** 重置记录与游标。 */
  reset(): void;
  /** 最近一次请求。 */
  lastCall(): ModelRequest | undefined;
}

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const responders = [...(options.responses ?? [])];
  const calls: ModelRequest[] = [];
  let cursor = 0;

  const resolve = async (request: ModelRequest): Promise<MockResponse> => {
    const index = cursor++;
    const responder = responders[index] ?? options.fallback;
    if (responder === undefined) return { text: "" };
    return typeof responder === "function" ? await responder(request, index) : responder;
  };

  const toMessage = (response: MockResponse): AssistantMessage => {
    const parts: ContentPart[] = [];
    if (response.reasoning) parts.push({ type: "reasoning", text: response.reasoning });
    if (response.text) parts.push({ type: "text", text: response.text });
    (response.toolCalls ?? []).forEach((call, i) => {
      parts.push({
        type: "tool_call",
        id: call.id ?? `call_${i}_${calls.length}_${Math.random().toString(36).slice(2, 8)}`,
        name: call.name,
        args: call.args ?? {},
      });
    });
    return { role: "assistant", content: parts };
  };

  const toUsage = (response: MockResponse): Usage => ({
    ...emptyUsage,
    inputTokens: response.usage?.inputTokens ?? 10,
    outputTokens: response.usage?.outputTokens ?? (response.text?.length ?? 0),
    totalTokens:
      response.usage?.totalTokens ??
      (response.usage?.inputTokens ?? 10) + (response.usage?.outputTokens ?? (response.text?.length ?? 0)),
  });

  const provider: MockProvider = {
    id: "mock",
    capabilities: {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      reasoning: true,
      vision: true,
      promptCaching: true,
      jsonSchema: true,
    },
    calls,

    reset(): void {
      calls.length = 0;
      cursor = 0;
    },

    lastCall(): ModelRequest | undefined {
      return calls[calls.length - 1];
    },

    async generate(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      const response = await resolve(request);
      if (response.error) throw response.error;
      if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));
      const message = toMessage(response);
      return {
        message,
        usage: toUsage(response),
        finishReason:
          response.finishReason ?? (toolCallsOf(message).length > 0 ? "tool_calls" : "stop"),
        model: request.model,
      };
    },

    stream(request: ModelRequest): Stream<ModelStreamEvent> {
      calls.push(request);
      return new Stream<ModelStreamEvent>(async function* () {
        const response = await resolve(request);
        if (response.error) {
          yield { type: "error", error: response.error };
          return;
        }
        if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));

        yield { type: "stream_start", model: request.model };

        const parts: ContentPart[] = [];
        if (response.reasoning) {
          for (const token of tokenize(response.reasoning, options.streamTokens)) {
            yield { type: "reasoning_delta", delta: token };
          }
          parts.push({ type: "reasoning", text: response.reasoning });
        }
        if (response.text) {
          for (const token of tokenize(response.text, options.streamTokens)) {
            yield { type: "text_delta", delta: token };
          }
          parts.push({ type: "text", text: response.text });
        }
        for (const [i, call] of (response.toolCalls ?? []).entries()) {
          const id = call.id ?? `call_${i}_${Date.now()}`;
          yield { type: "tool_call_start", id, name: call.name };
          const argsJson = JSON.stringify(call.args ?? {});
          for (const chunk of chunkString(argsJson, 12)) {
            yield { type: "tool_call_args_delta", id, delta: chunk };
          }
          const args = call.args ?? {};
          parts.push({ type: "tool_call", id, name: call.name, args });
          yield { type: "tool_call_end", id, name: call.name, args };
        }

        const usage = toUsage(response);
        yield { type: "usage", usage };
        yield {
          type: "finish",
          message: { role: "assistant", content: parts },
          finishReason:
            response.finishReason ?? ((response.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop"),
          usage,
        };

        if (response.tokenDelayMs) {
          // tokenDelayMs 已在 tokenize 内部通过异步等待体现，这里无需额外处理
        }
      });
    },
  };

  return provider;
}

function tokenize(text: string, streamTokens = true): string[] {
  if (!streamTokens) return [text];
  // 按「词 + 空白」切分，模拟真实 tokenizer 的输出粒度
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
  return chunks;
}
