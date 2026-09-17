/**
 * 用于示例 06 的最小 MCP Server（stdio 传输）。
 *
 * 这是**被连接方**的参考实现：任何能说 MCP 的服务（Python / Go / Rust / 远端 HTTP）
 * 都可以用同样的协议挂载到 AetherFlow，本文件只是为了让示例离线可跑。
 *
 * 不依赖 zod：直接用底层 Server + 裸 JSON Schema，跨 SDK 版本最稳定。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "get_weather",
    description:
      "Get the current weather for a city. Returns temperature in Celsius and a short condition string.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. Shenzhen" },
      },
      required: ["city"],
      additionalProperties: false,
    },
  },
  {
    name: "list_cities",
    description: "List the cities for which weather data is available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const DATA = {
  Shenzhen: { celsius: 29, condition: "Thunderstorms, humid" },
  Beijing: { celsius: 22, condition: "Clear" },
  Shanghai: { celsius: 26, condition: "Overcast" },
};

const server = new Server(
  { name: "weather-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_cities") {
    return { content: [{ type: "text", text: JSON.stringify(Object.keys(DATA)) }] };
  }

  if (name === "get_weather") {
    const city = args?.city;
    const entry = typeof city === "string" ? DATA[city] : undefined;
    if (!entry) {
      return {
        isError: true,
        content: [{ type: "text", text: `No weather data for "${String(city)}".` }],
      };
    }
    return {
      content: [
        { type: "text", text: JSON.stringify({ city, ...entry, observedAt: new Date().toISOString() }) },
      ],
    };
  }

  return { isError: true, content: [{ type: "text", text: `Unknown tool "${name}"` }] };
});

await server.connect(new StdioServerTransport());
