/**
 * 评测（Eval）框架。
 *
 * 没有评测的 Agent 工程等于没有测试的软件工程。这里吸收业界已形成共识的做法
 * （OpenAI Evals / Anthropic 的 LLM-as-judge），提供三层判定：
 *  1. 确定性断言 —— 结构化输出比对、关键词包含性，快且稳定
 *  2. 自定义断言 —— 任意业务规则
 *  3. 模型评审 —— 对开放式输出按 rubric 打分（0–1），处理"说不清对错"的任务
 *
 * 全部用例可并发执行，并统计成本 —— 让你知道一次回归到底花了多少钱。
 */

import { mapLimit } from "../core/task.js";
import { z } from "zod";
import { createAgent, type Agent } from "../agent/agent.js";
import type { AgentConfig, RunOptions, RunResult } from "../agent/types.js";

export interface JudgeConfig {
  readonly rubric: string;
  /** 通过阈值，默认 0.7。 */
  readonly minScore?: number;
  /** 评审模型；默认沿用被测 Agent 的模型。 */
  readonly model?: string;
  readonly registry?: AgentConfig["registry"];
}

export interface EvalAssertion<O> {
  readonly output: O | undefined;
  readonly text: string;
  readonly result: RunResult<O>;
}

export interface EvalCase<O = unknown> {
  readonly name: string;
  readonly input: string;
  /** 期望的结构化输出（深度比较）。 */
  readonly expected?: O;
  /** 输出文本必须包含的子串。 */
  readonly contains?: readonly string[];
  /** 输出文本不得包含的子串。 */
  readonly notContains?: readonly string[];
  /** 自定义断言；返回 true 通过，返回 string 视为失败原因。 */
  readonly assert?: (value: EvalAssertion<O>) => boolean | string | Promise<boolean | string>;
  /** 模型评审配置。 */
  readonly judge?: JudgeConfig;
  /** 单用例成本上限。 */
  readonly maxCostUsd?: number;
  readonly maxSteps?: number;
  readonly runOptions?: RunOptions;
}

export interface EvalCaseResult<O = unknown> {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string | undefined;
  readonly score: number | undefined;
  readonly result: RunResult<O>;
  readonly durationMs: number;
}

export interface EvalReport<O = unknown> {
  readonly name: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly results: readonly EvalCaseResult<O>[];
}

export interface EvalSuiteConfig<O = unknown> {
  readonly name: string;
  readonly agent: Agent<O>;
  readonly cases: readonly EvalCase<O>[];
  /** 并发执行用例数，默认 4。 */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  /** 传给每个用例的公共运行选项。 */
  readonly runOptions?: RunOptions;
}

const judgmentSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Score from 0 (utterly fails) to 1 (perfectly satisfies the rubric)"),
  reason: z.string().describe("One or two sentences explaining the score"),
});

export async function runEvalSuite<O>(config: EvalSuiteConfig<O>): Promise<EvalReport<O>> {
  const startedAt = Date.now();
  const concurrency = config.concurrency ?? 4;

  const outcomes = await mapLimit(
    config.cases,
    concurrency,
    async (_case, _index, signal) => {
      const testCase = _case as EvalCase<O>;
      const caseStartedAt = Date.now();
      const runOptions: RunOptions = {
        ...(config.runOptions ?? {}),
        ...(testCase.runOptions ?? {}),
        signal,
        ...(testCase.maxSteps !== undefined ? { maxSteps: testCase.maxSteps } : {}),
      };

      const result = await config.agent.run({ input: testCase.input, ...runOptions });
      const verdict = await evaluateCase(testCase, result, config);
      return {
        name: testCase.name,
        passed: verdict.passed,
        reason: verdict.reason,
        score: verdict.score,
        result,
        durationMs: Date.now() - caseStartedAt,
      } satisfies EvalCaseResult<O>;
    },
    { ...(config.signal ? { signal: config.signal } : {}), failFast: false },
  );

  const results = outcomes.map((outcome, index) => {
    if (outcome.ok) return outcome.value;
    const testCase = config.cases[index]!;
    return {
      name: testCase.name,
      passed: false,
      reason: `Case failed to execute: ${outcome.error.message}`,
      score: undefined,
      result: emptyFailedResult<O>(config.agent.name, outcome.error),
      durationMs: 0,
    } satisfies EvalCaseResult<O>;
  });

  return {
    name: config.name,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    totalCostUsd: results.reduce((sum, r) => sum + r.result.costUsd, 0),
    totalDurationMs: Date.now() - startedAt,
    results,
  };
}

