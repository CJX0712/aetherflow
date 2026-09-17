# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-18

Initial release. A universal, durable and observable runtime for AI agents.

### Added

**Runtime primitives (`aetherflow/core`)** — zero-dependency
- `Stream<T>`: lazy async-iterable pipeline with `map` / `filter` / `flatMap` / `scan` /
  `buffer` / `chunk` / `tee(n)` / `merge`, plus a bounded back-pressure channel
- `TaskGroup` / `mapLimit` / `withTimeout` / `anySignal`: structured concurrency —
  scope exit guarantees every child task finished or was cancelled
- `Result<T, E>` with `map` / `flatMap` / `attempt` / `combine`
- `withRetry` with full-jitter exponential backoff, and a `CircuitBreaker`
- `AetherError` hierarchy with machine-readable `ErrorCode` and retryability derived from it

**Model gateway (`aetherflow/models`)**
- One `Message` / `ContentPart` / `Usage` / `ToolSpec` protocol across vendors
- Native adapters: Anthropic Messages, Gemini `generateContent`
- One OpenAI-compatible adapter covering OpenAI, DeepSeek, Moonshot, Qwen, Zhipu,
  Groq, xAI, OpenRouter, Together, Ollama and vLLM
- `ModelRegistry` with lazy provider construction: `"provider:model"` as the only
  thing business code depends on
- Token and USD accounting for 20+ models; SSE parsing that survives chunk boundaries

**Tools (`aetherflow/tools`)**
- `defineTool` with zod: one schema drives runtime validation, the JSON Schema sent to
  the model, and TypeScript inference
- `ToolRegistry.execute()` never throws — unknown tools, invalid arguments and thrown
  errors all come back as `isError` tool results so the model can self-correct
- Approval gates, per-tool timeouts, output truncation, bounded concurrency
- MCP bridge over stdio / SSE / Streamable HTTP
- Built-ins: `fs_read` / `fs_write` / `fs_list` / `fs_delete` (root-confined),
  `run_command` (approval-gated), `http_request` (host allow-list),
  `calculator` (recursive-descent parser, **no `eval`**), `current_datetime`

**Agent (`aetherflow/agent`)**
- Streaming-first: `run()` is `stream()` collapsed; one event stream drives UI,
  persistence and metrics
- Guardrails: step ceiling, token ceiling, USD ceiling, wall-clock timeout, `AbortSignal`
  propagated into model requests and in-flight tools
- CJK-aware token estimation, plus compaction that never orphan a `tool_call` from its result
- Structured output with an automatic repair loop and three strategies
  (`auto` / `native` / `tool`)
- `agentAsTool`, `createHandoffTools`, `runParallel`, `createSupervisor`, `planAndExecute`

**Memory (`aetherflow/memory`)**
- SQLite event store (built-in `node:sqlite`, WAL, no native compilation)
- Crash-recovery entry point, result snapshots, multi-turn session resume

**Observability (`aetherflow/observability`)**
- OpenTelemetry-style spans with attributes, events and status
- `collectMetrics` over the event stream: steps, tool calls/errors, usage, cost, per-tool breakdown
- Record/replay: capture real interactions once, replay offline in CI — deterministic and free

**Evaluation (`aetherflow/evals`)**
- Three layers of judgment: deterministic assertions, custom predicates, LLM-as-a-judge
- Concurrent execution with per-case cost ceilings

**CLI**
- `aetherflow run` / `repl` / `demo`, with `--verbose` trace tree, `--json` output and
  `--session` persistence

### Security
- Tool input is untrusted: the calculator uses a hand-written recursive-descent parser
  rather than `eval` / `new Function`
- Filesystem tools reject path traversal outside the configured root
- Shell and network tools sit behind approval gates and allow-lists
