/**
 * 模型网关统一出口。
 *
 * 典型用法：
 * ```ts
 * const registry = createDefaultRegistry();
 * const { provider, model } = registry.resolve("anthropic:claude-sonnet-4-20250514");
 * ```
 */

import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAICompatProvider, OPENAI_COMPAT_PRESETS } from "./openai.js";
import { lookupPricing } from "./pricing.js";
import { ModelRegistry } from "./registry.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./pricing.js";
export { createOpenAICompatProvider, OPENAI_COMPAT_PRESETS } from "./openai.js";
export type {
  OpenAICompatConfig,
  OpenAICompatPreset,
  OpenAIProviderOptions,
} from "./openai.js";
export { createAnthropicProvider } from "./anthropic.js";
export type { AnthropicProviderOptions } from "./anthropic.js";
export { createGeminiProvider } from "./gemini.js";
export type { GeminiProviderOptions } from "./gemini.js";
export { createMockProvider } from "./mock.js";
export type {
  MockProvider,
  MockProviderOptions,
  MockResponse,
  MockResponder,
} from "./mock.js";
export { parseSse, parseJsonLines, bytesOf } from "./sse.js";
export type { SseEvent } from "./sse.js";
export { requestJson, requestStream, mapHttpError, extractErrorMessage } from "./http.js";
export type { HttpResponse, RequestOptions, FetchLike } from "./http.js";

/**
 * 创建内置默认注册表。
 * 所有 provider 均为**惰性构造** —— 只有真正被 resolve 到时才会读取 API Key，
 * 因此缺少某个供应商的 Key 不会影响其他供应商的使用。
 */
export function createDefaultRegistry(): ModelRegistry {
  const registry = new ModelRegistry();

  for (const preset of Object.values(OPENAI_COMPAT_PRESETS)) {
    registry.register(preset.id, () =>
      createOpenAICompatProvider(preset, { pricing: lookupPricingAsTable() }),
    );
  }
  registry.register(
    "anthropic",
    () => createAnthropicProvider({ pricing: lookupPricingAsTable() }),
  );
  registry.register("gemini", () => createGeminiProvider({ pricing: lookupPricingAsTable() }));

  return registry;
}

/**
 * 把 `pricing(model)` 函数适配成 provider 期望的 `Record<string, Pricing>` 形状，
 * 通过 Proxy 惰性查表，避免一次性把价格表拷进每个 provider。
 */
function lookupPricingAsTable(): Readonly<Record<string, ReturnType<typeof lookupPricing> & {}>> {
  return new Proxy({} as Record<string, NonNullable<ReturnType<typeof lookupPricing>>>, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined;
      return lookupPricing(property);
    },
    has: (_target, property) =>
      typeof property === "string" && lookupPricing(property) !== undefined,
  });
}
