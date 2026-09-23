# AetherFlow

<p align="center">
  <a href="https://github.com/CJX0712/aetherflow/actions/workflows/ci.yml"><img src="https://github.com/CJX0712/aetherflow/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/CJX0712/aetherflow/releases"><img src="https://img.shields.io/github/v/release/CJX0712/aetherflow?sort=semver" alt="release"></a>
  <a href="https://github.com/CJX0712/aetherflow/blob/main/LICENSE"><img src="https://img.shields.io/github/license/CJX0712/aetherflow" alt="license"></a>
  <img src="https://img.shields.io/badge/author-%E6%99%A8%E6%98%9F-1f6feb" alt="author">
</p>

**A universal, durable and observable runtime for AI agents.**
TypeScript · Node 22 · zero vendor lock-in · MCP-native.

[![CI](https://img.shields.io/badge/CI-passing-3ecf8e?style=flat-square)](https://github.com/CJX0712/aetherflow/actions)
[![npm](https://img.shields.io/badge/npm-aetherflow-blue?style=flat-square)](https://www.npmjs.com/package/aetherflow)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5.0-orange?style=flat-square)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-105%20passing-3ecf8e?style=flat-square)](./tests)
[![deps](https://img.shields.io/badge/runtime%20deps-2-lightgrey?style=flat-square)](./package.json)

```bash
npm install aetherflow
```

```ts
import { createAgent, createBuiltinTools } from "aetherflow";
import { z } from "zod";

const agent = createAgent({
  name: "analyst",
  model: "anthropic:claude-sonnet-4-20250514", // or openai:gpt-4o / deepseek:deepseek-chat
  instructions: "Verify every number with a tool before answering.",
  tools: createBuiltinTools({ shell: false }),
  output: z.object({ summary: z.string(), confidence: z.number().min(0).max(1) }),
  maxSteps: 12,
  maxCostUsd: 0.5,
});

const result = await agent.run({ input: "Summarize the key risks in this report" });
console.log(result.output?.summary, result.costUsd);
```

---

## Why another agent framework?

Most agent code works in a demo and falls apart in production. The failures are
rarely about model intelligence — they are engineering failures that repeat
across every team:

| Failure mode | Naive implementation | AetherFlow |
|---|---|---|
| Tool throws | Exception kills the run | Error is returned as `tool_result` and fed back — the model self-corrects |
| Concurrent tool calls | `Promise.all` leaves orphan tasks burning tokens | Structured concurrency; scope exit cancels everything |
| Context overflow | API 400, run dies | Adaptive compaction that never splits a `tool_call` from its result |
| Process crash | Start over, pay again | Event-sourced store; runs are resumable |
| Regression tests | Live API calls: slow, flaky, expensive | Record once, replay offline — deterministic and free |
| Cost visibility | Surprise at month end | Token and USD accounting on every run |
| Switching model | Rewrite adapters | Change one string |

Everything below is about making those rows on the right the default, not something
you have to build yourself.

## Architecture

Six layers, each usable on its own. Use only the stream utilities, or only the model
gateway — you do not have to buy into the whole paradigm.

| Layer | Responsibility | Highlights |
|---|---|---|
| **Agent** | ReAct loop, plan-and-execute, multi-agent | Guardrails, structured output + repair, context compaction |
| **Tools** | zod-typed tools, MCP bridge | Failure-as-feedback, approval gates, sandbox paths |
| **Models** | One protocol, many vendors | OpenAI-compatible ecosystem, Anthropic, Gemini, unified usage/cost |
| **Runtime** | Zero-dependency primitives | Lazy streams with `tee`, structured concurrency, jittered backoff, circuit breaker |
| **Memory** | SQLite event sourcing | Crash recovery, session resume, no native deps |
| **Observability** | Trace, metrics, replay | OpenTelemetry-style spans, cost attribution, record/replay |

## Model gateway

One string selects the provider. Unknown vendors can be added by registering a factory.

| Provider | Reference | Notes |
|---|---|---|
| OpenAI | `openai:gpt-4o` | Native JSON Schema, prompt caching usage |
| Anthropic | `anthropic:claude-sonnet-4-20250514` | Extended thinking, prompt caching, merged role handling |
| Google | `gemini:gemini-2.5-pro` | `generateContent` protocol, `alt=sse` streaming |
| DeepSeek | `deepseek:deepseek-chat` | `reasoning_content` in stream |
| Moonshot | `moonshot:moonshot-v1-32k` | Kimi |
| Qwen | `qwen:qwen-max` | DashScope compatible mode |
| Zhipu | `zhipu:glm-4-plus` | GLM |
| Groq / xAI / Together / OpenRouter | `groq:…`, `xai:…` | OpenAI-compatible |
| Ollama / vLLM | `ollama:llama3`, `vllm:…` | Local inference, no API key |
| Mock / Replay | `mock:…` | Testing without network or spend |

Provider construction is lazy, so a missing API key for one vendor never breaks the others.

```ts
import { createDefaultRegistry } from "aetherflow";

const registry = createDefaultRegistry();
const { provider, model } = registry.resolve("deepseek:deepseek-chat");
```

## Tools and MCP

Tools are defined with zod; the JSON Schema sent to the model is derived, and inputs
are validated at runtime.

```ts
import { defineTool, connectMcpServer } from "aetherflow";
import { z } from "zod";

const search = defineTool({
  name: "search_docs",
  description: "Search the internal knowledge base and return the most relevant passages.",
  inputSchema: z.object({ query: z.string(), topK: z.number().int().default(5) }),
  execute: async ({ query, topK }, ctx) => vectorSearch(query, topK, ctx.signal),
});

// Reuse any community MCP server instead of writing an adapter
const github = await connectMcpServer({
  name: "github",
  transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  prefixToolNames: true,
});
const mcpTools = await github.tools();
```

**Tool failures never abort a run.** A missing tool, an invalid argument, or a thrown
error all come back as a `tool_result` with `isError: true`, so the model can read the
error and retry correctly. This single property removes a large class of brittle agents.

Built-in tool sets (all opt-in, all configurable):

- `fs_read` / `fs_write` / `fs_list` / `fs_delete` — confined to a root directory, path traversal rejected
- `run_command` — shell execution behind an approval gate, with timeout and output truncation
- `http_request` — optional host allow-list
- `calculator` — a hand-written recursive-descent parser, **not** `eval`; model output is treated as untrusted input
- `current_datetime` — models do not know what "now" is

## Guardrails

```ts
const agent = createAgent({
  name: "ops",
  model: "openai:gpt-4o",
  instructions: "You are an SRE assistant.",
  tools: [...],
  maxSteps: 20,          // stop runaway loops
  maxTokens: 500_000,    // token ceiling
  maxCostUsd: 2,         // hard spend ceiling
  timeoutMs: 120_000,    // wall clock
  context: { maxContextTokens: 120_000, strategy: "summarize" },
});
```

Cancellation is a first-class citizen: an `AbortSignal` propagates into model requests
and in-flight tools, so Ctrl-C actually stops the work (and the spend).

## Context engineering

Long-running agents fail from context mismanagement more than from reasoning errors.
AetherFlow estimates tokens with a CJK-aware heuristic (far more accurate than
`length / 4` on mixed-language input) and compacts history when a budget is exceeded.

The critical detail: **a `tool_call` is never separated from its `tool_result`.**
Orphaned tool results are rejected outright by OpenAI and Anthropic — this is the
root cause of many "it broke on the 30th message" bugs.

Two strategies: `truncate` (free, keeps the recent window) and `summarize`
(spends a call to compress older turns into durable facts).

## Multi-agent

```ts
import { createAgent, agentAsTool, runParallel, createSupervisor } from "aetherflow";

const sqlExpert = createAgent({ name: "sql", model: "openai:gpt-4o", instructions: "SQL expert.", tools: [query] });
const vizExpert = createAgent({ name: "viz", model: "anthropic:claude-sonnet-4-20250514", instructions: "Chart expert." });

// Supervisor only decomposes and delegates — predictable context cost, failures are locatable
const supervisor = createSupervisor({ model: "anthropic:claude-sonnet-4-20250514", experts: [sqlExpert, vizExpert] });

// Redundant verification: run several agents on the same input
const results = await runParallel([agentA, agentB, agentC], "Summarize the risks in this contract", { concurrency: 3 });
```

Delegation via `agentAsTool` gives the sub-agent its own message history, so the parent
sees only a result digest — the most effective way to keep context growth under control.

## Durability

Every event is appended to SQLite (Node's built-in `node:sqlite`, no native
compilation), and the final result is materialized as a snapshot.

```ts
import { EventStore, persistRun } from "aetherflow";

const store = new EventStore({ path: ".aetherflow/runs.db", wal: true });
await persistRun(store, runId, agent.stream({ input: "…", runId }));

store.listUnfinishedRuns();          // crash recovery entry point
store.saveSession("u-1", messages);  // multi-turn resume
```

## Observability

The same event stream drives UI rendering, persistence, and metrics — there are not
three pipelines that can disagree.

```ts
import { Tracer, collectMetrics, formatTrace } from "aetherflow";

const events = await agent.stream({ input }).toArray();
const metrics = collectMetrics(events);
// { steps, modelCalls, toolCalls, toolErrors, usage, costUsd, byTool, contextCompactions }
```

## Evaluation

```ts
import { runEvalSuite, formatEvalReport, InteractionRecorder, createReplayProvider } from "aetherflow";

// Record once against a real provider…
const recorder = new InteractionRecorder();
const wrapped = recorder.wrap(realProvider);

// …then replay offline in CI: deterministic, free, no network
const replay = createReplayProvider(InteractionRecorder.load(recorder.save()));

const report = await runEvalSuite({
  name: "customer-support",
  agent,
  concurrency: 4,
  cases: [
    { name: "refund policy", input: "Can I get a refund?", contains: ["7 days"] },
    { name: "extraction", input: "Extract ticket fields", expected: { priority: "high" } },
    { name: "tone", input: "You are too slow", judge: { rubric: "Empathize before solving, no deflection", minScore: 0.8 } },
  ],
});
console.log(formatEvalReport(report));
```

Three layers of judgment: deterministic assertions, custom predicates, and
LLM-as-a-judge with an explicit rubric.

## CLI

```bash
aetherflow run "What is 128 * 47?" -m openai:gpt-4o --verbose
aetherflow run "Review this repo" -m anthropic:claude-sonnet-4-20250514 -t fs,shell
aetherflow repl -m deepseek:deepseek-chat
aetherflow demo            # full tool-calling run with trace — no API key needed
```

`--verbose` prints tool calls, durations, token/cost accounting, and the span tree.
`--json` prints the complete run result. `--session <id>` persists and resumes a conversation.

## Examples

Eight runnable examples, all **offline** — they use the scripted mock provider, so no
API key and no network required:

```bash
npm run example examples/01-hello-agent.ts
```

| # | Example | What it shows |
|---|---|---|
| 01 | `01-hello-agent.ts` | Minimal agent: registry, tools, guardrails, token/USD accounting |
| 02 | `02-custom-tools.ts` | zod-typed tools, approval gates, failure-as-feedback |
| 03 | `03-streaming.ts` | Event-stream-first: one stream drives both UI and metrics |
| 04 | `04-structured-output.ts` | Structured output with an automatic repair loop |
| 05 | `05-multi-agent.ts` | Supervisor/experts, parallel fan-out, cancellation propagation |
| 06 | `06-mcp-tools.ts` | MCP: attach an external tool server (fixture included) |
| 07 | `07-durability.ts` | Event sourcing, crash recovery, multi-turn session resume |
| 08 | `08-eval-and-replay.ts` | Record/replay in CI + three-layer evaluation |

See [`examples/README.md`](./examples/README.md) for details.

## Development

```bash
npm install
npm run test        # 105 tests, no network, no API keys
npm run typecheck   # strict TypeScript (src, tests and examples)
npm run build       # ESM + CJS + d.ts
npm run example examples/01-hello-agent.ts
```

The entire test suite runs against a scripted mock provider, so it is deterministic
and costs nothing. Contributions are welcome — read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
first; it lists the three hard rules that get a PR sent back.

## Requirements

Node.js **≥ 22.5** (uses the built-in `node:sqlite`). Only two runtime dependencies:
`zod` and `@modelcontextprotocol/sdk`.

## Roadmap

- [ ] Browser/edge build (Web Streams transport instead of `node:sqlite`)
- [ ] OTLP exporter
- [ ] Built-in semantic memory with local embeddings
- [ ] Streaming tool results (partial output back to the model)
- [ ] Fine-grained cost budgets per session

## License

MIT © 晨星 (Chenxing)
