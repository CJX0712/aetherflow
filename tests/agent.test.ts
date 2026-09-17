import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent/agent.js";
import { agentAsTool, runParallel } from "../src/agent/multi.js";
import { planAndExecute } from "../src/agent/plan.js";
import { createMockProvider, type MockProvider } from "../src/models/mock.js";
import type { ModelProvider } from "../src/models/types.js";
import { defineTool } from "../src/tools/tool.js";
import type { AgentEvent } from "../src/agent/types.js";

function registryOf(provider: ModelProvider) {
  return {
    resolve: (ref: string) => ({
      provider,
      model: ref.includes(":") ? (ref.split(":").slice(1).join(":")) : ref,
    }),
  };
}

const addTool = defineTool({
  name: "add",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => ({ sum: a + b }),
});

describe("agent basics", () => {
  it("answers directly when no tools are needed", async () => {
    const provider = createMockProvider({ responses: [{ text: "42" }] });
    const agent = createAgent({
      name: "math",
      model: "mock:test",
      instructions: "Answer concisely.",
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "What is the answer?" });
    expect(result.text).toBe("42");
    expect(result.finishReason).toBe("completed");
    expect(result.steps).toBe(1);
    expect(result.messages[0]?.role).toBe("system");
  });

  it("executes a tool and feeds the result back to the model", async () => {
    let calls = 0;
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "add", args: { a: 2, b: 3 } }] },
        { text: "The sum is 5" },
      ],
    });
    const countingAdd = defineTool({
      name: "add",
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => {
        calls++;
        return { sum: a + b };
      },
    });

    const agent = createAgent({
      name: "adder",
      model: "mock:test",
      instructions: "Use tools when helpful.",
      tools: [countingAdd],
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "What is 2 + 3?" });
    expect(calls).toBe(1);
    expect(result.text).toBe("The sum is 5");
    expect(result.steps).toBe(2);
    // 工具结果必须回喂给模型，否则模型无法基于结果作答
    const lastRequest = provider.lastCall();
    expect(JSON.stringify(lastRequest?.messages ?? [])).toContain("5");
  });

  it("executes multiple tool calls in parallel", async () => {
    const order: string[] = [];
    const provider = createMockProvider({
      responses: [
        {
          toolCalls: [
            { name: "slow", args: { key: "a" } },
            { name: "slow", args: { key: "b" } },
            { name: "slow", args: { key: "c" } },
          ],
        },
        { text: "done" },
      ],
    });
    const slowTool = defineTool({
      name: "slow",
      description: "Simulates latency",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(key);
        return { key };
      },
    });

    const agent = createAgent({
      name: "parallel",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [slowTool],
      registry: registryOf(provider),
    });

    const startedAt = Date.now();
    const result = await agent.run({ input: "go" });
    const elapsed = Date.now() - startedAt;

    expect(order.sort()).toEqual(["a", "b", "c"]);
    expect(result.steps).toBe(2);
    // 三个 20ms 的工具若串行需要 60ms+，并行应显著更快
    expect(elapsed).toBeLessThan(150);
  });

  it("surfaces unknown-tool errors to the model instead of crashing", async () => {
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "does_not_exist", args: {} }] },
        { text: "I used the wrong tool name; the answer is still 7" },
      ],
    });

    const agent = createAgent({
      name: "resilient",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [addTool],
      registry: registryOf(provider),
    });

    const events = await agent.stream({ input: "compute" }).toArray();
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd?.type === "tool_end" && toolEnd.isError).toBe(true);
    expect(toolEnd?.type === "tool_end" && toolEnd.output).toContain("does not exist");

    const finalEvent = events[events.length - 1];
    expect(finalEvent?.type === "run_end" && finalEvent.result.text).toContain("7");
    expect(finalEvent?.type === "run_end" && finalEvent.result.error).toBeUndefined();
  });

  it("reports invalid tool arguments as recoverable errors", async () => {
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "add", args: { a: "not-a-number", b: 1 } }] },
        { text: "corrected" },
      ],
    });
    const agent = createAgent({
      name: "validator",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [addTool],
      registry: registryOf(provider),
    });

    const events = await agent.stream({ input: "add" }).toArray();
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd?.type === "tool_end" && toolEnd.isError).toBe(true);
    expect(toolEnd?.type === "tool_end" && toolEnd.output).toContain("Invalid arguments");
  });
});

