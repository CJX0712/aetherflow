/**
 * Agent 层公共类型。
 */

import type { z } from "zod";

import type { Message, Usage } from "../models/types.js";
import type { AnyTool, ToolContext } from "../tools/tool.js";

export interface AgentHooks {
  readonly onRunStart?: (info: { runId: string; agentName: string; input: string }) => void;
  readonly onStepStart?: (info: { runId: string; step: number }) => void;
  readonly onStepEnd?: (info: { runId: string; step: number; usage: Usage }) => void;
  readonly onToolCall?: (info: {
    runId: string;
    toolName: string;
    args: unknown;
    callId: string;
  }) => void;
  readonly onToolResult?: (info: {
    runId: string;
    toolName: string;
    callId: string;
    output: string;
    isError: boolean;
    durationMs: number;
  }) => void;
  readonly onModelResponse?: (info: { runId: string; step: number; text: string }) => void;
  readonly onError?: (info: { runId: string; error: Error; recoverable: boolean }) => void;
  readonly onRunEnd?: (info: { runId: string; steps: number; usage: Usage; durationMs: number }) => void;
}

export interface ContextPolicy {
  /** 允许送入模型的最大上下文 token 数。 */
  readonly maxContextTokens: number;
  /** 为生成预留的 token 数。 */
  readonly reserveTokens?: number;
  /**
   * 超限时的处理策略：
   *  - `truncate`：保留 system 与最近若干轮，丢弃中间历史（默认，零额外成本）
   *  - `summarize`：调用模型把较早的历史压缩为摘要（更准确，但会产生额外调用）
   */
  readonly strategy?: "truncate" | "summarize";
  /** 使用 summarize 时的摘要生成模型，默认沿用主模型。 */
  readonly summarizerModel?: string;
}

export type OutputStrategy = "auto" | "native" | "tool";

export interface AgentConfig<O = unknown> {
  readonly name: string;
  /** 模型引用，形如 `"anthropic:claude-sonnet-4-20250514"`。 */
  readonly model: string;
  /** 系统指令；支持 `{{variable}}` 占位符，由 run 时的 context 注入。 */
  readonly instructions: string;
  readonly tools?: readonly AnyTool[];
  readonly description?: string;
  /** 自定义模型注册表；缺省时用内置默认注册表。 */
  readonly registry?: { resolve(ref: string): { provider: import("../models/types.js").ModelProvider; model: string } };
  readonly maxSteps?: number;
  /** 单次运行花费上限（美元），超出即中止。 */
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** 结构化输出 schema；提供后 result.output 即为已校验的对象。 */
  readonly output?: z.ZodType<O>;
  readonly outputStrategy?: OutputStrategy;
  /** 结构化输出解析失败后的修复尝试次数。 */
  readonly outputRepairAttempts?: number;
  readonly retry?: { readonly maxAttempts?: number; readonly initialDelayMs?: number };
  readonly context?: ContextPolicy;
  readonly hooks?: AgentHooks;
  /** 工具并发执行上限。 */
  readonly toolConcurrency?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export interface RunOptions {
  readonly input?: string | readonly Message[];
  /** 继续一段已有对话（用于多轮会话）。 */
  readonly messages?: readonly Message[];
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly sessionId?: string;
  /** 注入 instructions 模板的变量。 */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, string>>;
  /** 覆盖本次运行的最大步数。 */
  readonly maxSteps?: number;
}

export type RunFinishReason = "completed" | "max_steps" | "budget" | "timeout" | "aborted" | "error";

export interface RunResult<O = unknown> {
  readonly runId: string;
  readonly agentName: string;
  /** 结构化输出（仅当配置 output schema 时存在）。 */
  readonly output: O | undefined;
  /** 最后一轮模型的自然语言输出。 */
  readonly text: string;
  /** 完整对话历史，可直接用于继续会话。 */
  readonly messages: readonly Message[];
  readonly steps: number;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly finishReason: RunFinishReason;
  readonly error?: Error;
  readonly durationMs: number;
}

/** 运行期事件流：既是 UI 渲染的数据源，也是持久化与回放的数据源。 */
export type AgentEvent =
  | { readonly type: "run_start"; readonly runId: string; readonly agentName: string; readonly input: string }
  | { readonly type: "step_start"; readonly step: number }
  | { readonly type: "model_start"; readonly step: number; readonly model: string }
  | { readonly type: "reasoning_delta"; readonly delta: string }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "tool_start"; readonly callId: string; readonly name: string; readonly args: unknown }
  | {
      readonly type: "tool_end";
      readonly callId: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
      readonly durationMs: number;
    }
  | { readonly type: "usage"; readonly usage: Usage; readonly costUsd: number }
  | { readonly type: "model_end"; readonly step: number; readonly usage: Usage }
  | { readonly type: "step_end"; readonly step: number }
  | { readonly type: "context_compacted"; readonly removedMessages: number; readonly strategy: string }
  | { readonly type: "error"; readonly error: Error; readonly recoverable: boolean }
  | {
      readonly type: "run_end";
      readonly finishReason: RunFinishReason;
      readonly result: RunResult<unknown>;
    };

export type { ToolContext };
