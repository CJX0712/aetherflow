/**
 * 05 — 多智能体：主管 / 专家 + 并行
 *
 * 两种形态，各有适用场景：
 *
 *  1. `createSupervisor` —— 主管只拆解与分发，专家负责执行。
 *     子 Agent 拥有**独立的消息历史**，主 Agent 只看到结果摘要。
 *     这是控制上下文膨胀最有效的手段，也是目前业界验证过最稳定的多智能体形态。
 *
 *  2. `runParallel` / `createHandoffTools` —— 并行扇出，或让 Agent 之间互相转交。
 *
 * 运行：npm run example examples/05-multi-agent.ts
 */

import {
  createAgent,
  createSupervisor,
  createMockProvider,
  ModelRegistry,
  runParallel,
} from "aetherflow";

function mockRegistry(responses: Parameters<typeof createMockProvider>[0]): ModelRegistry {
  const registry = new ModelRegistry();
  registry.register("mock", createMockProvider(responses));
  return registry;
}

// 每个专家用**独立的** mock provider，互不干扰模拟各自的行为。
const researcher = createAgent({
  name: "researcher",
  model: "mock:gpt-mock",
  instructions: "You research a topic and return at most five bullet points of hard facts.",
  registry: mockRegistry({
    responses: [{ text: "• MCP 是开放协议\n• 支持 stdio / SSE / StreamableHTTP\n• 已被多家厂商采纳" }],
  }),
});

const writer = createAgent({
  name: "writer",
  model: "mock:gpt-mock",
  instructions: "You turn research bullets into a tight two-paragraph explainer.",
  registry: mockRegistry({
    responses: [{ text: "MCP 是一套开放协议……（成稿）" }],
  }),
});

// ── 形态 1：主管 + 专家 ────────────────────────────────────────────
const supervisor = createSupervisor({
  name: "editor-in-chief",
  model: "mock:gpt-mock",
  experts: [researcher, writer],
  // 主管依次委派给两个专家，然后给出最终答复。
  registry: mockRegistry({
    responses: [
      { toolCalls: [{ name: "ask_researcher", args: { task: "调研 MCP 协议要点" } }] },
      { toolCalls: [{ name: "ask_writer", args: { task: "把要点写成两段落" } }] },
      { text: "已完成：先调研后成稿，结论见上。" },
    ],
  }),
  maxSteps: 8,
});

const supervised = await supervisor.run({ input: "写一篇关于 MCP 的短文" });
console.log("supervisor  :", supervised.text);
console.log("  steps     :", supervised.steps, "| finish:", supervised.finishReason);

// ── 形态 2：并行扇出 ───────────────────────────────────────────────
// 同一个输入，多个视角同时跑，最后汇总。适合「让 3 个模型互相交叉验证」。
const critics = ["cost", "security", "latency"].map((lens) =>
  createAgent({
    name: `critic-${lens}`,
    model: "mock:gpt-mock",
    instructions: `You review technical proposals strictly from the ${lens} angle. Be blunt.`,
    registry: mockRegistry({ responses: [{ text: `[${lens}] 结论：可行，但有保留。` }] }),
  }),
);

// 用 mapLimit 而非 Promise.all：可限并发，且中断时已启动的 Agent 会被取消，
// 不会留下继续烧钱的孤儿任务。
// 中断用 signal：取消时已启动的 Agent 会收到信号并停止，不会留下孤儿任务继续烧钱。
const reviews = await runParallel(critics, "把推理服务迁到自建 GPU 集群", {
  concurrency: 2,
  signal: AbortSignal.timeout(60_000),
});

for (const review of reviews) {
  console.log(`  ${review.agentName.padEnd(16)} → ${review.text}`);
}
