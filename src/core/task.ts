/**
 * 结构化并发（Structured Concurrency）。
 *
 * 解决的问题：Agent编排中大量使用 Promise.all / Promise.race，一旦某个分支失败或
 * 提前返回，其余分支会变成「孤儿任务」继续消耗 token 与算力，且取消信号无法自动
 * 传播。TaskGroup 保证：**group 退出时，其所有子任务必然已结束或被取消** ——
 * 这与 Go 的 errgroup、Python 的 TaskGroup、Swift 的 withTaskGroup 同宗。
 */

import { AbortError, AetherError, isAbortError, toError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type TaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

export interface TaskOutcome<T = unknown> {
  readonly name: string;
  readonly status: TaskStatus;
  readonly result: Result<T, Error> | undefined;
}

export interface TaskGroupOptions {
  /** 首个任务失败时是否立即取消其余任务。默认 true。 */
  readonly failFast?: boolean;
  /** 外部中断信号（会与 group 内部信号合并）。 */
  readonly signal?: AbortSignal;
}

export class TaskGroup {
  private readonly controller = new AbortController();
  private readonly outcomes: TaskOutcome[] = [];
  private readonly pending: Promise<unknown>[] = [];
  private readonly failFast: boolean;
  private readonly external: AbortSignal | undefined;
  private failure: Error | undefined;
  private closed = false;

  constructor(options: TaskGroupOptions = {}) {
    this.failFast = options.failFast ?? true;
    this.external = options.signal;
    this.external?.addEventListener?.("abort", () => this.abort(), { once: true });
  }

  /** 传给子任务的信号，取消会向下传播。 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get hasFailed(): boolean {
    return this.failure !== undefined;
  }

  /** 是否启用「首个失败即取消其余」策略。 */
  get failFastEnabled(): boolean {
    return this.failFast;
  }

  /**
   * 在 group 内启动一个任务。返回的 Promise 永不 reject —— 失败以 Result 表达，
   * 由调用方决定是把失败回喂给模型、还是升级为终止。
   */
  spawn<T>(name: string, fn: (signal: AbortSignal) => Promise<T>): Promise<Result<T, Error>> {
    if (this.closed) {
      return Promise.resolve(err(new AetherError("internal", "TaskGroup is already closed")));
    }
    if (this.failure && this.failFast) {
      return Promise.resolve(
        err(new AbortError(`Sibling task failed: ${this.failure.message}`, { cause: this.failure })),
      );
    }

    const run = async (): Promise<Result<T, Error>> => {
      if (this.controller.signal.aborted) {
        return this.abortedResult<T>();
      }
      // outcome 需要在闭包内写，因此这里用可变结构，结束时再固化成只读结果
      const outcome: {
        name: string;
        status: TaskStatus;
        result: Result<T, Error> | undefined;
      } = { name, status: "running", result: undefined };
      try {
        const value = await fn(this.controller.signal);
        outcome.status = "success";
        outcome.result = ok(value);
        return outcome.result;
      } catch (thrown) {
        const error = toError(thrown);
        const aborted = isAbortError(error);
        outcome.status = aborted ? "cancelled" : "error";
        outcome.result = err(error);
        if (!aborted) {
          this.failure = this.failure ?? error;
          if (this.failFast) this.abort(error);
        }
        return err(error);
      } finally {
        this.outcomes.push(outcome as TaskOutcome);
      }
    };

    const promise = run();
    this.pending.push(promise);
    return promise;
  }

  /** 等待所有已 spawn 的任务结束（不取消它们）。 */
  async settle(): Promise<readonly TaskOutcome[]> {
    await Promise.allSettled(this.pending);
    return [...this.outcomes];
  }

  /** 取消所有仍在运行的任务，并等待它们真正退出。 */
  async dispose(): Promise<void> {
    this.abort();
    await Promise.allSettled(this.pending);
    this.closed = true;
  }

  abort(reason?: Error): void {
    this.failure = this.failure ?? reason;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  private abortedResult<T>(): Result<T, Error> {
    const cause = this.external?.reason ?? this.controller.signal.reason;
    return err(
      new AbortError(cause instanceof Error ? cause.message : "Task cancelled by group", {
        cause,
      }),
    );
  }
}

/**
 * 结构化作用域：进入时创建 group，退出时**保证**所有子任务已结束或被取消。
 * 这是使用 TaskGroup 的推荐方式，杜绝忘记 dispose 导致任务泄漏。
 */
export async function withTaskGroup<T>(
  fn: (group: TaskGroup) => Promise<T>,
  options: TaskGroupOptions = {},
): Promise<Result<{ value: T; outcomes: readonly TaskOutcome[] }, Error>> {
  const group = new TaskGroup(options);
  try {
    const value = await fn(group);
    const outcomes = await group.settle();
    return ok({ value, outcomes });
  } catch (thrown) {
    await group.dispose();
    return err(toError(thrown));
  } finally {
    if (!group.hasFailed) await group.dispose();
  }
}

export interface ConcurrencyOptions extends TaskGroupOptions {
  /** 最大并发度，默认无限制。 */
  readonly limit?: number;
}

/**
 * 带并发上限的映射。与 Promise.all 的区别：
 *  - 受 group 管控，失败/中断时已启动的任务会被取消
 *  - 可通过 limit 控制对上游 API 的压力（避免触发限流）
 */
export async function mapLimit<T, U>(
  items: readonly T[],
  limit: number | undefined,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<U>,
  options: ConcurrencyOptions = {},
): Promise<readonly Result<U, Error>[]> {
  const group = new TaskGroup(options);
  const results: Result<U, Error>[] = new Array(items.length);
  const maxConcurrent = limit && limit > 0 ? limit : items.length;

  const worker = async (cursor: { value: number }): Promise<void> => {
    while (true) {
      if (group.signal.aborted) return;
      const index = cursor.value++;
      if (index >= items.length) return;
      const result = await group.spawn(`item[${index}]`, (signal) =>
        fn(items[index] as T, index, signal),
      );
      results[index] = result;
      if (!result.ok && group.failFastEnabled) return;
    }
  };

  const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, () => worker);
  const cursor = { value: 0 };
  await Promise.all(workers.map((w) => w(cursor)));
  await group.settle();

  return results.map(
    (r, i) =>
      r ??
      err(
        new AbortError(`Item ${i} was never executed (group aborted)`, {
          details: { index: i },
        }),
      ),
  );
}

/** 给 Promise 套上超时；超时后原 Promise 仍会继续（无法真正取消），但结果被忽略。 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = `Operation timed out after ${timeoutMs}ms`,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new AetherError("timeout", message, { retryable: false }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 合并多个中断信号；Node 原生 AbortSignal.any 可用时直接复用。 */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return new AbortController().signal;
  if (defined.length === 1) return defined[0]!;
  return AbortSignal.any(defined);
}

/** 让出事件循环，避免长循环阻塞 I/O（例如大批量工具调用时的背压窗口）。 */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
