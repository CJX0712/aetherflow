/**
 * MCP（Model Context Protocol）客户端桥接。
 *
 * MCP 是 Anthropic 开源并已成为业界标准的「工具即服务」协议 —— 与其为每个系统
 * 手写适配器，不如直接复用社区已经写好的上千个 MCP Server。
 * 这里复用官方 TypeScript SDK 处理传输与协议细节，把远端工具映射为本地 Tool。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { defineTool, type Tool } from "./tool.js";

export type McpTransportConfig =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly type: "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface McpServerConfig {
  /** 本地别名，用于日志与工具命名空间。 */
  readonly name: string;
  readonly transport: McpTransportConfig;
  /** 是否给工具名加 `<server>__` 前缀；多服务器同名工具时建议开启。 */
  readonly prefixToolNames?: boolean;
  /** 只暴露这些工具；为空则全部暴露。 */
  readonly includeTools?: readonly string[];
  readonly excludeTools?: readonly string[];
}

export interface McpConnection {
  readonly name: string;
  readonly client: Client;
  /** 远端工具的最新快照（MCP 支持动态变更，可重复调用刷新）。 */
  tools(): Promise<readonly Tool<Record<string, unknown>, unknown>[]>;
  close(): Promise<void>;
}

function createTransport(config: McpTransportConfig) {
  switch (config.type) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: [...config.args] } : {}),
        ...(config.env ? { env: { ...process.env, ...config.env } as Record<string, string> } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
    case "sse":
      return new SSEClientTransport(new URL(config.url), {
        ...(config.headers ? { requestInit: { headers: { ...config.headers } } } : {}),
      });
    case "http":
      return new StreamableHTTPClientTransport(new URL(config.url), {
        ...(config.headers ? { requestInit: { headers: { ...config.headers } } } : {}),
      });
    default:
      throw new Error(`Unsupported MCP transport`);
  }
}

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  // SDK 1.30 的 ClientCapabilities 不再包含 tools 字段，使用默认能力集即可
  const client = new Client({ name: `aetherflow-${config.name}`, version: "0.1.0" });
  await client.connect(createTransport(config.transport));

  return {
    name: config.name,
    client,
    async tools(): Promise<readonly Tool<Record<string, unknown>, unknown>[]> {
      const result = await client.listTools();
      return (result.tools ?? [])
        .filter((tool) => {
          if (config.includeTools && !config.includeTools.includes(tool.name)) return false;
          if (config.excludeTools?.includes(tool.name)) return false;
          return true;
        })
        .map((tool) => {
          const exposedName =
            config.prefixToolNames && !tool.name.startsWith(`${config.name}__`)
              ? `${config.name}__${tool.name}`
              : tool.name;
          return defineTool<Record<string, unknown>, unknown>({
            name: exposedName,
            description: tool.description ?? tool.name,
            inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
            execute: async (input: Record<string, unknown>) => {
              const response = await client.callTool({ name: tool.name, arguments: input });
              if (response.isError) {
                throw new Error(stringifyMcpContent(response.content));
              }
              return { content: stringifyMcpContent(response.content) };
            },
          }) as Tool<Record<string, unknown>, unknown>;
        });
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

/** 连接多个 MCP Server 并把它们的工具合并为一个数组。 */
export async function loadMcpTools(
  configs: readonly McpServerConfig[],
): Promise<{ tools: readonly Tool<Record<string, unknown>, unknown>[]; close: () => Promise<void> }> {
  const connections = await Promise.all(configs.map((config) => connectMcpServer(config)));
  const toolLists = await Promise.all(connections.map((connection) => connection.tools()));
  return {
    tools: toolLists.flat(),
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  };
}

function stringifyMcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
          if (record["type"] === "resource" && record["resource"]) {
            const resource = record["resource"] as Record<string, unknown>;
            const text = resource["text"];
            if (typeof text === "string") return text;
          }
          try {
            return JSON.stringify(record);
          } catch {
            return String(record);
          }
        }
        return String(item);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
