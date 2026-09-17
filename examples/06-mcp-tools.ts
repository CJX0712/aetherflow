/**
 * 06 — MCP：把外部世界的工具直接接进来
 *
 * MCP（Model Context Protocol）把「工具实现」与「Agent 运行时」解耦：
 * 别人写好的 MCP Server（Python / Go / 远端 HTTP 都行）无需改造即可挂载。
 *
 * 本示例连接 examples/fixtures/weather-mcp-server.mjs（随仓库自带，离线可跑）。
 * 换成你自己的服务只需改 command / args 或 url。
 *
 * 运行：npm run example examples/06-mcp-tools.ts
 */

import { fileURLToPath } from "node:url";

import { connectMcpServer, createAgent, createMockProvider, ModelRegistry } from "aetherflow";

const fixture = fileURLToPath(new URL("./fixtures/weather-mcp-server.mjs", import.meta.url));

const serverConfig = {
  name: "weather",
  transport: {
    type: "stdio" as const,
    command: process.execPath,
    args: [fixture],
  },
};

// ── 1) 连接 MCP Server ─────────────────────────────────────────────
// 远端服务用 SSE 或 Streamable HTTP：
//   { type: "sse",  url: "https://mcp.example.com/sse" }
//   { type: "http", url: "https://mcp.example.com/mcp" }
const connection = await connectMcpServer(serverConfig);

// `tools()` 每次调用都会重新拉取远端快照 —— MCP 支持工具动态变更。
const mcpTools = await connection.tools();
console.log("connected   :", connection.name);
console.log("tools       :", mcpTools.map((t) => t.name).join(", "));

// ── 2) 直接用（不经过模型）────────────────────────────────────────
// 转换后的 MCP 工具与普通工具完全同构：同样的校验、审批钩子、超时、输出截断。
const weather = mcpTools.find((t) => t.name === "get_weather");
if (weather) {
  const out = await weather.execute({ city: "Shenzhen" }, {
    signal: AbortSignal.timeout(10_000),
    callId: "direct-1",
    agentName: "demo",
  });
  console.log("direct call :", out);
}

// ── 3) 交给 Agent（与内置工具混用）────────────────────────────────
const mock = createMockProvider({
  responses: [
    { toolCalls: [{ name: "get_weather", args: { city: "Shenzhen" } }] },
    { text: "深圳当前 29°C，雷阵雨，湿度较高。" },
  ],
});
const registry = new ModelRegistry();
registry.register("mock", mock);

const agent = createAgent({
  name: "weather-bot",
  model: "mock:gpt-mock",
  instructions: "Answer weather questions using the available tools. Never guess.",
  tools: mcpTools,
  registry,
});

const result = await agent.run({ input: "深圳现在天气怎么样？" });
console.log("answer      :", result.text);
console.log("steps       :", result.steps);

// ── 4) 断开 ────────────────────────────────────────────────────────
// 多服务器场景用 loadMcpTools([cfgA, cfgB])，它返回 { tools, close } 统一收口。
await connection.close();
console.log("closed");
