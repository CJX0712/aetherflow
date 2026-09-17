/**
 * 模型注册表：把 `"openai:gpt-4o"` 这样的字符串解析为 (provider, model)。
 *
 * 这是「零供应商锁定」的入口 —— 业务代码只依赖模型引用字符串，
 * 切换供应商（例如从 GPT-4o 换到 DeepSeek-V3 做成本优化）无需改动任何编排逻辑。
 */

import { AetherError } from "../core/errors.js";
import type { ModelProvider } from "./types.js";

export type ProviderEntry = ModelProvider | (() => ModelProvider);

export interface ResolvedModel {
  readonly provider: ModelProvider;
  readonly providerId: string;
  readonly model: string;
}

const PROVIDER_SEPARATOR = ":";

export class ModelRegistry {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly cache = new Map<string, ModelProvider>();

  register(id: string, entry: ProviderEntry): void {
    this.providers.set(id, entry);
    this.cache.delete(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()];
  }

  get(id: string): ModelProvider | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const entry = this.providers.get(id);
    if (!entry) return undefined;
    const provider = typeof entry === "function" ? entry() : entry;
    this.cache.set(id, provider);
    return provider;
  }

  /**
   * 解析模型引用。
   * 支持 `"provider:model"` 显式指定，也支持仅给模型名（按命名规则推断 provider）。
   */
  resolve(ref: string): ResolvedModel {
    const separatorIndex = ref.indexOf(PROVIDER_SEPARATOR);
    if (separatorIndex > 0) {
      const providerId = ref.slice(0, separatorIndex);
      const model = ref.slice(separatorIndex + 1);
      const provider = this.get(providerId);
      if (!provider) {
        throw new AetherError(
          "model_invalid_request",
          `Unknown provider "${providerId}". Registered: ${this.listProviders().join(", ") || "(none)"}`,
          { retryable: false },
        );
      }
      return { provider, providerId, model };
    }
    const providerId = inferProvider(ref);
    const provider = this.get(providerId);
    if (!provider) {
      throw new AetherError(
        "model_invalid_request",
        `Cannot infer provider for "${ref}". Use "provider:model" syntax.`,
        { retryable: false },
      );
    }
    return { provider, providerId, model: ref };
  }
}

/** 依据模型命名规则推断供应商。 */
const INFERENCE_RULES: readonly (readonly [RegExp, string])[] = [
  [/^(gpt-|chatgpt|o[1349](-|-mini|-pro)?|text-embedding|dall-e|omni)/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^gemini/i, "gemini"],
  [/^deepseek/i, "deepseek"],
  [/^(kimi|moonshot)/i, "moonshot"],
  [/^qwen/i, "qwen"],
  [/^(glm|charglm|codegeex)/i, "zhipu"],
  [/^(llama|mistral|mixtral|phi|gemma|deepseek-r1:)/i, "ollama"],
  [/^(meta-|mistralai\/|google\/|anthropic\/)/i, "openrouter"],
];

export function inferProvider(model: string): string {
  for (const [pattern, providerId] of INFERENCE_RULES) {
    if (pattern.test(model)) return providerId;
  }
  return "openai";
}
