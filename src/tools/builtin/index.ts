/**
 * 内置工具集汇总。
 *
 * 设计原则：**能力默认关闭，按需授予**。文件系统、Shell、网络都有副作用，
 * 因此都通过工厂函数创建，调用方显式决定 workspace 范围、超时与审批策略。
 */

import { defineTool, type AnyTool } from "../tool.js";
import { z } from "zod";
import { calculatorTool } from "./calculator.js";
import { createFileSystemTools, type FileSystemToolsOptions } from "./filesystem.js";
import { createHttpTools, createShellTools, type HttpToolsOptions, type ShellToolsOptions } from "./shell.js";

export { calculatorTool, evaluateExpression } from "./calculator.js";
export { createFileSystemTools } from "./filesystem.js";
export type { FileSystemToolsOptions } from "./filesystem.js";
export { createShellTools, createHttpTools } from "./shell.js";
export type { ShellToolsOptions, HttpToolsOptions } from "./shell.js";

/** 获取当前时间。模型本身不知道"现在"，这个工具是时间推理的基础。 */
export const datetimeTool = defineTool({
  name: "current_datetime",
  description:
    "Get the current date and time in the specified IANA timezone, with the ISO-8601 UTC " +
    "representation. Use this whenever the task involves 'today', 'recent', or relative dates.",
  inputSchema: z.object({
    timeZone: z
      .string()
      .default("UTC")
      .describe("IANA timezone name, e.g. Asia/Shanghai, America/New_York, UTC"),
  }),
  execute: ({ timeZone }) => {
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        dateStyle: "full",
        timeStyle: "medium",
      }).format(now);
    } catch {
      local = now.toString();
    }
    return {
      iso: now.toISOString(),
      epochMs: now.getTime(),
      timeZone,
      local,
    };
  },
});

/** 让 Agent 显式"停下并给出答案"。与结构化输出配合效果最佳。 */
export function createFinalAnswerTool<T>(schema: z.ZodType<T>): AnyTool {
  return defineTool<any, any>({
    name: "final_answer",
    description:
      "Submit the final answer and end the run. Call this only when you are confident " +
      "the task is complete.",
    inputSchema: z.object({
      answer: schema.describe("The final structured answer"),
    }),
    execute: ({ answer }: { answer: T }) => ({ answer, final: true }),
  });
}

export interface BuiltinToolsOptions {
  readonly filesystem?: FileSystemToolsOptions | false;
  readonly shell?: ShellToolsOptions | false;
  readonly http?: HttpToolsOptions | false;
  /** 是否包含 calculator 与 datetime 这类只读工具，默认 true。 */
  readonly utilities?: boolean;
}

/** 一次性创建一组内置工具；传 false 可关闭对应能力。 */
export function createBuiltinTools(options: BuiltinToolsOptions = {}): AnyTool[] {
  const tools: AnyTool[] = [];

  if (options.utilities !== false) {
    tools.push(calculatorTool, datetimeTool);
  }
  if (options.filesystem !== false) {
    tools.push(...createFileSystemTools(options.filesystem ?? {}));
  }
  if (options.shell !== false) {
    tools.push(...createShellTools(options.shell ?? {}));
  }
  if (options.http !== false) {
    tools.push(...createHttpTools(options.http ?? {}));
  }

  return tools;
}
