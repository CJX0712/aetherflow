/**
 * zod → JSON Schema 转换。
 *
 * 为什么自研而不引入 zod-to-json-schema：
 *  - 转换结果需要针对 LLM 工具调用做专门优化（去掉 LLM 不需要的字段、
 *    保留 description 供模型理解语义、支持 OpenAI strict 模式的严格形态）
 *  - 少一个传递依赖，构建产物更小，也避免上游 breaking change 波及运行时
 */

import { z } from "zod";

import type { JsonSchema } from "../models/types.js";

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema, new Set());
}

/**
 * 生成 OpenAI strict mode 需要的严格 schema：
 * 所有字段都进入 required、additionalProperties 固定为 false。
 * 注意：strict 模式下不支持 optional，调用方需把可选字段改为 nullable。
 */
export function toStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const converted = toJsonSchema(schema);
  return enforceStrict(converted);
}

function enforceStrict(schema: JsonSchema): JsonSchema {
  const result: Record<string, unknown> = { ...schema };
  if (result["type"] === "object" || result["properties"]) {
    const properties = (result["properties"] ?? {}) as Record<string, JsonSchema>;
    result["additionalProperties"] = false;
    result["required"] = Object.keys(properties);
    result["properties"] = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, enforceStrict(value)]),
    );
  }
  if (result["type"] === "array" && result["items"]) {
    result["items"] = enforceStrict(result["items"] as JsonSchema);
  }
  delete result["default"];
  return result as JsonSchema;
}

function convert(schema: z.ZodTypeAny, seen: Set<z.ZodTypeAny>): JsonSchema {
  const description = schema.description;

  // 防止递归 schema（z.lazy 自引用）导致栈溢出
  if (seen.has(schema)) return { ...(description ? { description } : {}) };
  seen.add(schema);

  const def = schema._def as { typeName?: string; [key: string]: unknown };
  const typeName = def.typeName ?? "";

  let result: JsonSchema;
  switch (typeName) {
    case "ZodString": {
      const checks = (def["checks"] as Array<{ kind: string; value?: unknown }>) ?? [];
      const result0: Record<string, unknown> = { type: "string" };
      for (const check of checks) {
        switch (check.kind) {
          case "min":
            result0["minLength"] = check.value;
            break;
          case "max":
            result0["maxLength"] = check.value;
            break;
          case "regex":
            result0["pattern"] = String(check.value);
            break;
          case "email":
            result0["format"] = "email";
            break;
          case "url":
            result0["format"] = "uri";
            break;
          default:
            break;
        }
      }
      result = result0;
      break;
    }
    case "ZodNumber": {
      const checks = (def["checks"] as Array<{ kind: string; value?: unknown }>) ?? [];
      const result0: Record<string, unknown> = {
        type: (checks ?? []).some((c) => c.kind === "int") ? "integer" : "number",
      };
      for (const check of checks) {
        if (check.kind === "min") result0["minimum"] = check.value;
        if (check.kind === "max") result0["maximum"] = check.value;
      }
      result = result0;
      break;
    }
    case "ZodBoolean":
      result = { type: "boolean" };
      break;
    case "ZodNull":
      result = { type: "null" };
      break;
    case "ZodDate":
      result = { type: "string", format: "date-time" };
      break;
    case "ZodLiteral": {
      const value = (def["value"] as unknown) ?? null;
      result = {
        type: typeof value === "string" ? "string" : "string",
        enum: [value],
      };
      break;
    }
    case "ZodEnum":
      result = { type: "string", enum: [...((def["values"] as readonly string[]) ?? [])] };
      break;
    case "ZodNativeEnum":
      result = { type: "string", enum: Object.values((def["values"] as object) ?? {}) };
      break;
    case "ZodArray": {
      const itemSchema = def["type"] as z.ZodTypeAny;
      result = {
        type: "array",
        items: itemSchema ? convert(itemSchema, seen) : {},
      };
      break;
    }
    case "ZodTuple": {
      const items = (def["items"] as z.ZodTypeAny[]) ?? [];
      const convertedItems = items.map((i) => convert(i, seen));
      // JSON Schema 2020-12 用 prefixItems 表达元组；同时给出 items 以兼容仅支持 draft-07 的供应商
      result = {
        type: "array",
        prefixItems: convertedItems,
        items: convertedItems[0] ?? {},
      };
      break;
    }
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as z.ZodTypeAny;
        properties[key] = convert(fieldSchema, seen);
        if (!isOptionalish(fieldSchema)) required.push(key);
      }
      result = {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
      break;
    }
    case "ZodRecord": {
      const valueSchema = def["valueType"] as z.ZodTypeAny | undefined;
      result = {
        type: "object",
        additionalProperties: valueSchema ? convert(valueSchema, seen) : true,
      };
      break;
    }
    case "ZodUnion": {
      const options = (def["options"] as z.ZodTypeAny[]) ?? [];
      result = { anyOf: options.map((o) => convert(o, seen)) };
      break;
    }
    case "ZodDiscriminatedUnion": {
      const optionsMap = def["optionsMap"] as Map<unknown, z.ZodTypeAny> | undefined;
      const options = optionsMap ? [...optionsMap.values()] : [];
      result = { anyOf: options.map((o) => convert(o, seen)) };
      break;
    }
    case "ZodIntersection": {
      result = {
        allOf: [
          convert(def["left"] as z.ZodTypeAny, seen),
          convert(def["right"] as z.ZodTypeAny, seen),
        ],
      };
      break;
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodBranded":
    case "ZodReadonly":
    case "ZodEffects":
    case "ZodPipeline": {
      const inner = (def["innerType"] ?? def["schema"] ?? def["type"]) as z.ZodTypeAny | undefined;
      result = inner ? convert(inner, seen) : {};
      break;
    }
    case "ZodLazy": {
      const getter = def["getter"] as (() => z.ZodTypeAny) | undefined;
      result = getter ? convert(getter(), seen) : {};
      break;
    }
    case "ZodAny":
    case "ZodUnknown":
    default:
      result = {};
      break;
  }

  if (description) result = { ...result, description };
  seen.delete(schema);
  return result;
}

function isOptionalish(schema: z.ZodTypeAny): boolean {
  let current: z.ZodTypeAny | undefined = schema;
  while (current) {
    const def = current._def as { typeName?: string; innerType?: z.ZodTypeAny };
    if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault" || def.typeName === "ZodCatch") {
      return true;
    }
    current = def.innerType;
  }
  return false;
}

/** 从裸 JSON Schema 或 zod schema 统一取出 JsonSchema。 */
export function normalizeSchema(input: z.ZodTypeAny | JsonSchema): JsonSchema {
  if (input instanceof z.ZodType) return toJsonSchema(input);
  return input;
}

export { z };
