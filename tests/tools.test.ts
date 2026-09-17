import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { calculatorTool, evaluateExpression } from "../src/tools/builtin/calculator.js";
import { createFileSystemTools } from "../src/tools/builtin/filesystem.js";
import { createHttpTools } from "../src/tools/builtin/shell.js";
import { datetimeTool } from "../src/tools/builtin/index.js";
import { toJsonSchema, toStrictJsonSchema } from "../src/tools/schema.js";
import { ToolRegistry, defineTool, serializeOutput, type AnyTool } from "../src/tools/tool.js";

const context = {
  signal: new AbortController().signal,
  callId: "call_test",
  agentName: "test",
};

function registryWith(...tools: AnyTool[]) {
  return new ToolRegistry().registerAll(tools);
}

describe("calculator", () => {
  it("respects operator precedence", () => {
    expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
    expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512); // 右结合
    expect(evaluateExpression("-3 + 5")).toBe(2);
    expect(evaluateExpression("10 % 3")).toBe(1);
  });

  it("supports functions and constants", () => {
    expect(evaluateExpression("sqrt(16)")).toBe(4);
    expect(evaluateExpression("max(1, 7, 3)")).toBe(7);
    expect(evaluateExpression("pi")).toBeCloseTo(Math.PI, 10);
    expect(evaluateExpression("round(3.7)")).toBe(4);
  });

  it("rejects division by zero", () => {
    expect(() => evaluateExpression("1 / 0")).toThrow(/Division by zero/);
  });

  it("cannot execute injected code", () => {
    // 这是关键安全属性：表达式解析器只接受数学子集
    expect(() => evaluateExpression("process.exit(1)")).toThrow();
    expect(() => evaluateExpression("require('fs')")).toThrow();
    expect(() => evaluateExpression("1; console.log('pwned')")).toThrow();
    expect(() => evaluateExpression("globalThis")).toThrow();
  });

  it("works through the tool interface", async () => {
    const registry = registryWith(calculatorTool);
    const result = await registry.execute({ id: "1", name: "calculator", args: { expression: "6 * 7" } }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({ expression: "6 * 7", result: 42 });
  });
});

describe("zod to JSON schema", () => {
  it("converts primitives, enums and nesting", () => {
    const schema = z.object({
      name: z.string().describe("The name"),
      age: z.number().int().min(0).max(150),
      tags: z.array(z.string()),
      role: z.enum(["admin", "user"]),
      address: z.object({ city: z.string(), zip: z.string().optional() }),
    });

    const json = toJsonSchema(schema);
    expect(json.type).toBe("object");
    const properties = json.properties as Record<string, Record<string, unknown>>;
    expect(properties["name"]?.description).toBe("The name");
    expect(properties["age"]?.type).toBe("integer");
    expect(properties["age"]?.minimum).toBe(0);
    expect(properties["tags"]?.type).toBe("array");
    expect(properties["role"]?.enum).toEqual(["admin", "user"]);
    expect(json.required).toEqual(["name", "age", "tags", "role", "address"]);
    expect((properties["address"]?.properties as Record<string, unknown>)["city"]).toBeDefined();
  });

  it("marks optional fields as not required", () => {
    const json = toJsonSchema(z.object({ a: z.string(), b: z.string().optional() }));
    expect(json.required).toEqual(["a"]);
  });

  it("produces strict schemas for OpenAI strict mode", () => {
    const json = toStrictJsonSchema(z.object({ a: z.string(), b: z.string().optional() }));
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toHaveLength(2);
  });

  it("handles defaults, unions and nullable", () => {
    const json = toJsonSchema(
      z.object({
        mode: z.union([z.literal("fast"), z.literal("slow")]),
        note: z.string().nullable(),
        count: z.number().default(3),
      }),
    );
    expect(json.properties).toBeDefined();
    expect((json.properties as Record<string, Record<string, unknown>>)["mode"]).toBeDefined();
    expect(json.required).toEqual(["mode", "note"]); // 有默认值（count）的字段不必填
  });
});

