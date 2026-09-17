/**
 * HTTP 传输层：统一超时、错误映射与响应解析。
 *
 * 抽离这一层的原因：所有供应商的错误语义各不相同，但「限流 / 鉴权失败 /
 * 上下文超长 / 服务端故障」这四类必须在运行时层被一致理解，否则重试与降级
 * 逻辑会散落各处且行为不一致。
 */

import { AetherError, ModelError } from "../core/errors.js";

export type FetchLike = typeof globalThis.fetch;

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  readonly text: string;
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new AetherError("internal", "No fetch implementation available (Node >= 18 required)");
}

/** 合并 AbortSignal 与超时控制。 */
function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AetherError("timeout", "Request timed out")), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function requestJson<T = Record<string, unknown>>(
  url: string,
  options: RequestOptions = {},
  fetchImpl?: FetchLike,
): Promise<HttpResponse<T>> {
  const fetchFn = resolveFetch(fetchImpl);
  const { signal, cleanup } = withTimeoutSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
  } catch (thrown) {
    cleanup();
    throw toNetworkError(thrown, signal);
  }
  cleanup();

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw mapHttpError(response.status, parsed, text);
  }

  return {
    status: response.status,
    headers: response.headers,
    body: parsed as T,
    text,
  };
}

/** 发起请求并返回原始响应流（用于 SSE）。 */
export async function requestStream(
  url: string,
  options: RequestOptions = {},
  fetchImpl?: FetchLike,
): Promise<Response> {
  const fetchFn = resolveFetch(fetchImpl);
  const { signal, cleanup } = withTimeoutSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
  } catch (thrown) {
    cleanup();
    throw toNetworkError(thrown, signal);
  }
  // 注意：流式场景下不能立即 cleanup，否则超时定时器会在流读取期间触发。
  if (!response.ok) {
    const text = await response.text();
    cleanup();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    throw mapHttpError(response.status, parsed, text);
  }
  return response;
}

function toNetworkError(thrown: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    return new AetherError("aborted", "Request aborted");
  }
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  return new ModelError(`Network request failed: ${error.message}`, {
    code: "network",
    cause: error,
    retryable: true,
  });
}

/** 把 HTTP 状态码 + 响应体映射为带语义的运行时错误。 */
export function mapHttpError(status: number, body: unknown, text?: string): ModelError {
  const message = extractErrorMessage(body) ?? text ?? `HTTP ${status}`;
  const record = isRecord(body) ? body : undefined;
  const errorType =
    typeof record?.["error"] === "object" && record["error"] !== null
      ? (record["error"] as Record<string, unknown>)["type"]
      : typeof record?.["type"] === "string"
        ? record["type"]
        : undefined;

  if (status === 429) {
    return new ModelError(`Rate limited: ${message}`, {
      code: "model_rate_limited",
      status,
      details: { errorType, retryAfter: parseRetryAfter(record) },
      retryable: true,
    });
  }
  if (status === 401 || status === 403) {
    return new ModelError(`Authentication failed: ${message}`, {
      code: "model_invalid_request",
      status,
      details: { errorType },
      retryable: false,
    });
  }
  if (status === 400 || status === 422) {
    const isContextLength =
      /context[_ ]length|maximum context|too many tokens|reduce the length/i.test(message);
    return new ModelError(message, {
      code: isContextLength ? "model_context_length" : "model_invalid_request",
      status,
      details: { errorType },
      retryable: false,
    });
  }
  if (status === 404) {
    return new ModelError(`Model or endpoint not found: ${message}`, {
      code: "model_invalid_request",
      status,
      retryable: false,
    });
  }
  if (status >= 500) {
    return new ModelError(`Provider server error (${status}): ${message}`, {
      code: "model_error",
      status,
      retryable: true,
    });
  }
  return new ModelError(`Request failed (${status}): ${message}`, {
    code: "model_error",
    status,
    retryable: status === 408 || status === 409,
  });
}

function parseRetryAfter(record: Record<string, unknown> | undefined): number | undefined {
  const headers = record?.["headers"];
  if (isRecord(headers)) {
    const value = headers["retry-after"];
    if (typeof value === "number") return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function extractErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    const message = error["message"];
    if (typeof message === "string") return message;
  }
  const message = body["message"];
  if (typeof message === "string") return message;
  const msg = body["msg"];
  if (typeof msg === "string") return msg;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
