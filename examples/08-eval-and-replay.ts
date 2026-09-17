/**
 * 08 — 录制重放 + 评测：把「线上调用」变成「CI 资产」
 *
 * 两件事，一个目的：让 Agent 从「能跑」走到「能放心改」。
 *
 *  A. 录制 / 重放：真实调用很贵且不确定（同一 prompt 两次结果可能不同）。
 *     录一次，之后在 CI 里离线重放 —— 确定性、零成本、秒级。
 *
 *  B. 评测：三层判定，从快到慢依次使用
 *       1. 结构化输出比对 / 关键词包含  —— 确定性，首选
 *       2. 自定义断言                    —— 业务规则
 *       3. 模型评审（LLM-as-judge）      —— 开放式任务按 rubric 打分
 *
 * 运行：npm run example examples/08-eval-and-replay.ts
 */

import {
  createAgent,
  createMockProvider,
  createReplayProvider,
  defineTool,
  formatEvalReport,
  InteractionRecorder,
  ModelRegistry,
  runEvalSuite,
  textOf,
} from "aetherflow";
import { z } from "zod";

// ══ A. 录制 / 重放 ═══════════════════════════════════════════════════

// 假装这是「真实」provider（实际用 mock 代替，离线可跑）。
const real = createMockProvider({
  responses: [
    { toolCalls: [{ name: "get_price", args: { symbol: "AAPL" } }] },
    { text: "AAPL 现价 226.40 美元。", usage: { inputTokens: 512, outputTokens: 32 } },
  ],
});

const recorder = new InteractionRecorder();
const recording = recorder.wrap(real);

const priceTool = defineTool({
  name: "get_price",
  description: "Get the latest price for a ticker symbol.",
  inputSchema: z.object({ symbol: z.string() }),
  execute: ({ symbol }) => ({ symbol, price: 226.4, currency: "USD" }),
});

const buildAgent = (registry: ModelRegistry) =>
  createAgent({
    name: "trader",
    model: "mock:gpt-mock",
    instructions: "Use tools to look up prices. Never guess.",
    tools: [priceTool],
    registry,
  });

const liveRegistry = new ModelRegistry();
liveRegistry.register("mock", recording);

await buildAgent(liveRegistry).run({ input: "AAPL 现在多少钱？" });

// interactions 就是固化下来的资产，可以 JSON 落盘进仓库。
const tape = JSON.stringify(recorder.interactions, null, 2);
console.log("recorded    :", recorder.interactions.length, "interaction(s),", tape.length, "bytes");

// 之后：离线重放。不再联网、不再花钱、结果完全一致。
const replayRegistry = new ModelRegistry();
replayRegistry.register("mock", createReplayProvider(JSON.parse(tape)));

const replayed = await buildAgent(replayRegistry).run({ input: "AAPL 现在多少钱？" });
console.log("replayed    :", replayed.text);
console.log("  finish    :", replayed.finishReason);

// ══ B. 评测 ═════════════════════════════════════════════════════════

const triageSchema = z.object({
  category: z.enum(["billing", "bug", "feature", "other"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
});

// 让每条用例有确定输出：按用户消息内容路由，模拟一个「答得对」的模型。
const triageMock = createMockProvider({
  fallback: (request) => {
    const prompt = [...request.messages].reverse().find((m) => m.role === "user");
    const text = prompt ? textOf(prompt) : "";
    const verdict = text.includes("真棒")
      ? { category: "feature", severity: "low", summary: "正向反馈，无需处理" }
      : text.includes("扣")
        ? { category: "billing", severity: "high", summary: "重复扣费" }
        : { category: "bug", severity: "critical", summary: "导出崩溃" };
    return { text: JSON.stringify(verdict) };
  },
});
const triageRegistry = new ModelRegistry();
triageRegistry.register("mock", triageMock);

const triageAgent = createAgent({
  name: "triage",
  model: "mock:gpt-mock",
  instructions: "Classify the support ticket into the required JSON structure.",
  output: triageSchema,
  outputStrategy: "tool",
  registry: triageRegistry,
});

// 评审模型同样走 mock：真实场景换成 gpt-4o-mini 这类便宜模型即可。
const judgeRegistry = new ModelRegistry();
judgeRegistry.register(
  "mock",
  createMockProvider({ fallback: { text: '{"score": 0.92, "reason": "分类与严重级别均准确。"}' } }),
);

const report = await runEvalSuite({
  name: "support-triage",
  agent: triageAgent,
  concurrency: 2,
  cases: [
    {
      name: "重复扣费 → billing/high",
      input: "这个月被扣了两次年费，请退回多扣的一笔。",
      // 第一层：结构化输出深度比对（确定性最强）
      expected: { category: "billing", severity: "high", summary: "重复扣费" },
    },
    {
      name: "导出崩溃 → bug/critical",
      input: "点击导出 CSV 后页面直接白屏，数据全丢了。",
      expected: { category: "bug", severity: "critical", summary: "导出崩溃" },
      // 第二层：业务自定义断言
      assert: ({ result }) =>
        result.steps <= 4 ? true : `步数过多：${result.steps}`,
      // 第三层：模型评审（开放式输出才用）
      judge: {
        rubric: "分类是否命中正确类别？严重级别是否与业务影响匹配？",
        minScore: 0.7,
        registry: judgeRegistry,
      },
      // 成本护栏：单条用例超预算即判失败
      maxCostUsd: 0.02,
    },
    {
      name: "不得臆造类别",
      input: "你们的产品真棒！",
      contains: [],
      notContains: ["critical"],
      assert: ({ output }) => (output ? true : "必须产出结构化分类"),
    },
  ],
});

console.log();
console.log(formatEvalReport(report));
console.log("passed      :", `${report.passed}/${report.total}`);
console.log("cost (USD)  :", report.totalCostUsd.toFixed(6));
console.log("duration    :", `${report.totalDurationMs}ms`);
