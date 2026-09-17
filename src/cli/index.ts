#!/usr/bin/env node
/**
 * AetherFlow CLI。
 *
 * 定位不是"又一个聊天窗口"，而是一个**可诊断的**运行入口：
 *  - 默认流式输出，Ctrl-C 立即中断（中断会传播到工具与模型调用）
 *  - --verbose 打开后可见每一步的工具调用、耗时、token 与成本
 *  - --demo 无需任何 API Key 即可完整体验一次带工具调用的 Agent 运行
 */

import { createInterface } from "node:readline";

import { createAgent } from "../agent/agent.js";
import { collectMetrics, formatTrace, Tracer } from "../observability/index.js";
import { EventStore } from "../memory/store.js";
import { createMockProvider } from "../models/mock.js";
import { calculatorTool, createBuiltinTools, datetimeTool } from "../tools/index.js";
import type { AgentEvent, RunResult } from "../agent/types.js";
import type { AnyTool } from "../tools/tool.js";

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

const HELP = `
AetherFlow — a universal, durable and observable runtime for AI agents

Usage:
  aetherflow run "<prompt>" [options]
  aetherflow repl [options]
  aetherflow demo

Options:
  -m, --model <ref>        Model reference, e.g. openai:gpt-4o, anthropic:claude-sonnet-4-20250514
  -s, --system <text>      System instructions
  -n, --max-steps <num>    Maximum agent steps (default 25)
  -t, --tools <list>       Extra tool sets: fs, http, shell (comma separated)
      --no-tools           Disable even the built-in utility tools
      --json               Print the full run result as JSON
      --verbose            Show tool calls, usage, cost and the trace tree
      --session <id>       Persist and resume a session under this id
  -h, --help               Show this help

Environment:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, ...

Examples:
  aetherflow run "What is 128 * 47?" -m openai:gpt-4o --verbose
  aetherflow run "Review this repo" -m anthropic:claude-sonnet-4-20250514 -t fs,shell
  aetherflow demo
`.trim();

function parseArgs(argv: readonly string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      flags._.push(token);
      continue;
    }
    const [name, inlineValue] = token.replace(/^--?/, "").split("=");
    const key = name!;
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function str(value: string | boolean | string[] | undefined, fallback = ""): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(",");
  return fallback;
}

function buildTools(flags: Flags): AnyTool[] {
  if (flags["no-tools"] === true) return [];
  const selected = str(flags["t"] ?? flags["tools"]).split(",").map((s) => s.trim()).filter(Boolean);
  const tools: AnyTool[] = [];
  if (selected.length === 0) return [calculatorTool, datetimeTool];

  const registry = createBuiltinTools({
    utilities: true,
    filesystem: selected.includes("fs") ? { requireApprovalForWrites: true } : false,
    shell: selected.includes("shell") ? {} : false,
    http: selected.includes("http") ? {} : false,
  });
  tools.push(...registry);
  return tools;
}

async function renderRun(
  events: AsyncIterable<AgentEvent>,
  options: { verbose: boolean; json: boolean; store?: EventStore; runId: string; tracer: Tracer },
): Promise<RunResult<unknown> | undefined> {
  const { verbose, json } = options;
  const collected: AgentEvent[] = [];
  const rootSpan = options.tracer.startSpan("cli.run", { attributes: { runId: options.runId } });

  let wroteAnyText = false;
  for await (const event of events) {
    collected.push(event);
    if (options.store) options.store.append(options.runId, event.type, event);

    switch (event.type) {
      case "text_delta":
        if (!json) {
          process.stdout.write(event.delta);
          wroteAnyText = true;
        }
        break;
      case "tool_start":
        if (verbose) {
          process.stdout.write(
            `\n\n[tool] ${event.name}(${JSON.stringify(event.args)})\n`,
          );
        }
        break;
      case "tool_end":
        if (verbose) {
          const preview = event.output.length > 300 ? `${event.output.slice(0, 300)}…` : event.output;
          process.stdout.write(
            `[tool:${event.isError ? "error" : "ok"}] ${event.name} (${event.durationMs}ms)\n${preview}\n`,
          );
        }
        break;
      case "context_compacted":
        if (verbose) {
          process.stdout.write(`\n[context] compacted ${event.removedMessages} messages (${event.strategy})\n`);
        }
        break;
      case "error":
        if (verbose) process.stdout.write(`\n[error] ${event.error.message}\n`);
        break;
      case "run_end":
        if (json) {
          process.stdout.write(`${JSON.stringify(event.result, null, 2)}\n`);
        } else {
          if (wroteAnyText) process.stdout.write("\n");
          if (event.result.error) {
            process.stdout.write(`\n[${event.finishReason}] ${event.result.error.message}\n`);
          }
        }
        break;
      default:
        break;
    }
  }

  rootSpan.end("ok");

  const finalEvent = collected.find((e) => e.type === "run_end");
  const result = finalEvent?.type === "run_end" ? finalEvent.result : undefined;

  if (verbose) {
    const metrics = collectMetrics(collected);
    process.stdout.write(
      `\n---\nsteps ${metrics.steps} | tool calls ${metrics.toolCalls} (${metrics.toolErrors} failed) | ` +
        `tokens ${metrics.usage.totalTokens} (in ${metrics.usage.inputTokens} / out ${metrics.usage.outputTokens}) | ` +
        `cost $${metrics.costUsd.toFixed(6)} | ${formatSummary(collected)}\n`,
    );
    process.stdout.write(`${formatTrace(options.tracer.tree())}\n`);
  }

  return result;
}

