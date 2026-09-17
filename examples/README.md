# Examples

全部示例**离线可跑** —— 不需要任何 API Key。内置的 `createMockProvider` 按脚本返回响应，
完整走通真实的运行时循环（模型请求 → 工具调用 → 结果回喂 → 收敛）。

## 运行

```bash
npm install
npm run example examples/01-hello-agent.ts
```

`npm run example` 底层是 `vite-node -c vitest.config.ts`， examples 目录已在 `tsconfig.json`
的 `include` 里，所以 `npm run typecheck` 会一并检查它们 —— 示例代码不会腐烂。

## 清单

| # | 文件 | 讲什么 |
|---|------|--------|
| 01 | `01-hello-agent.ts` | 最小可用 Agent：注册表、指令、工具、护栏、成本与 token 统计 |
| 02 | `02-custom-tools.ts` | 自定义工具：zod 一处定义三处生效、审批钩子、失败即反馈 |
| 03 | `03-streaming.ts` | 事件流优先：同一份事件既渲染 UI 又聚合指标 |
| 04 | `04-structured-output.ts` | 结构化输出：zod schema + 解析失败自动修复回路 |
| 05 | `05-multi-agent.ts` | 主管/专家模式、并行扇出、结构化并发下的取消传播 |
| 06 | `06-mcp-tools.ts` | MCP：连接外部工具服务器（含随仓库自带的 fixture server） |
| 07 | `07-durability.ts` | 事件溯源持久化、崩溃恢复、多轮会话续接 |
| 08 | `08-eval-and-replay.ts` | 录制/重放（CI 零成本确定性回归）+ 三层判定评测 |

## 换成真实模型

示例里 `registry.register("mock", mock)` 换成真实 provider 即可，其余代码一行不动：

```ts
import { createAgent, createDefaultRegistry } from "aetherflow";

const agent = createAgent({
  name: "assistant",
  model: "deepseek:deepseek-chat",   // 换这一行就行
  instructions: "...",
});
```

默认注册表已内置 OpenAI / Anthropic / Gemini / DeepSeek / Moonshot / 通义千问 / 智谱 /
Groq / xAI / OpenRouter / Together / Ollama / vLLM，按模型名自动推断。
密钥从环境变量读取（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 等）。

## Fixture

`fixtures/weather-mcp-server.mjs` 是一个最小 MCP Server（stdio 传输），
用于示例 06 演示「被连接方」长什么样。任何语言实现的 MCP Server 都可以用同样方式接入。