describe("tool registry", () => {
  const echo = defineTool({
    name: "echo",
    description: "Echoes the message",
    inputSchema: z.object({ message: z.string() }),
    execute: ({ message }) => `echo: ${message}`,
  });

  it("returns a helpful error for unknown tools", async () => {
    const registry = registryWith(echo);
    const result = await registry.execute({ id: "1", name: "nope", args: {} }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("does not exist");
    expect(result.output).toContain("echo"); // 提示可用工具，帮助模型自我修正
  });

  it("validates arguments and reports issues", async () => {
    const registry = registryWith(echo);
    const result = await registry.execute({ id: "1", name: "echo", args: { message: 42 } }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid arguments");
  });

  it("captures thrown errors instead of propagating", async () => {
    const boom = defineTool({
      name: "boom",
      description: "Always fails",
      inputSchema: z.object({}),
      execute: () => {
        throw new Error("exploded");
      },
    });
    const registry = registryWith(boom);
    const result = await registry.execute({ id: "1", name: "boom", args: {} }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("exploded");
  });

  it("enforces per-tool timeouts", async () => {
    const slow = defineTool({
      name: "slow",
      description: "Too slow",
      inputSchema: z.object({}),
      timeoutMs: 10,
      execute: () => new Promise((resolve) => setTimeout(() => resolve("done"), 500)),
    });
    const registry = registryWith(slow);
    const result = await registry.execute({ id: "1", name: "slow", args: {} }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out");
  });

  it("requires approval for gated tools", async () => {
    const risky = defineTool({
      name: "risky",
      description: "Needs approval",
      inputSchema: z.object({}),
      requiresApproval: true,
      execute: () => "executed",
    });
    const registry = new ToolRegistry({
      approvalHandler: () => "deny",
    }).register(risky);

    const result = await registry.execute({ id: "1", name: "risky", args: {} }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("denied");

    const approved = new ToolRegistry({ approvalHandler: () => "approve" }).register(risky);
    const okResult = await approved.execute({ id: "1", name: "risky", args: {} }, context);
    expect(okResult.isError).toBe(false);
  });

  it("truncates oversized output", async () => {
    const big = defineTool({
      name: "big",
      description: "Huge output",
      inputSchema: z.object({}),
      maxOutputChars: 20,
      execute: () => "y".repeat(1_000),
    });
    const registry = registryWith(big);
    const result = await registry.execute({ id: "1", name: "big", args: {} }, context);
    expect(result.output.length).toBeLessThan(100);
    expect(result.output).toContain("truncated");
  });

  it("executes many calls concurrently", async () => {
    const registry = registryWith(echo);
    const results = await registry.executeMany(
      [
        { id: "1", name: "echo", args: { message: "a" } },
        { id: "2", name: "echo", args: { message: "b" } },
        { id: "3", name: "echo", args: { message: "c" } },
      ],
      context,
      3,
    );
    expect(results.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(results[0]?.output).toBe("echo: a");
  });

  it("exposes specs for the model", () => {
    const registry = registryWith(echo);
    const [spec] = registry.specs();
    expect(spec?.name).toBe("echo");
    expect(spec?.parameters.type).toBe("object");
  });
});

describe("filesystem tools", () => {
  const root = mkdtempSync(join(tmpdir(), "aetherflow-fs-"));
  writeFileSync(join(root, "hello.txt"), "hello world");

  it("reads files inside the root", async () => {
    const registry = registryWith(...createFileSystemTools({ rootDir: root }));
    const result = await registry.execute({ id: "1", name: "fs_read", args: { path: "hello.txt" } }, context);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello world");
  });

  it("blocks path traversal outside the root", async () => {
    const registry = registryWith(...createFileSystemTools({ rootDir: root }));
    const result = await registry.execute(
      { id: "1", name: "fs_read", args: { path: "../../etc/passwd" } },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the allowed root");
  });

  it("writes and lists files", async () => {
    const registry = registryWith(...createFileSystemTools({ rootDir: root }));
    await registry.execute(
      { id: "1", name: "fs_write", args: { path: "nested/out.txt", content: "written" } },
      context,
    );
    const listed = await registry.execute({ id: "2", name: "fs_list", args: { path: ".", recursive: true } }, context);
    expect(listed.output).toContain("nested");
  });
});

describe("utility tools", () => {
  it("reports the current time in a timezone", async () => {
    const registry = registryWith(datetimeTool);
    const result = await registry.execute(
      { id: "1", name: "current_datetime", args: { timeZone: "Asia/Shanghai" } },
      context,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.timeZone).toBe("Asia/Shanghai");
  });

  it("http tool respects the host allow list", async () => {
    const registry = registryWith(...createHttpTools({ allowedHosts: ["api.example.com"] }));
    const result = await registry.execute(
      { id: "1", name: "http_request", args: { url: "https://evil.example.com/x", method: "GET" } },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not in the allowed host list");
  });
});

describe("output serialization", () => {
  it("stringifies objects and truncates", () => {
    expect(serializeOutput({ a: 1 })).toContain('"a": 1');
    expect(serializeOutput("plain")).toBe("plain");
    expect(serializeOutput("z".repeat(100), 10).length).toBeLessThan(60);
  });
});