function formatSummary(events: readonly AgentEvent[]): string {
  const end = events.find((e) => e.type === "run_end");
  if (end?.type !== "run_end") return "no result";
  return `${end.result.durationMs}ms · ${end.finishReason}`;
}

async function runCommand(flags: Flags): Promise<void> {
  const prompt = flags._[1] ?? "";
  if (!prompt) {
    process.stderr.write('Error: a prompt is required, e.g. aetherflow run "hello"\n');
    process.exitCode = 1;
    return;
  }
  const model = str(flags["m"] || flags["model"], "openai:gpt-4o");
  const store = flags["session"] ? new EventStore({ path: ".aetherflow/sessions.db" }) : undefined;

  const agent = createAgent({
    name: "cli",
    model,
    instructions: str(flags["s"] || flags["system"], "You are a helpful, concise assistant."),
    tools: buildTools(flags),
    ...(flags["n"] || flags["max-steps"] ? { maxSteps: Number(str(flags["n"] ?? flags["max-steps"], "25")) } : {}),
  });

  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort(new Error("Interrupted by user"));
  });

  const runId = `cli-${Date.now()}`;
  const sessionId = str(flags["session"]);
  const prior = sessionId && store ? store.loadSession(sessionId) : [];

  const result = await renderRun(
    agent.stream({
      input: prompt,
      signal: controller.signal,
      runId,
      ...(prior.length > 0 ? { messages: prior } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
    { verbose: flags["verbose"] === true, json: flags["json"] === true, runId, tracer: new Tracer(), ...(store ? { store } : {}) },
  );

  // 会话续接：直接落盘本次运行的消息列表，不重复调用模型
  if (sessionId && store && result) {
    store.saveSession(sessionId, result.messages);
    store.close();
  }
}

async function replCommand(flags: Flags): Promise<void> {
  const model = str(flags["m"] || flags["model"], "openai:gpt-4o");
  const agent = createAgent({
    name: "repl",
    model,
    instructions: str(flags["s"] || flags["system"], "You are a helpful assistant."),
    tools: buildTools(flags),
  });

  process.stdout.write(`AetherFlow REPL — model: ${model}\nType "exit" to quit.\n\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const conversation: { role: "user" | "assistant"; content: string }[] = [];

  const ask = (): void => {
    rl.question("> ", async (input) => {
      const text = input.trim();
      if (text === "exit" || text === "quit") {
        rl.close();
        return;
      }
      if (!text) {
        ask();
        return;
      }
      const controller = new AbortController();
      const result = await agent.run({
        input: text,
        signal: controller.signal,
        ...(conversation.length > 0 ? { messages: conversation } : {}),
      });
      process.stdout.write(`\n${result.text}\n\n`);
      conversation.push({ role: "user", content: text }, { role: "assistant", content: result.text });
      ask();
    });
  };
  ask();
}

/** 离线演示：用脚本化的 mock provider 完整走一遍「工具调用 + 自我修正 + 结构化收尾」。 */
async function demoCommand(): Promise<void> {
  const provider = createMockProvider({
    responses: [
      {
        reasoning: "用户要比较两个城市的天气，我需要先获取当前时间，再做一次换算。",
        toolCalls: [{ name: "current_datetime", args: { timeZone: "Asia/Shanghai" } }],
      },
      { toolCalls: [{ name: "calculator", args: { expression: "(28 - 21) * 9 / 5 + 32" } }] },
      { text: "深圳 28°C，北京 21°C。温差 7°C（12.6°F），深圳更热。建议你带薄外套去北京。" },
    ],
  });

  const agent = createAgent({
    name: "demo-weather",
    model: "mock:demo",
    instructions: "You are a weather analyst. Use tools before answering.",
    tools: [calculatorTool, datetimeTool],
    registry: { resolve: () => ({ provider, model: "mock:demo" }) },
  });

  process.stdout.write("AetherFlow offline demo — no API key required\n");
  process.stdout.write("Question: 比较深圳和北京的气温（已知深圳 28°C、北京 21°C），温差是多少华氏度？\n\n");

  const tracer = new Tracer();
  await renderRun(agent.stream({ input: "比较两地气温", runId: "demo" }), {
    verbose: true,
    json: false,
    runId: "demo",
    tracer,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const command = flags._[0] ?? "run";

  if (flags["h"] === true || flags["help"] === true) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  switch (command) {
    case "run":
      await runCommand(flags);
      break;
    case "repl":
      await replCommand(flags);
      break;
    case "demo":
      await demoCommand();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nFatal: ${message}\n`);
  process.exitCode = 1;
});
