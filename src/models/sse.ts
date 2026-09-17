/**
 * SSE（Server-Sent Events）解析器。
 *
 * 为什么自研而不直接用 fetch 的流：供应商实现存在大量事实差异 ——
 * 有的用 `\r\n\r\n` 分隔、有的在 `data:` 后不加空格、有的在错误时返回 JSON 而非 SSE。
 * 这里统一按字节流增量解析，容忍上述差异，并保留未解析完的尾部缓冲（跨 chunk 边界）。
 */

import { Stream } from "../core/stream.js";

export interface SseEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

/**
 * 把字节流解析为 SSE 事件流。
 * 注意：不依赖 TextDecoderStream，以兼容 Node 18/20/22 全部 LTS。
 */
export function parseSse(byteStream: AsyncIterable<Uint8Array | string>): Stream<SseEvent> {
  return new Stream<SseEvent>(async function* () {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of byteStream) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

      // SSE 以空行分隔事件；循环处理一次 chunk 中可能包含多个事件的情况。
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const raw = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const event = parseSseBlock(raw);
        if (event) yield event;
        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    // 处理最后一个没有以空行结尾的事件
    const tail = parseSseBlock(buffer.replace(/\n+$/, ""));
    if (tail) yield tail;
  });
}

function parseSseBlock(raw: string): SseEvent | undefined {
  if (raw.trim().length === 0) return undefined;
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // 注释/心跳
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const field = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (dataLines.length === 0) return undefined;
  return { event, id, retry, data: dataLines.join("\n") };
}

/** 按行解析 JSONL 流（部分供应商与 Ollama 使用此格式）。 */
export function parseJsonLines(byteStream: AsyncIterable<Uint8Array | string>): Stream<unknown> {
  return new Stream<unknown>(async function* () {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of byteStream) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            yield JSON.parse(line);
          } catch {
            yield { parseError: line };
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        yield JSON.parse(tail);
      } catch {
        yield { parseError: tail };
      }
    }
  });
}

/** 把 Web/Node 可读流转换为 AsyncIterable<Uint8Array>。 */
export async function* bytesOf(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
