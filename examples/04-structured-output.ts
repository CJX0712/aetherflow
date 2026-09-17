/**
 * 04 — 结构化输出：让 Agent 的输出可以直接进数据库
 *
 * 自由文本无法被程序消费。配置 zod schema 之后，`result.output` 就是
 * 已校验的对象；解析失败会带着错误信息回喂模型自我修复
 * （`outputRepairAttempts` 控制修复次数）。
 *
 * 三种策略：
 *  - `auto`（默认）：provider 支持原生 JSON Schema 就用原生，否则用 final_answer 工具
 *  - `native`：强制走 provider 原生结构化输出
 *  - `tool`：强制走 final_answer 工具（兼容性最好）
 *
 * 运行：npm run example examples/04-structured-output.ts
 */

import { createAgent, createMockProvider, ModelRegistry } from "aetherflow";
import { z } from "zod";

const invoiceSchema = z.object({
  vendor: z.string().describe("Vendor name as printed on the invoice"),
  totalCents: z.number().int().describe("Grand total in cents, integer only"),
  currency: z.enum(["CNY", "USD", "EUR", "JPY"]),
  issuedAt: z.string().describe("Issue date in ISO-8601 (YYYY-MM-DD)"),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number(),
        unitPriceCents: z.number().int(),
      }),
    )
    .describe("Every line item on the invoice"),
  confidence: z.number().min(0).max(1).describe("Extraction confidence"),
});

type Invoice = z.infer<typeof invoiceSchema>;

// 模型第一次返回一个**不合法**的 JSON（totalCents 是字符串），
// 演示解析失败后自动修复的回路。
const mock = createMockProvider({
  responses: [
    { text: '{"vendor": "Acme", "totalCents": "not-a-number"}' },
    {
      text: JSON.stringify({
        vendor: "Acme Cloud Services",
        totalCents: 128_000,
        currency: "CNY",
        issuedAt: "2026-09-01",
        lineItems: [
          { description: "Compute (400 vCPU·h)", quantity: 400, unitPriceCents: 220 },
          { description: "Object storage (200 GB)", quantity: 200, unitPriceCents: 200 },
        ],
        confidence: 0.93,
      } satisfies Invoice),
    },
  ],
});

const registry = new ModelRegistry();
registry.register("mock", mock);

const agent = createAgent<Invoice>({
  name: "invoice-parser",
  model: "mock:gpt-mock",
  instructions:
    "Extract invoice fields into the required JSON structure. " +
    "Never invent values that are not on the invoice; use null-free, fully populated objects.",
  output: invoiceSchema,
  outputStrategy: "tool",
  outputRepairAttempts: 2,
  registry,
});

const result = await agent.run({
  input: "Acme Cloud Services 发票，合计 1280.00 元，2026-09-01 开具。",
});

// result.output 已通过 zod 校验，类型就是 Invoice —— 可直接入库。
console.log("vendor      :", result.output?.vendor);
console.log("total       :", result.output?.totalCents, result.output?.currency);
console.log("issuedAt    :", result.output?.issuedAt);
console.log("line items  :", result.output?.lineItems.length);
console.log("confidence  :", result.output?.confidence);
console.log("finish      :", result.finishReason);

// 校验失败时的兜底：output 为 undefined，原始文本仍在 result.text。
if (!result.output) {
  console.warn("parse failed, raw text:", result.text);
}
