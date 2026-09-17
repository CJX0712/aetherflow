/**
 * 02 — 自定义工具、类型安全与人工审批
 *
 * 工具设计里最重要的字段不是 name，而是 description —— 它直接发给模型，
 * 质量决定调用准确率。第二重要是**失败语义**：工具失败不是异常，
 * 而是回喂给模型的反馈，让模型有机会自我修正。
 *
 * 运行：npm run example examples/02-custom-tools.ts
 */

import {
  createAgent,
  createMockProvider,
  defineTool,
  ModelRegistry,
  ToolRegistry,
  type ApprovalDecision,
} from "aetherflow";
import { z } from "zod";

// ── 1) 定义一个业务工具 ────────────────────────────────────────────
// zod schema 同时承担三件事：运行时入参校验、发给模型的 JSON Schema、
// 以及 TypeScript 里 execute 入参的静态类型。一处定义，三处生效。
const searchOrders = defineTool({
  name: "search_orders",
  description:
    "Search customer orders. Returns at most `limit` orders sorted by creation time descending. " +
    "Use `status` to filter; omit it to search all statuses. " +
    "Returns an empty array when nothing matches — do not retry with different wording.",
  inputSchema: z.object({
    customerId: z.string().describe("Customer UUID"),
    status: z.enum(["pending", "paid", "shipped", "refunded"]).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async ({ customerId, status, limit }) => {
    // 真实项目里这里是一次数据库查询；这里用假数据演示。
    const orders = [
      { id: "ord_1", status: "paid", totalCents: 12_800, createdAt: "2026-09-01" },
      { id: "ord_2", status: "shipped", totalCents: 4_500, createdAt: "2026-08-27" },
    ].filter((order) => (status ? order.status === status : true));

    return { customerId, count: Math.min(orders.length, limit), orders: orders.slice(0, limit) };
  },
});

// ── 2) 一个需要审批的高危工具 ──────────────────────────────────────
const issueRefund = defineTool({
  name: "issue_refund",
  description: "Issue a refund for an order. Requires human approval before execution.",
  inputSchema: z.object({
    orderId: z.string(),
    amountCents: z.number().int().positive(),
    reason: z.string().min(4),
  }),
  // 既可以是布尔，也可以是按入参动态判断的函数（例如金额超过阈值才审批）。
  requiresApproval: (input) => input.amountCents > 5_000,
  execute: async ({ orderId, amountCents }) => ({ orderId, refundedCents: amountCents, ok: true }),
});

// ── 3) 注册表：统一持有异构工具，并挂审批钩子 ──────────────────────
const tools = new ToolRegistry({
  approvalHandler: async ({ toolName, input }): Promise<ApprovalDecision> => {
    console.log(`[approval] ${toolName} ${JSON.stringify(input)}`);
    // 真实项目里这里应弹 UI / 发审批消息；CLI demo 直接放行。
    return "approve";
  },
  defaultTimeoutMs: 15_000,
  defaultMaxOutputChars: 8_000, // 截断超长输出，避免撑爆上下文
});
tools.registerAll([searchOrders, issueRefund]);

// ── 4) 直接执行（不经过模型）——用来验证工具本身 ──────────────────
const ok = await tools.execute(
  { id: "call_1", name: "search_orders", args: { customerId: "cus_9", limit: 5 } },
  { signal: AbortSignal.timeout(5_000), agentName: "demo" },
);
console.log("ok.isError  :", ok.isError);
console.log("ok.output   :", ok.output);

// 工具不存在 / 参数不合法，都不会抛异常，而是返回 isError 结果。
const missing = await tools.execute(
  { id: "call_2", name: "does_not_exist", args: {} },
  { signal: AbortSignal.timeout(5_000), agentName: "demo" },
);
console.log("missing     :", missing.isError, "|", missing.output);

const invalid = await tools.execute(
  { id: "call_3", name: "search_orders", args: { customerId: "cus_9", limit: 999 } },
  { signal: AbortSignal.timeout(5_000), agentName: "demo" },
);
console.log("invalid     :", invalid.isError, "|", invalid.output.split("\n")[0]);

// ── 5) 交给 Agent 使用 ─────────────────────────────────────────────
const mock = createMockProvider({
  responses: [
    { toolCalls: [{ name: "search_orders", args: { customerId: "cus_9", status: "paid" } }] },
    { text: "该客户有 1 笔已支付订单，金额 128.00 元。" },
  ],
});
const registry = new ModelRegistry();
registry.register("mock", mock);

const agent = createAgent({
  name: "support",
  model: "mock:gpt-mock",
  instructions: "You are a customer support agent. Always look up orders before answering.",
  tools: tools.list(),
  registry,
});

const result = await agent.run({ input: "cus_9 有几笔已付款订单？" });
console.log("answer      :", result.text);
