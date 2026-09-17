import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/models/mock.js";
import { createOpenAICompatProvider, OPENAI_COMPAT_PRESETS, toOpenAIMessages } from "../src/models/openai.js";
import { ModelRegistry, inferProvider } from "../src/models/registry.js";
import { lookupPricing } from "../src/models/pricing.js";
import { parseSse } from "../src/models/sse.js";
import { addUsage, computeCost, emptyUsage } from "../src/models/types.js";
import { Stream } from "../src/core/stream.js";

describe("SSE parsing", () => {
  it("parses multiple events in a single chunk", async () => {
    const raw = 'data: {"a":1}\n\ndata: {"a":2}\n\n';
    const events = await parseSse(Stream.of(raw)).toArray();
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("handles events split across chunk boundaries", async () => {
    const events = await parseSse(Stream.of('data: {"a":', "1}\n\n")).toArray();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ a: 1 });
  });

  it("supports named events and comments", async () => {
    const events = await parseSse(Stream.of(":heartbeat\n\nevent: ping\ndata: {}\n\n")).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("ping");
  });

  it("tolerates CRLF line endings", async () => {
    const events = await parseSse(Stream.of("data: hello\r\n\r\n")).toArray();
    expect(events[0]!.data).toBe("hello");
  });
});

describe("OpenAI protocol conversion", () => {
  it("converts tool calls and tool results", () => {
    const converted = toOpenAIMessages([
      { role: "system", content: "be nice" },
      { role: "user", content: "what's the weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_call", id: "call_1", name: "weather", args: { city: "Shenzhen" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", id: "call_1", name: "weather", output: "28°C sunny", isError: false }],
      },
    ]);

    expect(converted[0]).toEqual({ role: "system", content: "be nice" });
    expect(converted[2]).toMatchObject({
      role: "assistant",
      content: "let me check",
    });
    const toolCalls = (converted[2] as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
    expect(toolCalls?.[0]?.id).toBe("call_1");
    expect(JSON.parse(toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({ city: "Shenzhen" });
    expect(converted[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "28°C sunny" });
  });
});

describe("model registry", () => {
  it("infers providers from model names", () => {
    expect(inferProvider("gpt-4o")).toBe("openai");
    expect(inferProvider("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(inferProvider("deepseek-chat")).toBe("deepseek");
    expect(inferProvider("gemini-2.5-pro")).toBe("gemini");
    expect(inferProvider("qwen-max")).toBe("qwen");
  });

  it("resolves provider:model references", () => {
    const registry = new ModelRegistry();
    const mock = createMockProvider();
    registry.register("mock", mock);
    const resolved = registry.resolve("mock:test-model");
    expect(resolved.provider).toBe(mock);
    expect(resolved.model).toBe("test-model");
  });

  it("throws a helpful error for unknown providers", () => {
    const registry = new ModelRegistry();
    expect(() => registry.resolve("nope:gpt")).toThrow(/Unknown provider/);
  });
});

describe("pricing and usage", () => {
  it("accumulates usage across calls", () => {
    const total = addUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, emptyUsage);
    expect(total.inputTokens).toBe(10);
    expect(total.totalTokens).toBe(15);
  });

  it("computes cost with cache discount", () => {
    const pricing = lookupPricing("claude-sonnet-4-20250514");
    expect(pricing).toBeDefined();
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, cacheReadTokens: 500_000 },
      pricing,
    );
    // 50 万普通输入 + 50 万缓存输入 + 100 万输出
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.cacheRead).toBeLessThan(
      computeCost({ inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 }, pricing).input,
    );
  });

  it("returns zero cost for unknown models instead of throwing", () => {
    expect(computeCost({ inputTokens: 100, outputTokens: 100, totalTokens: 200 }, undefined).total).toBe(0);
  });
});

describe("mock provider", () => {
  it("emits streamed deltas that reassemble into the original text", async () => {
    const provider = createMockProvider({ responses: [{ text: "Hello AetherFlow" }] });
    let accumulated = "";
    for await (const event of provider.stream({ model: "mock", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "text_delta") accumulated += event.delta;
    }
    expect(accumulated).toBe("Hello AetherFlow");
  });

  it("records every request for later assertion", async () => {
    const provider = createMockProvider({ responses: [{ text: "ok" }] });
    await provider.generate({ model: "mock", messages: [{ role: "user", content: "first" }] });
    await provider.generate({ model: "mock", messages: [{ role: "user", content: "second" }] });
    expect(provider.calls).toHaveLength(2);
    expect(provider.lastCall()?.messages[0]?.content).toBe("second");
  });

  it("supports dynamic responders that inspect the request", async () => {
    const provider = createMockProvider({
      fallback: (request) => ({
        text: `echo: ${typeof request.messages[request.messages.length - 1]?.content === "string" ? request.messages[request.messages.length - 1]?.content : ""}`,
      }),
    });
    const response = await provider.generate({ model: "mock", messages: [{ role: "user", content: "ping" }] });
    expect(JSON.stringify(response.message)).toContain("echo: ping");
  });

  it("can inject errors to exercise failure paths", async () => {
    const provider = createMockProvider({ responses: [{ error: new Error("boom") }] });
    await expect(
      provider.generate({ model: "mock", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("boom");
  });
});

describe("OpenAI-compatible provider (offline)", () => {
  it("maps HTTP errors to semantic runtime errors", async () => {
    const provider = createOpenAICompatProvider(
      { ...OPENAI_COMPAT_PRESETS.openai, baseURL: "http://127.0.0.1:1/v1" },
      {
        apiKey: "test-key",
        fetch: (async () => {
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
      },
    );
    await expect(
      provider.generate({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/Network request failed/);
  });

  it("requires an API key unless explicitly allowed", async () => {
    await expect(
      createOpenAICompatProvider(
        { ...OPENAI_COMPAT_PRESETS.openai, baseURL: "http://localhost/v1" },
        {},
      ).generate({ model: "gpt-4o", messages: [] }),
    ).rejects.toThrow(/Missing API key/);
  });

  it("streams a scripted SSE response through the adapter", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ];
    const provider = createOpenAICompatProvider(
      { ...OPENAI_COMPAT_PRESETS.openai, baseURL: "http://localhost/v1" },
      {
        apiKey: "test-key",
        fetch: (async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )) as unknown as typeof fetch,
      },
    );

    let text = "";
    let usage = emptyUsage;
    for await (const event of provider.stream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "usage") usage = event.usage;
    }
    expect(text).toBe("Hello world");
    expect(usage.totalTokens).toBe(5);
  });
});

describe("Stream.merge with async sources", () => {
  it("drains all sources", async () => {
    const source = new Stream<number>(async function* () {
      yield 1;
      yield 2;
    });
    const merged = await Stream.merge([source, Stream.of(3)]).toArray();
    expect(merged.sort()).toEqual([1, 2, 3]);
  });
});
