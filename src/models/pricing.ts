/**
 * 模型价格参考表（USD / 每百万 token）。
 *
 * ⚠️ 重要：供应商价格调整频繁，此表仅用于「量级参考」与成本归因，
 * 不保证实时准确。生产环境请通过 provider 的 `pricing` 选项传入你自己的表：
 *
 * ```ts
 * createOpenAICompatProvider(OPENAI_COMPAT_PRESETS.openai, {
 *   pricing: { "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 } },
 * });
 * ```
 *
 * 未收录的模型返回 undefined，成本统计会记为 0 而不会报错。
 */

import type { Pricing } from "./types.js";

export const PRICING_TABLE: Readonly<Record<string, Pricing>> = {
  // OpenAI
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.1 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025 },
  o3: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.55 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275 },

  // Anthropic
  "claude-opus-4-20250514": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  "claude-sonnet-4-20250514": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  "claude-3-7-sonnet-latest": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  "claude-3-5-haiku-latest": {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
  },

  // Google
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31 },
  "gemini-2.5-flash": { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.0375 },

  // DeepSeek（缓存命中价格极具优势，是成本优化的常见选择）
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 },
  "deepseek-reasoner": { inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14 },

  // Moonshot / Kimi
  "moonshot-v1-8k": { inputPerMTok: 0.8, outputPerMTok: 0.8 },
  "moonshot-v1-32k": { inputPerMTok: 1.4, outputPerMTok: 1.4 },
  "moonshot-v1-128k": { inputPerMTok: 4, outputPerMTok: 4 },

  // 通义千问
  "qwen-plus": { inputPerMTok: 0.4, outputPerMTok: 1.2 },
  "qwen-max": { inputPerMTok: 1.6, outputPerMTok: 6.4 },
  "qwen-turbo": { inputPerMTok: 0.05, outputPerMTok: 0.2 },

  // 智谱
  "glm-4-plus": { inputPerMTok: 0.7, outputPerMTok: 0.7 },
  "glm-4-air": { inputPerMTok: 0.14, outputPerMTok: 0.14 },
};

/** 按前缀匹配价格，兼容带日期后缀/版本号的模型名。 */
export function lookupPricing(model: string): Pricing | undefined {
  const exact = PRICING_TABLE[model];
  if (exact) return exact;

  const normalized = model.toLowerCase();
  const keys = Object.keys(PRICING_TABLE).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key.toLowerCase())) return PRICING_TABLE[key];
  }
  // 处理 openrouter 风格的 "openai/gpt-4o"
  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) return lookupPricing(model.slice(slashIndex + 1));
  return undefined;
}
