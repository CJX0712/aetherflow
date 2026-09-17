/**
 * 结构化错误体系。
 *
 * 设计原则：错误即数据。每个错误都携带机器可读的 `code` 与 `retryable` 标记，
 * 使上层编排器无需解析字符串即可决定是否重试、降级或终止。
 */

export type ErrorCode =
  | "aborted"
  | "timeout"
  | "budget_exceeded"
  | "max_steps_exceeded"
  | "model_error"
  | "model_rate_limited"
  | "model_invalid_request"
  | "model_context_length"
  | "tool_not_found"
  | "tool_execution"
  | "tool_denied"
  | "validation"
  | "network"
  | "internal";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "model_rate_limited",
  "network",
  "model_error",
]);

export interface AetherErrorOptions {
  /** 触发错误的原始异常 / 响应体，用于诊断链路。 */
  readonly cause?: unknown;
  /** 结构化附加信息，会随 trace 一起持久化。 */
  readonly details?: unknown;
  /** 显式覆盖该错误是否可重试。 */
  readonly retryable?: boolean;
}

export class AetherError extends Error {
  override readonly name: string = "AetherError";
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AetherErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }

  /** 序列化为可 JSON 化的结构，供事件日志 / trace 持久化使用。 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details ?? null,
    };
  }
}

export class AbortError extends AetherError {
  override readonly name: string = "AbortError";
  constructor(message = "Operation aborted", options: AetherErrorOptions = {}) {
    super("aborted", message, { retryable: false, ...options });
  }
}

export class TimeoutError extends AetherError {
  override readonly name: string = "TimeoutError";
  constructor(message = "Operation timed out", options: AetherErrorOptions = {}) {
    super("timeout", message, { retryable: false, ...options });
  }
}

export class BudgetExceededError extends AetherError {
  override readonly name: string = "BudgetExceededError";
  constructor(message = "Budget exceeded", options: AetherErrorOptions = {}) {
    super("budget_exceeded", message, { retryable: false, ...options });
  }
}

export class MaxStepsExceededError extends AetherError {
  override readonly name: string = "MaxStepsExceededError";
  constructor(message = "Maximum number of steps exceeded", options: AetherErrorOptions = {}) {
    super("max_steps_exceeded", message, { retryable: false, ...options });
  }
}

export class ModelError extends AetherError {
  override readonly name: string = "ModelError";
  readonly status?: number;
  constructor(
    message: string,
    options: AetherErrorOptions & { code?: ErrorCode; status?: number } = {},
  ) {
    super(options.code ?? "model_error", message, options);
    this.status = options.status;
  }
}

export class ToolError extends AetherError {
  override readonly name: string = "ToolError";
  readonly toolName: string;
  constructor(
    toolName: string,
    message: string,
    options: AetherErrorOptions & { code?: ErrorCode } = {},
  ) {
    super(options.code ?? "tool_execution", message, { retryable: false, ...options });
    this.toolName = toolName;
  }
}

export class ValidationError extends AetherError {
  override readonly name: string = "ValidationError";
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = [], options: AetherErrorOptions = {}) {
    super("validation", message, { retryable: false, ...options });
    this.issues = issues;
  }
}

/** 把任意抛出的值归一为 Error 实例，杜绝 `catch (e)` 拿到非 Error 的情况。 */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(`Non-error value thrown: ${JSON.stringify(value)}`);
  } catch {
    return new Error("Non-error value thrown: <unserializable>");
  }
}

/** 判断错误是否为「用户/系统主动中断」，这类错误不应计入失败重试。 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof AetherError) return error.code === "aborted";
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
}
