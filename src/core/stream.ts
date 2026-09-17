/**
 * Stream — 基于 AsyncIterable 的惰性流式管道。
 *
 * 选型理由：直接用 Web Streams / Node Stream 会引入运行时耦合与背压语义差异，
 * 而 AsyncIterable 是语言级协议 —— 任何 `for await` 都能消费，天然支持背压
 * （消费者不拉取，生产者就不推进），且可被 `for await` 之外的任何库适配。
 *
 * 关键特性：
 *  - 惰性：map/filter 只在被消费时执行，无中间数组
 *  - 可分支：tee(n) 让同一流同时喂给 UI 渲染与持久化，互不干扰
 *  - 可取消：withAbort 在中断时立即停止拉取并释放底层资源
 */

/** 由生产者主动推送的通道，用于把回调式 API（如 SSE、WebSocket）桥接成流。 */
export interface Channel<T> {
  readonly stream: Stream<T>;
  push(value: T): Promise<void>;
  close(): void;
  fail(error: Error): void;
}

export class Stream<T> implements AsyncIterable<T> {
  constructor(private readonly factory: () => AsyncIterator<T>) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.factory();
  }

  // ── 构造 ────────────────────────────────────────────────────────────────

  static of<U>(...items: readonly U[]): Stream<U> {
    return Stream.fromIterable(items);
  }

  static empty<U>(): Stream<U> {
    return Stream.of();
  }

  static fromIterable<U>(items: Iterable<U> | AsyncIterable<U>): Stream<U> {
    return new Stream<U>(async function* () {
      yield* items;
    });
  }

  /** 把事件发射器（如 EventEmitter、WebSocket）适配为流。 */
  static fromEmitter<U>(
    subscribe: (emit: (value: U) => void, fail: (error: Error) => void) => () => void,
  ): Stream<U> {
    return new Stream<U>(async function* () {
      const channel = createChannel<U>();
      const unsubscribe = subscribe(
        (value) => void channel.push(value),
        (error) => channel.fail(error),
      );
      try {
        yield* channel.stream;
      } finally {
        unsubscribe();
      }
    });
  }

  /** 创建一个可推送的流；`maxBuffer` 提供背压上限（0 表示不限制）。 */
  static channel<U>(maxBuffer = 0): Channel<U> {
    return createChannel<U>(maxBuffer);
  }

  // ── 转换 ────────────────────────────────────────────────────────────────

  map<U>(fn: (value: T, index: number) => U | Promise<U>): Stream<U> {
    const source = this;
    return new Stream<U>(async function* () {
      let index = 0;
      for await (const item of source) {
        yield await fn(item, index++);
      }
    });
  }

  filter(fn: (value: T, index: number) => boolean | Promise<boolean>): Stream<T> {
    const source = this;
    return new Stream<T>(async function* () {
      let index = 0;
      for await (const item of source) {
        if (await fn(item, index++)) yield item;
      }
    });
  }

  flatMap<U>(fn: (value: T) => Iterable<U> | AsyncIterable<U>): Stream<U> {
    const source = this;
    return new Stream<U>(async function* () {
      for await (const item of source) {
        yield* fn(item);
      }
    });
  }

  /** 副作用钩子，常用于日志 / trace，不改变流内容。 */
  tap(fn: (value: T) => void | Promise<void>): Stream<T> {
    return this.map(async (value) => {
      await fn(value);
      return value;
    });
  }

  take(count: number): Stream<T> {
    const source = this;
    return new Stream<T>(async function* () {
      if (count <= 0) return;
      let taken = 0;
      for await (const item of source) {
        yield item;
        if (++taken >= count) return;
      }
    });
  }

  takeWhile(fn: (value: T) => boolean): Stream<T> {
    const source = this;
    return new Stream<T>(async function* () {
      for await (const item of source) {
        if (!fn(item)) return;
        yield item;
      }
    });
  }

  skip(count: number): Stream<T> {
    const source = this;
    return new Stream<T>(async function* () {
      let skipped = 0;
      for await (const item of source) {
        if (skipped++ < count) continue;
        yield item;
      }
    });
  }

  /** 带累加器的扫描，逐项输出中间状态（用于 token 累计计数等）。 */
  scan<U>(seed: U, fn: (acc: U, value: T) => U | Promise<U>): Stream<U> {
    const source = this;
    return new Stream<U>(async function* () {
      let acc = seed;
      for await (const item of source) {
        acc = await fn(acc, item);
        yield acc;
      }
    });
  }

  /** 按时间窗口聚合成批，用于降低高频 token 事件带来的下游压力。 */
  buffer(windowMs: number): Stream<readonly T[]> {
    const source = this;
    return new Stream<readonly T[]>(async function* () {
      let batch: T[] = [];
      let deadline = Date.now() + windowMs;
      for await (const item of source) {
        batch.push(item);
        if (Date.now() >= deadline) {
          yield batch;
          batch = [];
          deadline = Date.now() + windowMs;
        }
      }
      if (batch.length > 0) yield batch;
    });
  }

  /** 按固定大小切块。 */
  chunk(size: number): Stream<readonly T[]> {
    const source = this;
    return new Stream<readonly T[]>(async function* () {
      let batch: T[] = [];
      for await (const item of source) {
        batch.push(item);
        if (batch.length >= size) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    });
  }

  // ── 分支与合并 ──────────────────────────────────────────────────────────

  /**
   * 把一条流复制为 n 条独立流。
   * 典型用途：一条 LLM 输出流同时驱动「UI 实时渲染」与「持久化写入」，
   * 二者消费速度不同，tee 通过为每个分支维护独立队列保证互不阻塞。
   */
  tee(count = 2): readonly Stream<T>[] {
    const source = this;
    const buffers: T[][] = Array.from({ length: count }, () => []);
    const resolvers: Array<((result: IteratorResult<T>) => void) | null> = Array.from(
      { length: count },
      () => null,
    );
    const dones = Array.from({ length: count }, () => false);
    let finished = false;
    let failure: Error | undefined;

    const iterator = source[Symbol.asyncIterator]();
    let pulling = false;

    const pump = async (): Promise<void> => {
      if (pulling || finished) return;
      // 只有当「所有存活分支都空了」时才向下游拉取，避免快分支把慢分支饿死。
      const needMore = buffers.some((buf, i) => !dones[i] && buf.length === 0 && resolvers[i]);
      if (!needMore) return;
      pulling = true;
      try {
        const result = await iterator.next();
        for (let i = 0; i < count; i++) {
          if (dones[i]) continue;
          const resolver = resolvers[i];
          if (resolver) {
            resolvers[i] = null;
            resolver(result);
          } else {
            buffers[i]!.push(result.value as T);
          }
        }
        if (result.done) finished = true;
      } catch (error) {
        finished = true;
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        pulling = false;
      }
    };

    const makeBranch = (index: number): Stream<T> =>
      new Stream<T>(async function* () {
        while (true) {
          const buffered = buffers[index]!.shift();
          if (buffered !== undefined) {
            yield buffered;
            continue;
          }
          if (failure) throw failure;
          if (finished) return;
          const next = await new Promise<IteratorResult<T>>((resolve) => {
            resolvers[index] = resolve;
            void pump();
          });
          if (next.done) return;
          yield next.value;
        }
      });

    return Array.from({ length: count }, (_, i) => {
      const branch = makeBranch(i);
      return new Stream<T>(async function* () {
        try {
          yield* branch;
        } finally {
          dones[i] = true;
        }
      });
    });
  }

  /** 合并多条流，任一出错即整体失败；按「先到先出」顺序输出。 */
  static merge<U>(streams: readonly AsyncIterable<U>[]): Stream<U> {
    return new Stream<U>(async function* () {
      const iterators = streams.map((s) => s[Symbol.asyncIterator]());
      const pending = new Map<number, Promise<{ index: number; result: IteratorResult<U> }>>();
      iterators.forEach((it, index) => {
        pending.set(
          index,
          it.next().then((result) => ({ index, result })),
        );
      });
      while (pending.size > 0) {
        const { index, result } = await Promise.race(pending.values());
        pending.delete(index);
        if (!result.done) {
          yield result.value;
          pending.set(
            index,
            iterators[index]!.next().then((r) => ({ index, r })).then(({ index: i, r }) => ({
              index: i,
              result: r,
            })),
          );
        }
      }
    });
  }

  // ── 终止 ────────────────────────────────────────────────────────────────

  reduce<U>(seed: U, fn: (acc: U, value: T) => U | Promise<U>): Promise<U> {
    return this.fold(seed, fn);
  }

  async fold<U>(seed: U, fn: (acc: U, value: T) => U | Promise<U>): Promise<U> {
    let acc = seed;
    for await (const item of this) {
      acc = await fn(acc, item);
    }
    return acc;
  }

  async toArray(): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) items.push(item);
    return items;
  }

  async first(): Promise<T | undefined> {
    for await (const item of this) return item;
    return undefined;
  }

  async forEach(fn: (value: T, index: number) => void | Promise<void>): Promise<void> {
    let index = 0;
    for await (const item of this) {
      await fn(item, index++);
    }
  }

  /** 丢弃流内容但确保被完整消费（用于触发副作用）。 */
  async drain(): Promise<void> {
    await this.toArray();
  }

  /** 绑定中断信号：信号触发后停止拉取并抛出 AbortError。 */
  withAbort(signal: AbortSignal | undefined): Stream<T> {
    if (!signal) return this;
    const source = this;
    return new Stream<T>(async function* () {
      const abortError = new Error("Operation aborted");
      abortError.name = "AbortError";
      for await (const item of source) {
        if (signal.aborted) throw abortError;
        yield item;
      }
    });
  }
}

function createChannel<T>(maxBuffer = 0): Channel<T> {
  const queue: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;
  let failure: Error | undefined;

  const stream = new Stream<T>(async function* () {
    while (true) {
      const item = queue.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (failure) throw failure;
      if (closed) return;
      yield* await new Promise<T[]>((resolve, reject) => {
        waiters.push({
          resolve: (result) => resolve(result.done ? [] : [result.value]),
          reject,
        });
      });
    }
  });

  return {
    stream,
    async push(value: T): Promise<void> {
      if (closed || failure) throw new Error("Channel is closed");
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }
      queue.push(value);
      // 背压：超过上限时等待队列被消费
      if (maxBuffer > 0) {
        while (queue.length >= maxBuffer) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      return Promise.resolve();
    },
    close(): void {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error: Error): void {
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()!.reject(error);
      }
    },
  };
}
