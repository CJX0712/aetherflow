/**
 * 07 — 持久化与崩溃恢复（事件溯源）
 *
 * Agent 的一次运行本质上是**一串不可变事件**。把它们追加写进 SQLite，
 * 就能免费得到三样东西：
 *   1. 崩溃恢复 —— 进程挂了也知道跑到了第几步
 *   2. 完整审计 —— 每一步的模型输入、工具调用、耗时、花费都可回放
 *   3. 会话续接 —— 多轮对话不必把历史塞在内存里
 *
 * 运行：npm run example examples/07-durability.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgent,
  createBuiltinTools,
  createMockProvider,
  EventStore,
  ModelRegistry,
  persistRun,
} from "aetherflow";

const dir = await mkdtemp(join(tmpdir(), "aetherflow-"));
const dbPath = join(dir, "runs.db");

// 文件库默认开启 WAL；不传 path 则为内存库（测试用）。
const store = new EventStore({ path: dbPath });

const mock = createMockProvider({
  responses: [
    { toolCalls: [{ name: "current_datetime", args: {} }] },
    { toolCalls: [{ name: "calculator", args: { expression: "6 * 7" } }] },
    { text: "6 × 7 = 42。", usage: { inputTokens: 300, outputTokens: 40 } },
  ],
  // 序列耗尽后的兜底响应，供下面第二轮对话使用。
  fallback: { text: "你叫晨星。" },
});
const registry = new ModelRegistry();
registry.register("mock", mock);

const agent = createAgent({
  name: "durable",
  model: "mock:gpt-mock",
  instructions: "Use tools. Answer concisely.",
  tools: createBuiltinTools({ shell: false, filesystem: false, http: false }),
  registry,
});

// ── 1) 边跑边落盘 ──────────────────────────────────────────────────
const runId = "run_demo_001";
await persistRun(store, runId, agent.stream({ input: "6 * 7 等于多少？" }));

const stored = store.events(runId);
console.log("events      :", stored.length);
for (const event of stored) {
  if (event.type === "tool_end" || event.type === "run_end") {
    console.log(`  #${event.seq} ${event.type}`);
  }
}

// ── 2) 从存储重建结果（崩溃恢复的关键）──────────────────────────
const record = store.record(runId);
console.log("agent       :", record?.agentName);
console.log("finish      :", record?.finishReason);
console.log("steps       :", record?.result?.steps);
console.log("cost (USD)  :", record?.result?.costUsd.toFixed(6));
console.log("answer      :", record?.result?.text);

// ── 3) 找出「跑到一半就死了」的运行 ───────────────────────────────
// 真实场景：启动时扫一遍，把未完成的 run 挑出来重跑或告警。
store.append("run_orphan", "run_start", { agentName: "durable", input: "..." });
store.append("run_orphan", "tool_end", { name: "datetime", output: "2026-09-17" });
// 注意：没有 run_end → finished_at 为空 → 判定为中断。

const orphans = store.listUnfinishedRuns();
console.log("unfinished  :", orphans.join(", "));

for (const orphanId of orphans) {
  const partial = store.events(orphanId);
  console.log(`  ${orphanId}: 已落盘 ${partial.length} 个事件，最后一步 ${partial.at(-1)?.type}`);
  // 恢复策略由业务决定：从最后一步续跑，或整轮重跑。
}

// ── 4) 会话续接：多轮对话不占内存 ─────────────────────────────────
const sessionId = "sess_user_42";
const first = await agent.run({ input: "我叫晨星。" });
store.saveSession(sessionId, [...first.messages]);

const history = store.loadSession(sessionId);
console.log("session msgs:", history.length);

const second = await agent.run({
  messages: [...history],
  input: "我叫什么名字？",
});
// 更新会话快照
store.saveSession(sessionId, [...second.messages]);
console.log("follow-up   :", second.text);

store.close();
await rm(dir, { recursive: true, force: true });
console.log("cleaned up  :", dbPath);
