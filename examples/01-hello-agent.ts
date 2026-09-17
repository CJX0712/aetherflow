/**
 * 01 — 最小可用 Agent（离线可跑）
 *
 * 这个例子不需要任何 API Key：用内置 mock provider 模拟模型行为，
 * 完整走通「模型请求 → 工具调用 → 工具结果回喂 → 最终回答」的循环。
 *
 * 运行：npm run example examples/01-hello-agent.ts
 *
 * 换成真实模型只需要两行：
 *   const agent = createAgent({ model: "deepseek:deepseek-chat", ... });
 *   // export DEEPSEEK_API_KEY=sk-...
 */

import {
  createAgent,
  createBuiltinTools,
  createMockProvider,
  ModelRegistry,
} from "aetherflow";

// 1) 模型：mock provider 按脚本返回响应。
//    第一轮返回一次工具调用，第二轮给出自然语言回答。
const mock = createMockProvider({
  responses: [
    {
      toolCalls: [{ name: "calculator", args: { expression: "128 * 47 + 19" } }],
    },
    {
      text: "128 × 47 + 19 = 6035",
      usage: { inputTokens: 120, outputTokens: 24 },
    },
  ],
});

// 2) 注册表：把 "provider:model" 字符串解析成 provider 实例。
//    业务代码只依赖字符串，换供应商不改任何编排逻辑。
const registry = new ModelRegistry();
registry.register("mock", mock);

// 3) Agent：指令 + 工具 + 护栏。
const agent = createAgent({
  name: "assistant",
  model: "mock:gpt-mock",
  instructions: [
    "You are a precise assistant.",
    "When a question requires computation, use the calculator tool instead of doing mental math.",
    "Answer in the same language as the user.",
  ].join("\n"),
  // 只开只读工具；shell / 写文件 / 网络请求一律关闭。
  tools: createBuiltinTools({ shell: false, filesystem: false, http: false }),
  registry,
  maxSteps: 6,
  maxCostUsd: 0.05,
  timeoutMs: 30_000,
});

const result = await agent.run({ input: "128 * 47 + 19 等于多少？" });

console.log("answer      :", result.text);
console.log("steps       :", result.steps);
console.log("tokens      :", result.usage.totalTokens);
console.log("cost (USD)  :", result.costUsd.toFixed(6));
console.log("finish      :", result.finishReason);
console.log("duration    :", `${result.durationMs}ms`);

// 完整对话历史，可直接喂回下一轮实现多轮会话。
console.log("messages    :", result.messages.length);
