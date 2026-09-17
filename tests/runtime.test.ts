import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/agent.js";
import { EventStore, persistRun } from "../src/memory/store.js";
import {
  InteractionRecorder,
  Tracer,
  collectMetrics,
  createReplayProvider,
  formatTrace,
} from "../src/observability/index.js";
import { formatEvalReport, runEvalSuite } from "../src/evals/eval.js";
import { createMockProvider } from "../src/models/mock.js";
import type { ModelProvider } from "../src/models/types.js";
import { defineTool } from "../src/tools/tool.js";

function registryOf(provider: ModelProvider) {
  return { resolve: (ref: string) => ({ provider, model: ref.split(":").slice(1).join(":") }) };
}

describe("event store", () => {
  it("appends and replays events in order", () => {
    const store = new EventStore();
    store.append("run-1", "run_start", { step: 0 });
    store.append("run-1", "step_start", { step: 1 });
    store.append("run-1", "step_end", { step: 1 });

    const events = store.events("run-1");
    expect(events.map((e) => e.type)).toEqual(["run_start", "step_start", "step_end"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("persists and reloads run results", () => {
    const store = new EventStore();
    const result = {
      runId: "run-2",
      agentName: "a",
      output: { answer: 42 },
      text: "42",
      messages: [],
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      costUsd: 0.001,
      finishReason: "completed" as const,
      durationMs: 10,
    };
    store.append("run-2", "run_start", { agentName: "a" });
    store.saveResult("run-2", result);

    const loaded = store.loadResult("run-2");
    expect(loaded?.output).toEqual({ answer: 42 });
    expect(loaded?.finishReason).toBe("completed");
    expect(store.record("run-2")?.agentName).toBe("a");
  });

  it("tracks unfinished runs for crash recovery", () => {
    const store = new EventStore();
    store.append("run-3", "run_start", { agentName: "a" });
    expect(store.listUnfinishedRuns()).toContain("run-3");

    store.saveResult("run-3", {
      runId: "run-3",
      agentName: "a",
      output: undefined,
      text: "",
      messages: [],
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      finishReason: "completed",
      durationMs: 1,
    });
    expect(store.listUnfinishedRuns()).not.toContain("run-3");
  });

  it("stores and restores multi-turn sessions", () => {
    const store = new EventStore();
    store.saveSession("s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const restored = store.loadSession("s1");
    expect(restored).toHaveLength(2);
    expect(restored[1]?.content).toBe("hello");
    store.deleteSession("s1");
    expect(store.loadSession("s1")).toHaveLength(0);
  });

  it("consumes an agent event stream and materializes the result", async () => {
    const provider = createMockProvider({ responses: [{ text: "persisted answer" }] });
    const agent = createAgent({
      name: "persisted",
      model: "mock:test",
      instructions: "Answer.",
      registry: registryOf(provider),
    });

    const store = new EventStore();
    const runId = "run-4";
    await persistRun(store, runId, agent.stream({ input: "q", runId }));

    expect(store.events(runId).length).toBeGreaterThan(2);
    expect(store.loadResult(runId)?.text).toBe("persisted answer");
  });
});

describe("tracing", () => {
  it("builds a parent-child span tree", () => {
    const tracer = new Tracer();
    const root = tracer.startSpan("agent.run", { attributes: { agent: "demo" } });
    const model = root.child("model.generate");
    model.setAttribute("tokens", 100);
    model.end("ok");
    const tool = root.child("tool.execute");
    tool.end("error", new Error("tool blew up"));
    root.end("ok");

    const tree = tracer.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("agent.run");
    expect(tree[0]?.children.map((c) => c.name).sort()).toEqual(["model.generate", "tool.execute"]);
    const failed = tree[0]?.children.find((c) => c.name === "tool.execute");
    expect(failed?.status).toBe("error");
    expect(failed?.error).toContain("tool blew up");
  });

  it("renders a readable trace", () => {
    const tracer = new Tracer();
    const root = tracer.startSpan("run");
    root.child("step").end("ok");
    root.end("ok");
    expect(formatTrace(tracer.tree())).toContain("run");
  });

  it("measures duration of wrapped operations", async () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("op");
    const value = await span.run(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return "done";
    });
    expect(value).toBe("done");
    expect(span.durationMs).toBeGreaterThanOrEqual(10);
  });
});

describe("metrics", () => {
  it("aggregates events into run metrics", async () => {
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "double", args: { n: 2 } }] },
        { text: "4" },
      ],
    });
    const double = defineTool({
      name: "double",
      description: "Doubles a number",
      inputSchema: z.object({ n: z.number() }),
      execute: ({ n }) => n * 2,
    });
    const agent = createAgent({
      name: "metrics",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [double],
      registry: registryOf(provider),
    });

    const events = await agent.stream({ input: "double 2" }).toArray();
    const metrics = collectMetrics(events);

    expect(metrics.steps).toBe(2);
    expect(metrics.modelCalls).toBe(2);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolErrors).toBe(0);
    expect(metrics.usage.totalTokens).toBeGreaterThan(0);
    expect(metrics.byTool["double"]?.calls).toBe(1);
  });
});

