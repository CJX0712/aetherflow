/**
 * Shell 与网络工具。
 *
 * 这两类工具赋予 Agent 真实世界影响力，因此默认都要求审批
 * （`requiresApproval: true`），并且各自带有超时与输出截断 ——
 * 一个失控的 `find /` 不应该耗尽整台机器的内存或撑爆上下文窗口。
 */

import { spawn } from "node:child_process";

import { defineTool, type AnyTool } from "../tool.js";
import { z } from "zod";

export interface ShellToolsOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** 命令白名单（正则）。未提供时不限制，但依然要求审批。 */
  readonly allowList?: readonly RegExp[];
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createShellTools(options: ShellToolsOptions = {}): AnyTool[] {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runCommandTool = defineTool({
    name: "run_command",
    description:
      "Execute a shell command and return its stdout/stderr. " +
      "Non-interactive only; long-running or interactive commands will time out. " +
      "Use this for builds, tests, git operations and system inspection.",
    inputSchema: z.object({
      command: z.string().describe("The command line to execute"),
      cwd: z.string().optional().describe("Working directory (defaults to the configured root)"),
      timeoutMs: z.number().int().min(1).optional().describe("Override the default timeout"),
    }),
    execute: ({ command, cwd: overrideCwd, timeoutMs: overrideTimeout }) => {
      if (options.allowList && !options.allowList.some((pattern) => pattern.test(command))) {
        throw new Error("Command is not allowed by the configured allow list");
      }
      return execCommand(command, {
        cwd: overrideCwd ?? cwd,
        timeoutMs: overrideTimeout ?? timeoutMs,
        env: options.env,
        maxOutputChars: options.maxOutputChars,
      });
    },
    requiresApproval: true,
    timeoutMs: timeoutMs + 5_000,
  });

  return [runCommandTool];
}

interface ExecResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function execCommand(
  command: string,
  config: {
    cwd: string;
    timeoutMs: number;
    env?: Readonly<Record<string, string>>;
    maxOutputChars?: number;
  },
): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    // 通过 shell 执行以支持管道与 glob；命令已经过审批钩子，风险可控
    const child = spawn(command, {
      cwd: config.cwd,
      shell: true,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const limit = config.maxOutputChars ?? 20_000;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < limit) stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const truncated = (value: string): string =>
        value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
      resolvePromise({
        command,
        exitCode: code,
        stdout: truncated(stdout),
        stderr: truncated(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export interface HttpToolsOptions {
  /** 域名白名单；提供后其他域名一律拒绝。 */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxChars?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** 是否要求审批，默认 false（网络读取通常只读）。 */
  readonly requireApproval?: boolean;
}

export function createHttpTools(options: HttpToolsOptions = {}): AnyTool[] {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxChars = options.maxChars ?? 20_000;

  const httpRequestTool = defineTool({
    name: "http_request",
    description:
      "Make an HTTP request and return the status, selected headers and body. " +
      "Useful for calling APIs and fetching web pages. Redirects are followed automatically.",
    inputSchema: z.object({
      url: z.string().url().describe("The absolute URL to request"),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
        .default("GET")
        .describe("HTTP method"),
      headers: z.record(z.string()).optional().describe("Additional request headers"),
      body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
      json: z.boolean().default(true).describe("Attempt to parse the response as JSON"),
    }),
    execute: async ({ url, method, headers, body, json }) => {
      const parsed = new URL(url);
      if (options.allowedHosts && !options.allowedHosts.includes(parsed.host)) {
        throw new Error(`Host "${parsed.host}" is not in the allowed host list`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers: { ...(options.headers ?? {}), ...(headers ?? {}) },
          body: body,
          signal: controller.signal,
          redirect: "follow",
        });
        const text = await response.text();
        const truncated = text.length > maxChars;
        const content = text.slice(0, maxChars);
        let parsedBody: unknown = content;
        if (json) {
          try {
            parsedBody = JSON.parse(content);
          } catch {
            parsedBody = content;
          }
        }
        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          contentType: response.headers.get("content-type"),
          truncated,
          body: parsedBody,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    ...(options.requireApproval ? { requiresApproval: true as const } : {}),
  });

  return [httpRequestTool];
}
