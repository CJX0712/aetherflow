/**
 * 可观测性：Trace 与指标。
 *
 * Agent 的调试难点在于「一个用户请求内部发生了几十次模型调用与工具调用」，
 * 靠日志几乎无法定位问题。这里提供的最小 trace 模型与 OpenTelemetry 语义一致
 * （span / 属性 / 事件 / 父子关系 / 状态），可以原样导出为 OTLP 或 JSON 供可视化。
 */

import { randomUUID } from "node:crypto";

import type { AgentEvent } from "../agent/types.js";
import type { Usage } from "../models/types.js";

export type SpanStatus = "running" | "ok" | "error" | "cancelled";

export interface SpanEventData {
  readonly name: string;
  readonly ts: number;
  readonly data?: unknown;
}

export interface SpanSnapshot {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly durationMs: number | undefined;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly SpanEventData[];
  readonly error: string | undefined;
  readonly children: readonly SpanSnapshot[];
}

export interface StartSpanOptions {
  readonly parentId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export class Span {
  private attributesStore: Record<string, unknown>;
  private eventList: SpanEventData[] = [];
  private endedAtValue: number | undefined;
  private statusValue: SpanStatus = "running";
  private errorValue: Error | undefined;

  constructor(
    private readonly tracer: Tracer,
    readonly id: string,
    readonly name: string,
    readonly parentId: string | undefined,
    readonly startedAt: number,
    attributes: Readonly<Record<string, unknown>> = {},
  ) {
    this.attributesStore = { ...attributes };
  }

  setAttribute(key: string, value: unknown): this {
    this.attributesStore[key] = value;
    return this;
  }

  setAttributes(values: Readonly<Record<string, unknown>>): this {
    Object.assign(this.attributesStore, values);
    return this;
  }

  addEvent(name: string, data?: unknown): this {
    this.eventList.push(data === undefined ? { name, ts: Date.now() } : { name, ts: Date.now(), data });
    return this;
  }

  end(status: SpanStatus = "ok", error?: Error): void {
    if (this.endedAtValue !== undefined) return;
    this.endedAtValue = Date.now();
    this.statusValue = status;
    this.errorValue = error;
    this.tracer.finishSpan(this.id);
  }

  /** 在当前 span 下开子 span，自动继承父子关系。 */
  child(name: string, options: Omit<StartSpanOptions, "parentId"> = {}): Span {
    return this.tracer.startSpan(name, { ...options, parentId: this.id });
  }

  /** 包裹一个异步函数，自动记录耗时与异常。 */
  async run<T>(fn: (span: Span) => Promise<T>): Promise<T> {
    try {
      const value = await fn(this);
      this.end("ok");
      return value;
    } catch (error) {
      this.end("error", error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  get durationMs(): number | undefined {
    return this.endedAtValue === undefined ? undefined : this.endedAtValue - this.startedAt;
  }

  snapshot(): SpanSnapshot {
    const children = this.tracer
      .allSpans()
      .filter((span) => span.parentId === this.id)
      .map((span) => span.snapshot());
    return {
      id: this.id,
      name: this.name,
      parentId: this.parentId,
      startedAt: this.startedAt,
      endedAt: this.endedAtValue,
      durationMs: this.durationMs,
      status: this.statusValue,
      attributes: { ...this.attributesStore },
      events: [...this.eventList],
      error: this.errorValue?.message,
      children,
    };
  }

  getAttributes(): Readonly<Record<string, unknown>> {
    return { ...this.attributesStore };
  }

  getEvents(): readonly SpanEventData[] {
    return [...this.eventList];
  }

  getStatus(): SpanStatus {
    return this.statusValue;
  }

  getError(): Error | undefined {
    return this.errorValue;
  }

  getEndedAt(): number | undefined {
    return this.endedAtValue;
  }
}

export class Tracer {
  private readonly spans = new Map<string, Span>();

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const span = new Span(
      this,
      randomUUID(),
      name,
      options.parentId,
      Date.now(),
      options.attributes ?? {},
    );
    this.spans.set(span.id, span);
    return span;
  }

  getSpan(id: string): Span | undefined {
    return this.spans.get(id);
  }

  allSpans(): readonly Span[] {
    return [...this.spans.values()];
  }

  /** 根 span（无父节点）的快照树。 */
  tree(): readonly SpanSnapshot[] {
    return this.allSpans()
      .filter((span) => span.parentId === undefined)
      .map((span) => span.snapshot());
  }

  toJSON(): { spans: readonly SpanSnapshot[]; generatedAt: string } {
    return { spans: this.tree(), generatedAt: new Date().toISOString() };
  }

  finishSpan(id: string): void {
    // 状态由 Span 自身维护，这里只作为回调点，便于未来接入外部导出器
    void id;
  }
}

// ── 运行指标 ──────────────────────────────────────────────────────────────

export interface ToolMetrics {
  readonly calls: number;
  readonly errors: number;
  readonly totalDurationMs: number;
}

export interface RunMetrics {
  readonly steps: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly byTool: Readonly<Record<string, ToolMetrics>>;
  readonly contextCompactions: number;
}

/**
 * 从 Agent 事件流聚合运行指标。
 * 事件流是唯一数据源 —— trace、指标、UI 渲染三者一致，不存在三份互相打架的数据。
 */
export function collectMetrics(events: readonly AgentEvent[]): RunMetrics {
  let steps = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let costUsd = 0;
  let contextCompactions = 0;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const byTool: Record<string, { calls: number; errors: number; totalDurationMs: number }> = {};

  for (const event of events) {
    switch (event.type) {
      case "step_start":
        steps++;
        break;
      case "model_end":
        modelCalls++;
        usage = {
          inputTokens: usage.inputTokens + event.usage.inputTokens,
          outputTokens: usage.outputTokens + event.usage.outputTokens,
          totalTokens: usage.totalTokens + event.usage.totalTokens,
        };
        break;
      case "usage":
        costUsd = Math.max(costUsd, event.costUsd);
        break;
      case "tool_start":
        toolCalls++;
        byTool[event.name] ??= { calls: 0, errors: 0, totalDurationMs: 0 };
        byTool[event.name]!.calls++;
        break;
      case "tool_end": {
        const entry = (byTool[event.name] ??= { calls: 0, errors: 0, totalDurationMs: 0 });
        entry.totalDurationMs += event.durationMs;
        if (event.isError) {
          toolErrors++;
          entry.errors++;
        }
        break;
      }
      case "context_compacted":
        contextCompactions++;
        break;
      default:
        break;
    }
  }

  return { steps, modelCalls, toolCalls, toolErrors, usage, costUsd, byTool, contextCompactions };
}

/** 把 trace 树渲染为可读文本，便于在终端/日志中快速定位瓶颈。 */
export function formatTrace(spans: readonly SpanSnapshot[], indent = 0): string {
  const lines: string[] = [];
  for (const span of spans) {
    const pad = "  ".repeat(indent);
    const duration = span.durationMs !== undefined ? `${span.durationMs}ms` : "…";
    const status = span.status === "ok" ? "✓" : span.status === "error" ? "✗" : "•";
    lines.push(`${pad}${status} ${span.name} (${duration})${span.error ? ` — ${span.error}` : ""}`);
    lines.push(...formatTrace(span.children, indent + 1).split("\n").filter(Boolean));
  }
  return lines.join("\n");
}
