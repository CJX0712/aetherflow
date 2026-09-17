/**
 * 多智能体编排：委派、交接与并行。
 *
 * 三种协作模式对应三类真实需求：
 *  - **委派（agentAsTool）**：主 Agent 把子任务整个甩给专家，拿到结果继续 —— 上下文隔离，成本可控
 *  - **交接（handoff）**：按领域分流，由路由 Agent 决定交给谁 —— 适合客服、分诊类场景
 *  - **并行（runParallel）**：多个 Agent 同时处理同一输入，取全部或最优结果 —— 适合冗余校验与头脑风暴
 */

import { mapLimit } from "../core/task.js";
import type { AnyTool } from "../tools/tool.js";
import { defineTool } from "../tools/tool.js";
import { z } from "zod";
import { createAgent, type Agent } from "./agent.js";
import type { RunOptions, RunResult } from "./types.js";

export interface AgentAsToolOptions {
  /** 覆盖工具名（默认使用 agent 名）。 */
  readonly name?: string;
  readonly description?: string;
  /** 传给子 Agent 的额外运行选项。 */
  readonly runOptions?: Omit<RunOptions, "input">;
}

/**
 * 把 Agent 包装成工具。
 * 子 Agent 拥有独立的消息历史 —— 这是控制上下文膨胀最有效的手段：
 * 主 Agent 只看到子任务的结果摘要，而非子任务内部的十几轮工具往返。
 */
export function agentAsTool<O>(
  agent: Agent<O>,
  options: AgentAsToolOptions = {},
): AnyTool {
  return defineTool({
    name: options.name ?? `ask_${agent.name}`,
    description:
      options.description ??
      `Delegate a sub-task to the "${agent.name}" agent and get its result. ` +
        `Use this to keep your own context small: send a self-contained task description.`,
    inputSchema: z.object({
      task: z
        .string()
        .describe("A complete, self-contained description of the sub-task for this agent"),
    }),
    execute: async ({ task }, context) => {
      const result = await agent.run({
        input: task,
        signal: context.signal,
        ...(options.runOptions ?? {}),
      });
      return {
        output: result.output ?? result.text,
        text: result.text,
        steps: result.steps,
        finishReason: result.finishReason,
        ...(result.error ? { error: result.error.message } : {}),
      };
    },
  });
}

/**
 * 生成一组交接工具（每个目标 Agent 一个）。
 * 与委派的区别在于语义：交接意味着「这件事归别人管」，
 * 路由 Agent 的指令应当只包含分流判断，不应自己动手解决。
 */
export function createHandoffTools(
  agents: Readonly<Record<string, Agent<unknown>>>,
  options: { readonly prefix?: string } = {},
): AnyTool[] {
  const prefix = options.prefix ?? "transfer_to_";
  return Object.entries(agents).map(([key, agent]) =>
    defineTool({
      name: `${prefix}${key}`,
      description: `Transfer control to the "${agent.name}" agent. ${
        agent.config.description ?? ""
      } Provide the task description and any context the receiving agent needs.`,
      inputSchema: z.object({
        task: z.string().describe("What the receiving agent should do"),
        context: z.string().optional().describe("Relevant context gathered so far"),
      }),
      execute: async ({ task, context: handedOff }, toolContext) => {
        const result = await agent.run({
          input: handedOff ? `${task}\n\nContext:\n${handedOff}` : task,
          signal: toolContext.signal,
        });
        return { output: result.output ?? result.text, text: result.text };
      },
    }),
  );
}

export interface ParallelRunOptions extends Omit<RunOptions, "input"> {
  readonly concurrency?: number;
  /** 是否在一个 Agent 失败时取消其余（默认 false，收集全部结果）。 */
  readonly failFast?: boolean;
}

/**
 * 并行运行多个 Agent。
 * 用 mapLimit 而非 Promise.all：可限制并发，且中断时已启动的 Agent 会被取消，
 * 不会留下继续烧钱的孤儿任务。
 */
export async function runParallel<O>(
  agents: readonly Agent<O>[],
  input: string,
  options: ParallelRunOptions = {},
): Promise<readonly RunResult<O>[]> {
  const { concurrency, failFast = false, ...runOptions } = options;
  const results = await mapLimit(
    agents,
    concurrency ?? agents.length,
    (agent, _index, signal) => agent.run({ input, signal, ...runOptions }),
    { ...(options.signal ? { signal: options.signal } : {}), failFast },
  );
  return results.map((result, index) => {
    if (result.ok) return result.value;
    const agent = agents[index]!;
    return {
      runId: "",
      agentName: agent.name,
      output: undefined,
      text: "",
      messages: [],
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      finishReason: "error" as const,
      error: result.error,
      durationMs: 0,
    } satisfies RunResult<O>;
  });
}

/**
 * 构建「主管 + 专家」模式：主管只负责拆解与分发，具体执行委派给专家。
 * 这是目前业界验证过的最稳定的多智能体形态（相比自由对话式多智能体，
 * 它的上下文开销可控、失败可定位）。
 */
export function createSupervisor(config: {
  readonly name?: string;
  readonly model: string;
  readonly instructions?: string;
  readonly experts: readonly Agent<unknown>[];
  readonly maxSteps?: number;
  readonly registry?: Agent<unknown>["config"]["registry"];
  readonly tools?: readonly AnyTool[];
}): Agent<unknown> {
  const expertTools = config.experts.map((expert) => agentAsTool(expert));
  return createAgent({
    name: config.name ?? "supervisor",
    model: config.model,
    instructions:
      config.instructions ??
      "You are a supervisor. Break the user's request into sub-tasks and delegate each one " +
        "to the most suitable expert agent. Never do the expert's work yourself. " +
        "Synthesize the experts' results into a single coherent answer.",
    tools: [...expertTools, ...(config.tools ?? [])],
    ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
    ...(config.registry ? { registry: config.registry } : {}),
  });
}
