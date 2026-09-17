# Contributing

感谢你想让 AetherFlow 变得更好。这份文档说明**什么会被接受、什么会被退回**，
以及怎么在本地把改动验证到位。

## 开发循环

```bash
npm install
npm run typecheck   # tsc --noEmit，严格模式
npm test            # vitest
npm run build       # tsup → ESM + CJS + d.ts
npm run example examples/01-hello-agent.ts
```

提交前请保证前三条全绿。CI 会在 Node 22 与 24 上跑同样三步，外加 CLI 与全部 examples 的冒烟。

## 硬规则（违反 = 退回）

这三条是设计取舍，不是风格偏好：

1. **工具失败不是异常，是给模型的反馈。**
   `ToolRegistry.execute()` 永不抛错 —— 工具不存在、参数不合法、执行报错，
   一律返回 `isError: true` 的 `tool_result`，让模型有机会自我修正。
   新增工具请遵循这一点，不要在 `execute` 里吞掉错误也不要求上层 try/catch。

2. **不用 `Promise.all` 做并发。**
   用 `mapLimit` / `TaskGroup`。理由：`Promise.all` 在一个任务 reject 时会留下继续运行的孤儿任务 ——
   对 Agent 来说那意味着**继续烧钱**。结构化并发保证作用域退出时子任务已结束或被取消。

3. **不为了省事引入运行时依赖。**
   核心 `src/core/` 必须零依赖。整体运行时依赖目前只有 `zod` 与 `@modelcontextprotocol/sdk`。
   能用手写 30 行解决的，不要引一个包；能用 Node 内置（`node:sqlite`、原生 `fetch`）的，不要引第三方。

## 代码组织

- 单文件 ≤ 300 行。超了先问是不是职责没拆干净。
- 分层依赖只向下：`agent → models/tools → core`。`core` 不允许 import 上层任何东西。
- 入口文件（`src/index.ts`、各模块 `index.ts`）只做导出装配，不放业务逻辑。
- 逻辑下沉到 service；路由层/CLI 层只做参数解析与结果渲染。

## 测试纪律

- 新功能必须有测试，且**断言行为，不断言实现**。
- 测试不得依赖网络。所有模型交互走 `createMockProvider`。
- 禁止 `it.skip` 让测试变绿。这条最容易被违反，也最没价值。
- 涉及流式时序的测试，用 `tokenDelayMs` 显式构造，不要靠 `setTimeout` 赌运气。
- 发现 bug 先写一个会失败的测试，再修。测试是缺陷的归档，不是覆盖率装饰。

## 提交信息

用 Conventional Commits，范围取模块名：

```
feat(agent): 支持 replanEvery 周期重规划
fix(models): 修复 Anthropic 相邻同 role 消息未合并
docs(readme): 补充 MCP 传输矩阵
test(tools): 覆盖工具参数校验失败路径
```

## PR 检查清单

- [ ] `npm run typecheck && npm test && npm run build` 全绿
- [ ] 新增/变更的公开 API 有 JSDoc，说明**为什么**这样设计
- [ ] 没有新增运行时依赖（或已在 issue 里论证过）
- [ ] README / docs 同步更新（行为变了就该改文档）
- [ ] 没有 emoji 出现在代码或 UI 产出里（图标一律用 SVG 方案）

## 报告 Bug

请附：最小复现代码、Node 版本、AetherFlow 版本、实际输出与期望输出。
带 failing test 的 issue 会被优先处理 —— 那已经完成了一半的工作。

## 行为准则

对事不对人。技术分歧摆数据、摆代码、摆 benchmark，不摆资历。
