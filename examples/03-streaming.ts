/**
 * 03 — 事件流：UI、日志、持久化共用一份数据源
 *
 * AetherFlow 是**流式优先**的：`run()` 只是 `stream()` 的收敛。
 * 这意味着终端渲染、Web UI、trace、指标聚合看到的都是同一条事件流，
 * 不存在「日志说成功但 UI 显示失败」这种三份数据互相打架的情况。
 *
 * 运行：npm run example examples/03-streaming.ts
 */

import {
  collectMetrics,
  createAgent,
  createBuiltinTools,
  createMockProvider,
  ModelRegistry,
  type AgentEvent,
} from "aetherflow";

const mock = createMockProvider({
  responses: [
    {
      reasoning: "需要当前时间，再算差值。",
      toolCalls: [{ name: "current_datetime", args: {} }],
    },
    {
      toolCalls: [{ name: "calculator", args: { expression: "2026 - 1969" } }],
    },
    {
      text: "现在是 2026 年。",
      usage: { inputTokens: 240, outputTokens: 60 },
    },
  ],
  // streamTokens 默认开启：逐 token 吐出，用来观察 text_delta 的时序。
});

const registry = new ModelRegistry();
registry.register("mock", mock);

const agent = createAgent({
  name: "streamer",
  model: "mock:gpt-mock",
  instructions: "Answer concisely. Use tools when they help.",
  tools: createBuiltinTools({ shell: false, filesystem: false, http: false }),
  registry,
});

// ── 渲染器：把事件流翻译成人类可读的输出 ──────────────────────────
function render(event: AgentEvent): void {
  switch (event.type) {
    case "run_start":
      console.log(`\n▶ run ${event.runId} (${event.agentName})`);
      console.log(`  input: ${event.input}`);
      break;
    case "step_start":
      console.log(`\n  ── step ${event.step}`);
      break;
    case "reasoning_delta":
      process.stdout.write(`\x1b[90m${event.delta}\x1b[0m`);
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_start":
      console.log(`\n  ⚙ ${event.name} ${JSON.stringify(event.args)}`);
      break;
    case "tool_end":
      console.log(
        `  ${event.isError ? "✗" : "✓"} ${event.name} (${event.durationMs}ms) → ${event.output.slice(0, 80)}`,
      );
      break;
    case "context_compacted":
      console.log(`  🗜 context compacted (${event.strategy}, removed ${event.removedMessages} msgs)`);
      break;
    case "error":
      console.log(`  ! ${event.error.message} (recoverable=${event.recoverable})`);
      break;
    case "run_end":
      console.log(`\n\n■ finished: ${event.finishReason}`);
      break;
    default:
      break;
  }
}

// ── 消费事件流：边渲染，边收集用于聚合 ─────────────────────────────
const events: AgentEvent[] = [];
for await (const event of agent.stream({ input: "现在是哪一年？" })) {
  events.push(event);
  render(event);
}

// 同一份事件流既能渲染，也能聚合指标 —— 不需要另接一套埋点。
const metrics = collectMetrics(events);
console.log("\nmetrics:");
console.log("  steps        :", metrics.steps);
console.log("  model calls  :", metrics.modelCalls);
console.log("  tool calls   :", metrics.toolCalls, `(errors: ${metrics.toolErrors})`);
console.log("  tokens       :", metrics.usage.totalTokens);
console.log("  cost (USD)   :", metrics.costUsd.toFixed(6));
console.log("  by tool      :", JSON.stringify(metrics.byTool));
