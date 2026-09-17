/**
 * 录制与重放（Record / Replay）。
 *
 * 为什么这是刚需：Agent 的回归测试如果每次都真调 API，既慢又贵还不确定
 * （同一个 prompt 两次结果可能不同）。录制一次真实交互、之后离线重放，
 * 就能得到**确定性的、零成本的、可在 CI 里跑**的集成测试。
 *
 * 这也是「用自有算力做工程」的典型场景：把一次昂贵的线上调用固化成资产。
 */

import { Stream } from "../core/stream.js";
import type {
  AssistantMessage,
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  Usage,
} from "../models/types.js";
import { emptyUsage, partsOf } from "../models/types.js";

export interface RecordedInteraction {
  readonly model: string;
  /** 用于匹配请求的指纹（最后一条用户消息 + 模型）。 */
  readonly key: string;
  readonly request: {
    readonly model: string;
    readonly messages: unknown;
    readonly tools?: unknown;
  };
  readonly response: {
    readonly content: AssistantMessage["content"];
    readonly usage: Usage;
    readonly finishReason: FinishReason;
  };
}

export interface RecorderOptions {
  /** 是否同时保存请求内容（默认 true；关闭可显著减小体积）。 */
  readonly includeRequest?: boolean;
}

/** 包装任意 provider，记录其所有 generate 调用。 */
export class InteractionRecorder {
  readonly interactions: RecordedInteraction[] = [];
  private readonly options: RecorderOptions;

  constructor(options: RecorderOptions = {}) {
    this.options = options;
  }

  wrap(provider: ModelProvider): ModelProvider {
    const recorder = this;
    return {
      id: provider.id,
      capabilities: provider.capabilities,
      pricing: provider.pricing?.bind(provider),
      countTokens: provider.countTokens?.bind(provider),
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const response = await provider.generate(request);
        recorder.interactions.push({
          model: request.model,
          key: fingerprint(request),
          request: recorder.options.includeRequest === false
            ? { model: request.model, messages: [] }
            : { model: request.model, messages: request.messages, ...(request.tools ? { tools: request.tools } : {}) },
          response: {
            content: response.message.content,
            usage: response.usage,
            finishReason: response.finishReason,
          },
        });
        return response;
      },
      stream(request: ModelRequest): Stream<ModelStreamEvent> {
        // 流式调用在内部聚合后同样落盘，保证重放时能还原完整事件序列
        return new Stream<ModelStreamEvent>(async function* () {
          const response = await provider.generate(request);
          recorder.interactions.push({
            model: request.model,
            key: fingerprint(request),
            request: recorder.options.includeRequest === false
              ? { model: request.model, messages: [] }
              : { model: request.model, messages: request.messages, ...(request.tools ? { tools: request.tools } : {}) },
            response: {
              content: response.message.content,
              usage: response.usage,
              finishReason: response.finishReason,
            },
          });
          yield { type: "stream_start", model: request.model };
          for (const part of partsOf(response.message)) {
            if (part.type === "text") yield { type: "text_delta", delta: part.text };
            if (part.type === "reasoning") yield { type: "reasoning_delta", delta: part.text };
            if (part.type === "tool_call") {
              yield { type: "tool_call_start", id: part.id, name: part.name };
              yield { type: "tool_call_end", id: part.id, name: part.name, args: part.args };
            }
          }
          yield { type: "usage", usage: response.usage };
          yield {
            type: "finish",
            message: response.message,
            finishReason: response.finishReason,
            usage: response.usage,
          };
        });
      },
    };
  }

  save(): string {
    return JSON.stringify(this.interactions, null, 2);
  }

  static load(json: string): RecordedInteraction[] {
    return JSON.parse(json) as RecordedInteraction[];
  }
}

export interface ReplayOptions {
  /** 未匹配到录制时的行为：抛错（默认）或返回空响应。 */
  readonly onMissing?: "throw" | "empty";
}

/**
 * 重放 provider：按请求指纹返回录制好的响应。
 * 指纹 = 模型 + 最后一条消息内容 + 工具名集合，足以区分绝大多数回归场景。
 */
export function createReplayProvider(
  interactions: readonly RecordedInteraction[],
  options: ReplayOptions = {},
): ModelProvider {
  const remaining = [...interactions];
  const onMissing = options.onMissing ?? "throw";

  const find = (request: ModelRequest): RecordedInteraction | undefined => {
    const key = fingerprint(request);
    const exactIndex = remaining.findIndex((item) => item.key === key && item.model === request.model);
    if (exactIndex !== -1) return remaining.splice(exactIndex, 1)[0];
    const looseIndex = remaining.findIndex((item) => item.key === key);
    if (looseIndex !== -1) return remaining.splice(looseIndex, 1)[0];
    // 回退为顺序消费，兼容 request 结构微调的场景
    return remaining.shift();
  };

  const buildResponse = (request: ModelRequest): ModelResponse => {
    const found = find(request);
    if (!found) {
      if (onMissing === "throw") {
        throw new Error(`No recorded interaction for request: ${fingerprint(request).slice(0, 120)}`);
      }
      return {
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
        usage: emptyUsage,
        finishReason: "stop",
        model: request.model,
      };
    }
    return {
      message: { role: "assistant", content: found.response.content },
      usage: found.response.usage,
      finishReason: found.response.finishReason,
      model: request.model,
    };
  };

  return {
    id: "replay",
    capabilities: {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      reasoning: true,
      vision: false,
      promptCaching: false,
      jsonSchema: true,
    },
    generate: async (request: ModelRequest) => buildResponse(request),
    stream(request: ModelRequest): Stream<ModelStreamEvent> {
      return new Stream<ModelStreamEvent>(async function* () {
        const response = buildResponse(request);
        yield { type: "stream_start", model: request.model };
        for (const part of partsOf(response.message)) {
          if (part.type === "text") yield { type: "text_delta", delta: part.text };
          if (part.type === "reasoning") yield { type: "reasoning_delta", delta: part.text };
          if (part.type === "tool_call") {
            yield { type: "tool_call_start", id: part.id, name: part.name };
            yield { type: "tool_call_end", id: part.id, name: part.name, args: part.args };
          }
        }
        yield { type: "usage", usage: response.usage };
        yield {
          type: "finish",
          message: response.message,
          finishReason: response.finishReason,
          usage: response.usage,
        };
      });
    },
  };
}

/** 生成请求指纹：模型 + 最后一条消息 + 可用工具名。 */
export function fingerprint(request: ModelRequest): string {
  const lastMessage = request.messages[request.messages.length - 1];
  let lastText = "";
  if (lastMessage) {
    const content = lastMessage.content;
    if (typeof content === "string") lastText = content;
    else {
      lastText = content
        .map((part) => ("text" in part ? part.text : part.type === "tool_result" ? part.output : ""))
        .join("|");
    }
  }
  const toolNames = (request.tools ?? []).map((tool) => tool.name).join(",");
  return `${request.model}::${lastMessage?.role ?? "none"}::${lastText.slice(0, 200)}::[${toolNames}]`;
}
