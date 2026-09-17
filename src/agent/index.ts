/**
 * Agent 编排层统一出口。
 */

export * from "./types.js";
export { createAgent, extractJsonCandidates } from "./agent.js";
export type { Agent } from "./agent.js";
export {
  compactMessages,
  estimateTokens,
  estimateTextTokens,
  estimateMessageTokens,
  renderTemplate,
  summarizeWithModel,
} from "./context.js";
export type { CompactionResult, CompactOptions } from "./context.js";
export { agentAsTool, createHandoffTools, runParallel, createSupervisor } from "./multi.js";
export type { AgentAsToolOptions, ParallelRunOptions } from "./multi.js";
export { planAndExecute, planSchema, planStepSchema } from "./plan.js";
export type { Plan, PlanStep, PlanExecuteConfig, PlanExecuteResult } from "./plan.js";