async function evaluateCase<O>(
  testCase: EvalCase<O>,
  result: RunResult<O>,
  config: EvalSuiteConfig<O>,
): Promise<{ passed: boolean; reason?: string; score?: number }> {
  const reasons: string[] = [];

  if (result.error && result.finishReason === "error") {
    return { passed: false, reason: `Run failed: ${result.error.message}`, score: 0 };
  }

  if (testCase.maxCostUsd !== undefined && result.costUsd > testCase.maxCostUsd) {
    reasons.push(`Cost ${result.costUsd.toFixed(4)} exceeds limit ${testCase.maxCostUsd}`);
  }

  if (testCase.expected !== undefined) {
    if (!deepEqual(result.output, testCase.expected)) {
      reasons.push(
        `Output mismatch.\n  expected: ${JSON.stringify(testCase.expected)}\n  received: ${JSON.stringify(result.output)}`,
      );
    }
  }

  for (const needle of testCase.contains ?? []) {
    if (!result.text.includes(needle)) reasons.push(`Output does not contain "${needle}"`);
  }
  for (const needle of testCase.notContains ?? []) {
    if (result.text.includes(needle)) reasons.push(`Output should not contain "${needle}"`);
  }

  if (testCase.assert) {
    const verdict = await testCase.assert({ output: result.output, text: result.text, result });
    if (verdict !== true) reasons.push(typeof verdict === "string" ? verdict : "Custom assertion failed");
  }

  let score: number | undefined;
  if (testCase.judge) {
    const judged = await runJudge(testCase.judge, result, config);
    score = judged.score;
    const minScore = testCase.judge.minScore ?? 0.7;
    if (judged.score < minScore) {
      reasons.push(`Judge score ${judged.score.toFixed(2)} < ${minScore}: ${judged.reason}`);
    }
  }

  return reasons.length > 0
    ? { passed: false, reason: reasons.join("\n"), ...(score !== undefined ? { score } : {}) }
    : { passed: true, ...(score !== undefined ? { score } : {}) };
}

async function runJudge<O>(
  judge: JudgeConfig,
  result: RunResult<O>,
  config: EvalSuiteConfig<O>,
): Promise<{ score: number; reason: string }> {
  const judgeAgent = createAgent<{ score: number; reason: string }>({
    name: "judge",
    model: judge.model ?? config.agent.config.model,
    instructions:
      "You are a strict evaluator. Score the candidate answer against the rubric. " +
      "Be objective and consistent; ignore style, judge only substance.",
    output: judgmentSchema,
    ...(judge.registry ? { registry: judge.registry } : {}),
  });

  const verdict = await judgeAgent.run({
    input:
      `## Rubric\n${judge.rubric}\n\n` +
      `## Candidate answer\n${result.output !== undefined ? JSON.stringify(result.output) : result.text}`,
    ...(config.signal ? { signal: config.signal } : {}),
  });

  if (!verdict.output) return { score: 0, reason: "Judge produced no verdict" };
  return { score: verdict.output.score, reason: verdict.output.reason };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function emptyFailedResult<O>(agentName: string, error: Error): RunResult<O> {
  return {
    runId: "",
    agentName,
    output: undefined,
    text: "",
    messages: [],
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    costUsd: 0,
    finishReason: "error",
    error,
    durationMs: 0,
  };
}

/** 把评测报告渲染为终端友好的表格文本。 */
export function formatEvalReport(report: EvalReport<unknown>): string {
  const lines: string[] = [];
  lines.push(`Eval suite: ${report.name}`);
  lines.push(
    `  ${report.passed}/${report.total} passed, ${report.failed} failed | ` +
      `cost $${report.totalCostUsd.toFixed(4)} | ${report.totalDurationMs}ms`,
  );
  lines.push("");
  for (const result of report.results) {
    const mark = result.passed ? "✓" : "✗";
    const score = result.score !== undefined ? ` (score ${result.score.toFixed(2)})` : "";
    lines.push(`${mark} ${result.name}${score} — ${result.durationMs}ms`);
    if (!result.passed && result.reason) {
      for (const line of result.reason.split("\n")) lines.push(`    ${line}`);
    }
  }
  return lines.join("\n");
}
