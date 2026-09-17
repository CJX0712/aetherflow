/**
 * 文件系统工具。
 *
 * 安全模型：所有路径经 `resolve` 后必须仍位于 rootDir 之内，
 * 以此阻断 `../` 穿越。这是 Agent 拥有文件能力时的最低安全基线。
 */

import { mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { defineTool, type AnyTool } from "../tool.js";
import { z } from "zod";

export interface FileSystemToolsOptions {
  /** 允许访问的根目录，默认 process.cwd()。 */
  readonly rootDir?: string;
  /** 单文件最大读取字节数，默认 256KB。 */
  readonly maxReadBytes?: number;
  /** 写操作是否需要审批，默认 false。 */
  readonly requireApprovalForWrites?: boolean;
}

const DEFAULT_MAX_READ_BYTES = 256 * 1024;

export function createFileSystemTools(options: FileSystemToolsOptions = {}): AnyTool[] {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const writesNeedApproval = options.requireApprovalForWrites ?? false;

  /** 把用户提供的路径解析为受控绝对路径；越界直接抛错。 */
  const safePath = (input: string): string => {
    const resolved = resolve(rootDir, input);
    if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) {
      throw new Error(`Path "${input}" is outside the allowed root directory (${rootDir})`);
    }
    return resolved;
  };

  const readTool = defineTool({
    name: "fs_read",
    description:
      "Read the contents of a file within the workspace. Returns UTF-8 text. " +
      "Large files are truncated to the configured limit.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file, relative to the workspace root"),
      offset: z.number().int().min(0).optional().describe("Line offset to start reading from"),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
    }),
    execute: async ({ path, offset, limit }) => {
      const target = safePath(path);
      const info = await stat(target);
      if (info.isDirectory()) {
        throw new Error(`"${path}" is a directory. Use fs_list instead.`);
      }
      if (info.size > maxReadBytes) {
        const handle = await readFile(target, "utf8");
        return {
          path,
          size: info.size,
          truncated: true,
          content: handle.slice(0, maxReadBytes),
        };
      }
      let content = await readFile(target, "utf8");
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split("\n");
        content = lines.slice(offset ?? 0, limit !== undefined ? (offset ?? 0) + limit : undefined).join("\n");
      }
      return { path, size: info.size, truncated: false, content };
    },
  });

  const writeTool = defineTool({
    name: "fs_write",
    description:
      "Write text content to a file, creating parent directories as needed. " +
      "Existing files are overwritten unless append is true.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file, relative to the workspace root"),
      content: z.string().describe("The full text content to write"),
      append: z.boolean().optional().describe("Append instead of overwrite"),
    }),
    execute: async ({ path, content, append }) => {
      const target = safePath(path);
      await mkdir(dirname(target), { recursive: true });
      if (append) {
        const existing = await readFile(target, "utf8").catch(() => "");
        await writeFile(target, existing + content, "utf8");
      } else {
        await writeFile(target, content, "utf8");
      }
      const info = await stat(target);
      return { path, bytesWritten: info.size, appended: append ?? false };
    },
    ...(writesNeedApproval ? { requiresApproval: true as const } : {}),
  });

  const listTool = defineTool({
    name: "fs_list",
    description:
      "List files and directories at a path. Use recursive=true to walk the tree " +
      "(depth-limited to avoid runaway output).",
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path, relative to the workspace root"),
      recursive: z.boolean().default(false).describe("Whether to list recursively"),
      maxEntries: z.number().int().min(1).default(200).describe("Maximum number of entries"),
    }),
    execute: async ({ path, recursive, maxEntries }) => {
      const target = safePath(path);
      const entries: Array<{ path: string; type: string; size?: number }> = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (entries.length >= maxEntries || depth > 6) return;
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (entries.length >= maxEntries) return;
          const full = resolve(dir, item.name);
          const relative = full.slice(rootDir.length).replace(/^[/\\]/, "");
          if (item.isDirectory()) {
            entries.push({ path: relative, type: "directory" });
            if (recursive) await walk(full, depth + 1);
          } else {
            const info = await stat(full).catch(() => undefined);
            entries.push({ path: relative, type: "file", size: info?.size });
          }
        }
      };

      await walk(target, 0);
      return { path, count: entries.length, entries };
    },
  });

  const deleteTool = defineTool({
    name: "fs_delete",
    description: "Delete a file or directory. Requires approval.",
    inputSchema: z.object({
      path: z.string().describe("Path to delete, relative to the workspace root"),
    }),
    execute: async ({ path }) => {
      const target = safePath(path);
      await rm(target, { recursive: true, force: true });
      return { path, deleted: true };
    },
    requiresApproval: true,
  });

  return [readTool, writeTool, listTool, deleteTool];
}
