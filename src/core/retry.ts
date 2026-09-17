/**
 * 重试与退避。
 *
 * 分布式调用外部 LLM API 时，限流（429）与瞬时网络抖动是常态。这里实现的是
 * 「带全抖动的指数退避」—— 相比固定间隔重试，它能把重试请求在时间轴上打散，
 * 避免多个并发 Agent 在同一时刻集体重试造成二次拥塞（即重试风暴）。
 */

import { AetherError, isAbortError, toError } from "./errors.js";

export interface RetryPolicy {
  /** 总尝试次数（含首次）。 */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
  /** 是否启用全抖动（AWS 推荐实践）。 */
  readonly jitter: boolean;
  /** 自定义重试判定；默认依据错误的 retryable 标记。 */
  readonly shouldRetry?: (error: Error, attempt: number) => boolean;
  readonly onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: Error;
  readonly willRetry: boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 20_000,
  backoffFactor: 2,
  jitter: true,
};

const defaultShouldRetry = (error: Error): boolean => {
  if (isAbortError(error)) return false;
  if (error instanceof AetherError) return error.retryable;
  return false;
};

/** 计算第 attempt 次（从 1 开始）重试前的等待时间。 */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.initialDelayMs * policy.backoffFactor ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return policy.jitter ? Math.random() * capped : capped;
}

export function resolveRetryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...defaultRetryPolicy, ...overrides };
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  signal?: AbortSignal,
): Promise<T> {
  const resolved = resolveRetryPolicy(policy);
  const shouldRetry = resolved.shouldRetry ?? defaultShouldRetry;
  let lastError: Error = new AetherError("internal", "Retry failed without an error");

  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt++) {
    if (signal?.aborted) throw new AetherError("aborted", "Aborted before attempt", {});
    try {
      return await operation(attempt);
    } catch (thrown) {
      lastError = toError(thrown);
      const isLast = attempt >= resolved.maxAttempts;
      const willRetry = !isLast && !isAbortError(lastError) && shouldRetry(lastError, attempt);
      const delayMs = willRetry ? backoffDelay(resolved, attempt) : 0;
      resolved.onRetry?.({ attempt, delayMs, error: lastError, willRetry });
      if (!willRetry) throw lastError;
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

/** 可被中断的 sleep。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AetherError("aborted", "Sleep aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AetherError("aborted", "Sleep aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 断路器：连续失败达到阈值后快速失败，给下游（通常是被限流的 API）恢复窗口。
 * Agent 长时间运行时，这能避免把预算浪费在注定失败的请求上。
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(threshold = 5, resetMs = 30_000) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  get isOpen(): boolean {
    if (this.openedAt === undefined) return false;
    if (Date.now() - this.openedAt >= this.resetMs) {
      this.openedAt = undefined;
      this.failures = 0;
      return false;
    }
    return true;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      throw new AetherError("model_rate_limited", "Circuit breaker is open", {
        retryable: false,
        details: { openFor: Date.now() - (this.openedAt ?? 0) },
      });
    }
    try {
      const value = await fn();
      this.failures = 0;
      return value;
    } catch (error) {
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = Date.now();
      throw error;
    }
  }
}
