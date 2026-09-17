/**
 * AetherFlow — 通用、可持久化、可观测的 AI Agent 运行时。
 *
 * ```ts
 * import { createAgent, createBuiltinTools, ModelRegistry } from "aetherflow";
 *
 * const agent = createAgent({
 *   name: "assistant",
 *   model: "anthropic:claude-sonnet-4-20250514",
 *   instructions: "You are a helpful assistant.",
 *   tools: createBuiltinTools({ shell: false }),
 * });
 *
 * const result = await agent.run({ input: "What is 12 * (7 + 5)?" });
 * console.log(result.text);
 * ```
 *
 * @packageDocumentation
 */

export * from "./core/index.js";
export * from "./models/index.js";
export * from "./tools/index.js";
export * from "./agent/index.js";
export * from "./memory/index.js";
export * from "./observability/index.js";
export * from "./evals/index.js";

export { createDefaultRegistry } from "./models/index.js";
export { toJsonSchema, toStrictJsonSchema, normalizeSchema } from "./tools/schema.js";
export { connectMcpServer, loadMcpTools } from "./tools/mcp.js";
export type { McpServerConfig, McpTransportConfig, McpConnection } from "./tools/mcp.js";
