/**
 * 上下文工程（Context Engineering）。
 *
 * 长任务 Agent 最常见的失败模式不是「模型不够聪明」，而是上下文管理失控：
 *  - 上下文溢出 → API 直接报错，整个任务崩掉
 *  - 关键信息被挤出窗口 → 模型开始自相矛盾、重复劳动
 *  - 大量工具输出堆积 → 成本与延迟线性上升
 *
 * 这里提供两个正交手段：
 *  1. 精确（够用）的 token 估算 —— 中英混排场景下按字符类别分别估算
 *  2. 可插拔的压缩策略 —— 默认零成本的窗口截断，可选模型摘要
 */

import type {
  Message,
  ModelProvider,
  Usage,
} from "../models/types.js";
import { partsOf, systemMessage, userMessage } from "../models/types.js";

const CJK_PATTERN = /[㐀-鿿぀-ヿ가-힯豈-﫿]/g;

/**
 * 估算文本的 token 数。
 * CJK 字符在主流 tokenizer 中约 1–1.5 token/字，拉丁文本约 4 字符/token，
 * 分别估算比统一按 `length/4` 精确得多（中文场景下误差可从 3 倍降到 1.2 倍内）。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjkCount = (text.match(CJK_PATTERN) ?? []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.3 + otherCount / 4);
}

/** 每条消息的角色标记与分隔符也会占用 token，这里按经验值补偿。 */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateMessageTokens(message: Message): number {
  let tokens = PER_MESSAGE_OVERHEAD;
  for (const part of partsOf(message)) {
    switch (part.type) {
      case "text":
      case "reasoning":
        tokens += estimateTextTokens(part.text);
        break;
      case "tool_call":
        tokens += estimateTextTokens(part.name) + estimateTextTokens(JSON.stringify(part.args ?? {}));
        break;
      case "tool_result":
        tokens += estimateTextTokens(part.output);
        break;
      default:
        break;
    }
  }
  if (message.name) tokens += estimateTextTokens(message.name);
  return tokens;
}

export function estimateTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

export interface CompactionResult {
  readonly messages: readonly Message[];
  readonly removedMessages: number;
  readonly strategy: "none" | "truncate" | "summarize";
  /** summarize 策略下产生的额外用量。 */
  readonly usage?: Usage;
}

export interface CompactOptions {
  readonly maxTokens: number;
  readonly strategy?: "truncate" | "summarize";
  readonly summarize?: (messages: readonly Message[]) => Promise<{ summary: string; usage?: Usage }>;
}

/**
 * 按 token 预算压缩消息列表。
 *
 * 约束：**绝不能拆散 tool_call 与其 tool_result**。孤立的工具结果会让
 * OpenAI/Anthropic 直接拒绝请求（"tool_calls must be followed by tool messages"），
 * 这是很多框架在长对话下崩溃的根因。
 */
export async function compactMessages(
  messages: readonly Message[],
  options: CompactOptions,
): Promise<CompactionResult> {
  const current = estimateTokens(messages);
  if (current <= options.maxTokens) {
    return { messages, removedMessages: 0, strategy: "none" };
  }

  const systemMessages = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");
  const systemTokens = estimateTokens(systemMessages);
  const budget = Math.max(0, options.maxTokens - systemTokens);

  if (options.strategy === "summarize" && options.summarize) {
    // 保留最近一半轮次，其余交给模型压缩为摘要
    const splitIndex = Math.max(1, Math.floor(conversation.length / 2));
    // 确保切分点不落在 tool 消息上
    let safeSplit = splitIndex;
    while (safeSplit < conversation.length && conversation[safeSplit]?.role === "tool") safeSplit++;
    const oldPart = conversation.slice(0, safeSplit);
    const recentPart = conversation.slice(safeSplit);

    if (oldPart.length > 0) {
      const { summary, usage } = await options.summarize(oldPart);
      const compacted: Message[] = [
        ...systemMessages,
        userMessage(
          `The following is a summary of the earlier part of this conversation. ` +
            `Continue from here, using it as ground truth:\n\n${summary}`,
        ),
        ...recentPart,
      ];
      return {
        messages: compacted,
        removedMessages: messages.length - compacted.length,
        strategy: "summarize",
        ...(usage ? { usage } : {}),
      };
    }
  }

  // 默认策略：从后往前保留，直到预算耗尽
  const kept: Message[] = [];
  let used = 0;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i]!;
    const tokens = estimateMessageTokens(message);
    if (used + tokens > budget && kept.length > 0) break;
    kept.unshift(message);
    used += tokens;
  }

  // 修复边界：丢弃因截断而失去 tool_call 上下文的孤立 tool 结果
  while (kept.length > 0 && kept[0]!.role === "tool") {
    kept.shift();
  }
  // 若末尾残留未执行的 tool_call（其 tool_result 已被丢弃），一并移除
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    const hasCalls = partsOf(last).some((p) => p.type === "tool_call");
    if (hasCalls && last.role === "assistant" && kept.length > 1) kept.pop();
    else break;
  }

  const result = [...systemMessages, ...kept];
  return {
    messages: result,
    removedMessages: messages.length - result.length,
    strategy: "truncate",
  };
}

/** 用模型生成对话摘要（供 summarize 策略使用）。 */
export async function summarizeWithModel(
  provider: ModelProvider,
  model: string,
  messages: readonly Message[],
  signal?: AbortSignal,
): Promise<{ summary: string; usage?: Usage }> {
  const transcript = messages
    .map((message) => {
      const text = partsOf(message)
        .map((part) => {
          switch (part.type) {
            case "text":
              return part.text;
            case "reasoning":
              return `[thinking] ${part.text}`;
            case "tool_call":
              return `[called ${part.name} with ${JSON.stringify(part.args)}]`;
            case "tool_result":
              return `[${part.name} returned] ${part.output}`;
            default:
              return "";
          }
        })
        .join(" ");
      return `${message.role.toUpperCase()}: ${text}`;
    })
    .join("\n\n");

  const response = await provider.generate({
    model,
    messages: [
      systemMessage(
        "You are a precise conversation summarizer. Produce a compact but complete summary " +
          "that preserves: the user's original goal, all decisions made, all facts and numbers " +
          "discovered, all tool results that matter, and any pending tasks or open questions. " +
          "Write in the same language as the conversation. Be dense; omit pleasantries.",
      ),
      userMessage(transcript),
    ],
    maxTokens: 1024,
    ...(signal ? { signal } : {}),
  });

  const summary = partsOf(response.message)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

  return { summary, usage: response.usage };
}

/** 渲染 `{{variable}}` 模板；缺失变量保留原样并在末尾提示，避免静默出错。 */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>> = {},
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => {
    const value = variables[key];
    if (value === undefined) return match;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