describe("guardrails", () => {
  it("stops at maxSteps when the model keeps calling tools", async () => {
    const provider = createMockProvider({
      fallback: { toolCalls: [{ name: "add", args: { a: 1, b: 1 } }] },
    });
    const agent = createAgent({
      name: "loopy",
      model: "mock:test",
      instructions: "Keep going.",
      tools: [addTool],
      maxSteps: 3,
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "loop forever" });
    expect(result.steps).toBe(3);
    expect(result.finishReason).toBe("max_steps");
    expect(result.error).toBeDefined();
  });

  it("honours an external abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createMockProvider({ fallback: { text: "never" } });
    const agent = createAgent({
      name: "aborted",
      model: "mock:test",
      instructions: "Do work.",
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "hello", signal: controller.signal });
    expect(result.finishReason).toBe("aborted");
    expect(result.steps).toBe(0);
  });

  it("stops when the token budget is exhausted", async () => {
    const provider = createMockProvider({
      fallback: { toolCalls: [{ name: "add", args: { a: 1, b: 1 } }] },
    });
    const agent = createAgent({
      name: "budgeted",
      model: "mock:test",
      instructions: "Answer.",
      tools: [addTool],
      maxTokens: 5,
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "hello" });
    expect(result.finishReason).toBe("budget");
  });

  it("enforces a wall-clock timeout", async () => {
    const provider = createMockProvider({
      fallback: { text: "thinking", delayMs: 60, toolCalls: [{ name: "add", args: { a: 1, b: 1 } }] },
    });
    const agent = createAgent({
      name: "slow",
      model: "mock:test",
      instructions: "Answer.",
      tools: [addTool],
      timeoutMs: 20,
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "hello" });
    expect(result.finishReason).toBe("timeout");
  });
});

describe("structured output", () => {
  const schema = z.object({ city: z.string(), temperature: z.number() });

  it("accepts output submitted through the final_answer tool", async () => {
    const provider = createMockProvider({
      responses: [{ toolCalls: [{ name: "final_answer", args: { city: "Shenzhen", temperature: 28 } }] }],
    });
    const agent = createAgent({
      name: "weather",
      model: "mock:test",
      instructions: "Report the weather.",
      output: schema,
      outputStrategy: "tool",
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "weather in Shenzhen?" });
    expect(result.output).toEqual({ city: "Shenzhen", temperature: 28 });
    expect(result.finishReason).toBe("completed");
  });

  it("parses JSON text when native schema mode is used", async () => {
    const provider = createMockProvider({
      responses: [{ text: '{"city":"Beijing","temperature":21}' }],
    });
    const agent = createAgent({
      name: "weather-native",
      model: "mock:test",
      instructions: "Report the weather as JSON.",
      output: schema,
      outputStrategy: "native",
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "weather in Beijing?" });
    expect(result.output).toEqual({ city: "Beijing", temperature: 21 });
  });

  it("extracts JSON wrapped in markdown fences", async () => {
    const provider = createMockProvider({
      responses: [{ text: 'Here you go:\n```json\n{"city":"Shanghai","temperature":25}\n```' }],
    });
    const agent = createAgent({
      name: "fenced",
      model: "mock:test",
      instructions: "Return JSON.",
      output: schema,
      outputStrategy: "native",
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "weather?" });
    expect(result.output).toEqual({ city: "Shanghai", temperature: 25 });
  });

  it("asks the model to repair malformed output", async () => {
    const provider: MockProvider = createMockProvider({
      responses: [
        { text: "not json at all" },
        { text: '{"city":"Hangzhou","temperature":19}' },
      ],
    });
    const agent = createAgent({
      name: "repairing",
      model: "mock:test",
      instructions: "Return JSON.",
      output: schema,
      outputStrategy: "native",
      outputRepairAttempts: 2,
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "weather?" });
    expect(result.output).toEqual({ city: "Hangzhou", temperature: 19 });
    expect(provider.calls.length).toBeGreaterThan(1);
  });
});

