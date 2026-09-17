/**
 * Plan-and-Execute 编排。
 *
 * 与 ReAct 的区别：ReAct 是「走一步看一步」，Plan-Execute 先产出完整计划再逐步执行。
 * 优势：
 *  - 计划可见、可审计、可被人类修改（长任务的生产可控性关键）
 *  - 每步执行上下文只包含「当前步骤 + 已完成的步骤摘要」，上下文增长接近常数
 * 劣势：计划僵化，遇到意外需要 replan；这里通过 `replanEvery` 提供周期性重规划。
 */

import { z } from "zod";
import type { AnyTool } from "../tools/tool.js";
import { createAgent, type Agent } from "./agent.js";
import type { AgentConfig, RunOptions, RunResult } from "./types.js";

export const planStepSchema = z.object({
  title: z.string().describe("Short title of the step"),
  instruction: z.string().describe("A self-contained instruction for executing this step"),
  rationale: z.string().optional().describe("Why this step is needed"),
});

export const planSchema = z.object({
  goal: z.string().describe("Restate the user's goal in one sentence"),
  steps: z.array(planStepSchema).min(1).describe("Ordered list of steps to execute"),
});

export type PlanStep = z.infer<typeof planStepSchema>;
export type Plan = z.infer<typeof planSchema>;

export interface PlanExecuteConfig<O = unknown> {
  readonly model: string;
  readonly name?: string;
  readonly tools?: readonly AnyTool[];
  readonly plannerInstructions?: string;
  readonly executorInstructions?: string;
  readonly maxSteps?: number;
  readonly maxStepsPerTask?: number;
  readonly registry?: AgentConfig["registry"];
  readonly output?: z.ZodType<O>;
  /** 每执行 N 步后基于已有结果重新规划剩余步骤；0 表示不重规划。 */
  readonly replanEvery?: number;
  readonly hooks?: AgentConfig["hooks"];
}

export interface PlanExecuteResult<O = unknown> {
  readonly plan: Plan;
  readonly stepResults: readonly RunResult<string>[];
  readonly result: RunResult<O>;
  readonly totalCostUsd: number;
}

export async function planAndExecute<O = unknown>(
  config: PlanExecuteConfig<O>,
  input: string,
  options: RunOptions = {},
): Promise<PlanExecuteResult<O>> {
  const planner: Agent<Plan> = createAgent<Plan>({
    name: `${config.name ?? "planner"}-planner`,
    model: config.model,
    instructions:
      config.plannerInstructions ??
      "You are a meticulous planner. Given a goal, produce a concise, ordered plan of " +
        "self-contained steps. Each step must be executable on its own and must state " +
        "exactly what to do. Prefer 3-8 steps; avoid steps that depend on hidden context.",
    output: planSchema,
    ...(config.registry ? { registry: config.registry } : {}),
  });

  const planRun = await planner.run({ input, ...options });
  let plan = planRun.output;
  if (!plan) {
    throw new Error(`Planner failed to produce a plan: ${planRun.error?.message ?? planRun.text}`);
  }

  const executor: Agent<string> = createAgent<string>({
    name: `${config.name ?? "planner"}-executor`,
    model: config.model,
    instructions:
      config.executorInstructions ??
      "You are an executor. Carry out the single step you are given, using the available " +
        "tools. Report only what you accomplished and any concrete findings — be concise " +
        "and factual, because your output feeds into later steps.",
    tools: config.tools ?? [],
    ...(config.maxStepsPerTask !== undefined ? { maxSteps: config.maxStepsPerTask } : {}),
    ...(config.registry ? { registry: config.registry } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
  });

  const stepResults: RunResult<string>[] = [];
  let totalCostUsd = planRun.costUsd;
  const stepLimit = config.maxSteps ?? plan.steps.length;

  for (let index = 0; index < Math.min(plan.steps.length, stepLimit); index++) {
    const step = plan.steps[index]!;
    if (options.signal?.aborted) break;

    const priorContext = stepResults
      .map((result, i) => `### Step ${i + 1}: ${plan!.steps[i]!.title}\n${result.text}`)
      .join("\n\n");

    const stepInput =
      `Goal: ${plan.goal}\n\n` +
      `Current step (${index + 1}/${plan.steps.length}): ${step.title}\n` +
      `${step.instruction}\n` +
      (priorContext ? `\nResults from previous steps:\n${priorContext}\n` : "");

    const result = await executor.run({ input: stepInput, ...options });
    stepResults.push(result);
    totalCostUsd += result.costUsd;

    // 周期性重规划：把已完成的事实固化进计划，修正后续路线
    const replanEvery = config.replanEvery ?? 0;
    if (replanEvery > 0 && (index + 1) % replanEvery === 0 && index + 1 < plan.steps.length) {
      const remaining = await planner.run({
        input:
          `Original goal: ${plan.goal}\n\n` +
          `Completed steps and their results:\n${priorContext}\n\n` +
          `Result of the step just finished:\n${result.text}\n\n` +
          `Remaining planned steps: ${plan.steps
            .slice(index + 1)
            .map((s) => s.title)
            .join("; ")}\n\n` +
          `Produce an updated plan for the REMAINING work only.`,
        ...options,
      });
      if (remaining.output) {
        plan = {
          goal: plan.goal,
          steps: [...plan.steps.slice(0, index + 1), ...remaining.output.steps],
        };
      }
      totalCostUsd += remaining.costUsd;
    }
  }

  const transcript = stepResults
    .map((result, i) => `### ${plan.steps[i]?.title ?? `Step ${i + 1}`}\n${result.text}`)
    .join("\n\n");

  const finalAgent: Agent<O> = createAgent<O>({
    name: `${config.name ?? "planner"}-synthesizer`,
    model: config.model,
    instructions:
      "You are a synthesizer. Given the user's goal and the results of each executed step, " +
        "produce the final deliverable. Be concrete and complete; do not mention 'steps'.",
    ...(config.output ? { output: config.output } : {}),
    ...(config.registry ? { registry: config.registry } : {}),
  });

  const result = await finalAgent.run({
    input: `Goal: ${input}\n\nExecution results:\n${transcript}`,
    ...options,
  });
  totalCostUsd += result.costUsd;

  return { plan, stepResults, result, totalCostUsd };
}