describe("record and replay", () => {
  it("replays recorded interactions deterministically", async () => {
    const source = createMockProvider({ responses: [{ text: "recorded answer" }] });
    const recorder = new InteractionRecorder();
    const wrapped = recorder.wrap(source);

    const agent = createAgent({
      name: "recorded",
      model: "mock:test",
      instructions: "Answer.",
      registry: registryOf(wrapped),
    });
    const first = await agent.run({ input: "what is the answer?" });
    expect(first.text).toBe("recorded answer");
    expect(recorder.interactions).toHaveLength(1);

    // 用录制数据重放：不再访问真实 provider
    const replay = createReplayProvider(InteractionRecorder.load(recorder.save()));
    const replayAgent = createAgent({
      name: "replayed",
      model: "mock:test",
      instructions: "Answer.",
      registry: registryOf(replay),
    });
    const second = await replayAgent.run({ input: "what is the answer?" });
    expect(second.text).toBe("recorded answer");
  });

  it("fails loudly when no recording matches", async () => {
    const replay = createReplayProvider([]);
    const agent = createAgent({
      name: "missing",
      model: "mock:test",
      instructions: "Answer.",
      registry: registryOf(replay),
    });
    const result = await agent.run({ input: "unknown" });
    expect(result.finishReason).toBe("error");
  });
});

describe("evals", () => {
  it("runs a suite and reports pass/fail", async () => {
    const provider = createMockProvider({
      fallback: (request) => {
        const last = request.messages[request.messages.length - 1];
        const text = typeof last?.content === "string" ? last.content : "";
        const match = text.match(/(\d+)\s*\+\s*(\d+)/);
        return { text: match ? String(Number(match[1]) + Number(match[2])) : "unknown" };
      },
    });
    const agent = createAgent({
      name: "calc",
      model: "mock:test",
      instructions: "Compute sums.",
      registry: registryOf(provider),
    });

    const report = await runEvalSuite({
      name: "arithmetic",
      agent,
      concurrency: 2,
      cases: [
        { name: "1+1", input: "What is 1 + 1?", contains: ["2"] },
        { name: "2+3", input: "What is 2 + 3?", contains: ["5"] },
        { name: "impossible", input: "What is the meaning of life?", contains: ["42"] },
      ],
    });

    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(formatEvalReport(report)).toContain("2/3 passed");
  });

  it("supports structured output comparison", async () => {
    const provider = createMockProvider({
      fallback: { text: '{"answer": 4}' },
    });
    const agent = createAgent({
      name: "structured",
      model: "mock:test",
      instructions: "Return JSON.",
      output: z.object({ answer: z.number() }),
      outputStrategy: "native",
      registry: registryOf(provider),
    });

    const report = await runEvalSuite({
      name: "structured",
      agent,
      cases: [{ name: "two plus two", input: "2+2", expected: { answer: 4 } }],
    });
    expect(report.passed).toBe(1);
  });
});
