import { describe, expect, it } from "vitest";

import {
  AbortError,
  AetherError,
  BudgetExceededError,
  ModelError,
  ToolError,
  isAbortError,
  toError,
} from "../src/core/errors.js";
import { attempt, attemptAsync, combine, err, isErr, isOk, map, ok, unwrapOr } from "../src/core/result.js";
import { CircuitBreaker, backoffDelay, defaultRetryPolicy, sleep, withRetry } from "../src/core/retry.js";
import { Stream } from "../src/core/stream.js";
import { TaskGroup, mapLimit, withTaskGroup, withTimeout } from "../src/core/task.js";

describe("Result", () => {
  it("wraps success and failure", () => {
    const success = ok(42);
    const failure = err(new Error("boom"));
    expect(isOk(success)).toBe(true);
    expect(isErr(failure)).toBe(true);
    expect(map(success, (v) => v + 1)).toEqual({ ok: true, value: 43 });
    expect(unwrapOr(failure, 0)).toBe(0);
  });

  it("combine returns all errors instead of short-circuiting", () => {
    const result = combine([ok(1), err("a"), err("b")]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual(["a", "b"]);
  });

  it("attempt converts thrown values", () => {
    expect(attempt(() => 1).ok).toBe(true);
    expect(attempt(() => { throw new Error("x"); }).ok).toBe(false);
  });

  it("attemptAsync never rejects", async () => {
    const result = await attemptAsync(Promise.reject(new Error("nope")));
    expect(result.ok).toBe(false);
  });
});

describe("errors", () => {
  it("marks retryability by code", () => {
    expect(new ModelError("rate limited", { code: "model_rate_limited" }).retryable).toBe(true);
    expect(new ModelError("bad request", { code: "model_invalid_request" }).retryable).toBe(false);
    expect(new ToolError("fs_read", "denied").retryable).toBe(false);
    expect(new BudgetExceededError().code).toBe("budget_exceeded");
  });

  it("detects abort errors across sources", () => {
    expect(isAbortError(new AbortError())).toBe(true);
    const domLike = new Error("The operation was aborted");
    domLike.name = "AbortError";
    expect(isAbortError(domLike)).toBe(true);
    expect(isAbortError(new Error("normal"))).toBe(false);
  });

  it("normalizes non-error throws", () => {
    expect(toError("string")).toBeInstanceOf(Error);
    expect(toError(new Error("e")).message).toBe("e");
    expect(toError(undefined)).toBeInstanceOf(Error);
  });

  it("serializes to JSON for persistence", () => {
    const json = new AetherError("internal", "oops", { details: { a: 1 } }).toJSON();
    expect(json["code"]).toBe("internal");
    expect(json["details"]).toEqual({ a: 1 });
  });
});

describe("Stream", () => {
  it("supports lazy transformations", async () => {
    const result = await Stream.of(1, 2, 3, 4, 5)
      .filter((n) => n % 2 === 1)
      .map((n) => n * 10)
      .toArray();
    expect(result).toEqual([10, 30, 50]);
  });

  it("take stops consumption early", async () => {
    const seen: number[] = [];
    const result = await Stream.of(1, 2, 3, 4)
      .tap((n) => {
        seen.push(n);
      })
      .take(2)
      .toArray();
    expect(result).toEqual([1, 2]);
    expect(seen).toEqual([1, 2]); // 证明是惰性的，没有多消费
  });

  it("tee duplicates a stream into independent branches", async () => {
    const branches = Stream.of(1, 2, 3).tee(2);
    const [left, right] = await Promise.all([branches[0]!.toArray(), branches[1]!.toArray()]);
    expect(left).toEqual([1, 2, 3]);
    expect(right).toEqual([1, 2, 3]);
  });

  it("tee tolerates branches consumed at different speeds", async () => {
    const branches = Stream.of(1, 2, 3, 4, 5).tee(2);
    const fastPromise = branches[0]!.toArray();
    const slowItems: number[] = [];
    for await (const item of branches[1]!) {
      slowItems.push(item);
      await sleep(1);
    }
    expect(await fastPromise).toEqual([1, 2, 3, 4, 5]);
    expect(slowItems).toEqual([1, 2, 3, 4, 5]);
  });

  it("channel allows pushing values imperatively", async () => {
    const channel = Stream.channel<number>();
    void channel.push(1);
    void channel.push(2);
    channel.close();
    expect(await channel.stream.toArray()).toEqual([1, 2]);
  });

  it("channel propagates failures", async () => {
    const channel = Stream.channel<number>();
    channel.fail(new Error("upstream died"));
    await expect(channel.stream.toArray()).rejects.toThrow("upstream died");
  });

  it("merge interleaves multiple sources", async () => {
    const merged = await Stream.merge([Stream.of(1, 2), Stream.of(10, 20)]).toArray();
    expect(merged.sort((a, b) => a - b)).toEqual([1, 2, 10, 20]);
  });

  it("withAbort stops iteration when aborted", async () => {
    const controller = new AbortController();
    const collected: number[] = [];
    const promise = (async () => {
      for await (const item of Stream.of(1, 2, 3).withAbort(controller.signal)) {
        collected.push(item);
        if (item === 1) controller.abort();
      }
    })();
    await expect(promise).rejects.toThrow();
    expect(collected).toEqual([1]);
  });

  it("buffer batches by time window", async () => {
    const batches = await Stream.of(1, 2, 3, 4, 5).buffer(5).toArray();
    expect(batches.flat()).toEqual([1, 2, 3, 4, 5]);
  });

  it("scan emits running state", async () => {
    expect(await Stream.of(1, 2, 3).scan(0, (acc, v) => acc + v).toArray()).toEqual([1, 3, 6]);
  });
});

describe("structured concurrency", () => {
  it("runs tasks and collects outcomes", async () => {
    const group = new TaskGroup();
    const a = group.spawn("a", async () => 1);
    const b = group.spawn("b", async () => 2);
    const outcomes = await group.settle();
    const ra = await a;
    const rb = await b;
    expect(ra.ok ? ra.value : null).toBe(1);
    expect(rb.ok ? rb.value : null).toBe(2);
    expect(outcomes.every((o) => o.status === "success")).toBe(true);
  });

  it("cancels siblings on failure when failFast is enabled", async () => {
    const group = new TaskGroup({ failFast: true });
    const slow = group.spawn("slow", (signal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 1_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new AbortError("cancelled by sibling failure"));
        });
      }),
    );
    const failing = group.spawn("failing", async () => {
      throw new Error("I failed");
    });

    expect((await failing).ok).toBe(false);
    const slowResult = await slow;
    expect(slowResult.ok).toBe(false);
    if (!slowResult.ok) expect(isAbortError(slowResult.error)).toBe(true);
  });

  it("dispose cancels everything still running", async () => {
    let cancelled = false;
    const group = new TaskGroup();
    void group.spawn("long", (signal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          cancelled = true;
          reject(new AbortError());
        });
      }),
    );
    await group.dispose();
    expect(cancelled).toBe(true);
  });

  it("mapLimit respects the concurrency ceiling", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      return inFlight;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("mapLimit returns one result per input in order", async () => {
    const results = await mapLimit([1, 2, 3], 3, async (n) => n * 2);
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([2, 4, 6]);
  });

  it("withTaskGroup guarantees cleanup", async () => {
    const result = await withTaskGroup(async (group) => {
      group.spawn("x", async () => 1);
      return "value";
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("value");
  });

  it("withTimeout rejects after the deadline", async () => {
    await expect(withTimeout(sleep(100), 10)).rejects.toThrow(/timed out/i);
  });
});

describe("retry", () => {
  it("retries until success", async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new ModelError("busy", { code: "model_rate_limited" });
        return "ok";
      },
      { maxAttempts: 5, initialDelayMs: 1 },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new ModelError("bad key", { code: "model_invalid_request" });
        },
        { maxAttempts: 5, initialDelayMs: 1 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("never retries aborts", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new AbortError("stop");
        },
        { maxAttempts: 5 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("jittered backoff stays within bounds", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = backoffDelay(defaultRetryPolicy, attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(defaultRetryPolicy.maxDelayMs);
    }
  });

  it("circuit breaker opens after repeated failures", async () => {
    const breaker = new CircuitBreaker(2, 1_000);
    const failing = async (): Promise<void> => {
      throw new Error("down");
    };
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.isOpen).toBe(true);
    await expect(breaker.execute(failing)).rejects.toThrow(/circuit breaker/i);
  });
});