describe("event stream", () => {
  it("emits a well-ordered event sequence", async () => {
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "add", args: { a: 1, b: 2 } }] },
        { text: "3" },
      ],
    });
    const agent = createAgent({
      name: "events",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [addTool],
      registry: registryOf(provider),
    });

    const events = (await agent.stream({ input: "1+2" }).toArray()) as AgentEvent[];
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("run_start");
    expect(types[types.length - 1]).toBe("run_end");
    expect(types.indexOf("step_start")).toBeLessThan(types.indexOf("model_end"));
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("usage");

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
  });

  it("accumulates usage and cost across steps", async () => {
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "add", args: { a: 1, b: 2 } }] },
        { text: "done" },
      ],
    });
    const agent = createAgent({
      name: "costed",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [addTool],
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "go" });
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("context management", () => {
  it("compacts history when the budget is exceeded", async () => {
    const longText = "x".repeat(4_000);
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "add", args: { a: 1, b: 1 } }] },
        { text: longText, toolCalls: [{ name: "add", args: { a: 2, b: 2 } }] },
        { text: "final" },
      ],
    });
    const agent = createAgent({
      name: "compact",
      model: "mock:test",
      instructions: "Talk a lot.",
      tools: [addTool],
      context: { maxContextTokens: 800, strategy: "truncate", reserveTokens: 0 },
      registry: registryOf(provider),
    });

    const events = await agent.stream({ input: "start" }).toArray();
    const compacted = events.filter((e) => e.type === "context_compacted");
    expect(compacted.length).toBeGreaterThan(0);
  });

  it("never leaves an orphaned tool result after truncation", async () => {
    const provider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "add", args: { a: 1, b: 2 } }] },
        { text: "y".repeat(4_000) },
        { text: "final answer" },
      ],
    });
    const agent = createAgent({
      name: "orphan-check",
      model: "mock:test",
      instructions: "Use tools.",
      tools: [addTool],
      context: { maxContextTokens: 600, strategy: "truncate", reserveTokens: 0 },
      registry: registryOf(provider),
    });

    const result = await agent.run({ input: "go" });
    const lastRequest = provider.lastCall();
    // 不允许出现「首条即为孤立 tool 结果」的非法请求
    const messages = lastRequest?.messages ?? [];
    const firstNonSystem = messages.find((m) => m.role !== "system");
    expect(firstNonSystem?.role).not.toBe("tool");
    expect(result.finishReason).toBe("completed");
  });
});

describe("multi-agent", () => {
  it("delegates to a sub-agent through a tool", async () => {
    const expertProvider = createMockProvider({ responses: [{ text: "Shenzhen, 28°C" }] });
    const expert = createAgent({
      name: "weather-expert",
      model: "mock:test",
      instructions: "You know the weather.",
      registry: registryOf(expertProvider),
    });

    const mainProvider = createMockProvider({
      responses: [
        { toolCalls: [{ name: "ask_weather-expert", args: { task: "weather in Shenzhen?" } }] },
        { text: "It is 28°C in Shenzhen" },
      ],
    });
    const main = createAgent({
      name: "coordinator",
      model: "mock:test",
      instructions: "Delegate weather questions.",
      tools: [agentAsTool(expert)],
      registry: registryOf(mainProvider),
    });

    const result = await main.run({ input: "weather in Shenzhen?" });
    expect(result.text).toBe("It is 28°C in Shenzhen");
    expect(JSON.stringify(mainProvider.lastCall()?.messages ?? [])).toContain("28");
  });

  it("runs agents in parallel and collects every result", async () => {
    const providers = [createMockProvider({ responses: [{ text: "A" }] }), createMockProvider({ responses: [{ text: "B" }] })];
    const agents = providers.map((provider, index) =>
      createAgent({
        name: `agent-${index}`,
        model: "mock:test",
        instructions: "Answer.",
        registry: registryOf(provider),
      }),
    );

    const results = await runParallel(agents, "question");
    expect(results.map((r) => r.text)).toEqual(["A", "B"]);
  });
});

describe("plan and execute", () => {
  it("plans then executes each step", async () => {
    const provider = createMockProvider({
      responses: [
        {
          text: JSON.stringify({
            goal: "compute a sum",
            steps: [
              { title: "Add", instruction: "Add 1 and 2" },
              { title: "Report", instruction: "Report the result" },
            ],
          }),
        },
        { text: "1 + 2 = 3" },
        { text: "The result is 3" },
        { text: "Final: 3" },
      ],
    });

    const outcome = await planAndExecute(
      {
        model: "mock:test",
        registry: registryOf(provider),
        tools: [addTool],
      },
      "What is 1 + 2?",
    );

    expect(outcome.plan.steps).toHaveLength(2);
    expect(outcome.stepResults).toHaveLength(2);
    expect(outcome.result.text).toContain("3");
  });
});
