/**
 * Model Adaptive Execution Strategy (METIS-303).
 *
 * Selects an execution profile derived from the probed model capabilities (METIS-302), so
 * that a 9B-class model runs stably via FINE-GRAINED tasks, structured output, and
 * deterministic checks — rather than being asked to do a long research flow in one shot.
 *
 * The strategy derives: max turns per step, max tools per turn, retry counts, review
 * frequency (how often to ask the model to self-check), and the max context budget. These
 * feed AgentLoop + ContextEngine + CapabilityRouter's tool bound.
 */

import type { ProbedCapabilities } from './CapabilityProbe.js';

export type ModelTier = 'micro' | 'small' | 'standard' | 'powerful' | 'unusable';

export interface AdaptiveStrategy {
  tier: ModelTier;
  /** Max turns per single step — small models get more, finer-grained turns. */
  maxTurnsPerStep: number;
  /** Max tools active in a single turn (router bound; ≤ METIS-204 MAX_TOOLS). */
  maxToolsPerTurn: number;
  /** How aggressively to retry a failed turn. */
  maxRetries: number;
  /** Run a self-review pass every N turns (1 = every turn). Small models: more frequent. */
  reviewEveryNTurns: number;
  /** Force structured (JSON) output for deterministic parsing. */
  forceStructuredOutput: boolean;
  /** Context budget to hand to ContextEngine. */
  contextBudgetTokens: number;
  /** Output token cap. */
  maxOutputTokens: number;
  /** Whether native tool calling is available (if not, parse tool calls from text). */
  nativeToolCalling: boolean;
  /** Human-readable rationale for the chosen profile (explainability). */
  rationale: string;
}

const UNUSABLE: AdaptiveStrategy = {
  tier: 'unusable',
  maxTurnsPerStep: 0,
  maxToolsPerTurn: 0,
  maxRetries: 0,
  reviewEveryNTurns: 0,
  forceStructuredOutput: false,
  contextBudgetTokens: 0,
  maxOutputTokens: 0,
  nativeToolCalling: false,
  rationale: '模型不可用或不可达，无法执行。',
};

/**
 * Classify the model into a tier based on probed context length + tool calling. This is the
 * key lever for METIS-303: a 9B model (≤32k context, possibly no native tools) gets the
 * "small" tier with fine-grained turns and forced structured output.
 */
export function classifyModelTier(probed: ProbedCapabilities): ModelTier {
  if (!probed.reachable) return 'unusable';
  const ctx = probed.maxContextTokens ?? 0;
  if (ctx > 0 && ctx <= 8192) return 'micro';
  if (ctx > 8192 && ctx <= 32768) return 'small';
  if (ctx > 32768 && ctx <= 128000) return 'standard';
  if (ctx > 128000) return 'powerful';
  // Unknown context: assume standard but conservative.
  return 'standard';
}

export function deriveAdaptiveStrategy(probed: ProbedCapabilities): AdaptiveStrategy {
  if (!probed.reachable) return UNUSABLE;

  const tier = classifyModelTier(probed);
  const nativeTools = probed.nativeToolCalling;

  switch (tier) {
    case 'micro':
      // ≤8k context: extremely fine-grained. One tool per turn, review every turn, force
      // structured output, short steps.
      return {
        tier,
        maxTurnsPerStep: 8,
        maxToolsPerTurn: 5,
        maxRetries: 2,
        reviewEveryNTurns: 1,
        forceStructuredOutput: true,
        contextBudgetTokens: Math.max(2048, (probed.maxContextTokens ?? 4096) - 1024),
        maxOutputTokens: 1024,
        nativeToolCalling: nativeTools,
        rationale: '微型模型（≤8k 上下文）：细粒度任务、每轮自检、强制结构化输出，避免一次性长流程。',
      };
    case 'small':
      // 9B-class typical: 8k–32k. Fine-grained, structured, frequent review.
      return {
        tier,
        maxTurnsPerStep: 6,
        maxToolsPerTurn: 6,
        maxRetries: 2,
        reviewEveryNTurns: 2,
        forceStructuredOutput: true,
        contextBudgetTokens: Math.max(4096, Math.floor((probed.maxContextTokens ?? 16384) * 0.7)),
        maxOutputTokens: 2048,
        nativeToolCalling: nativeTools,
        rationale: '小型模型（9B 级，8k–32k 上下文）：细粒度任务、每 2 轮自检、结构化输出，稳定运行。',
      };
    case 'standard':
      return {
        tier,
        maxTurnsPerStep: 4,
        maxToolsPerTurn: 8,
        maxRetries: 2,
        reviewEveryNTurns: 3,
        forceStructuredOutput: probed.jsonOutput,
        contextBudgetTokens: Math.floor((probed.maxContextTokens ?? 64000) * 0.75),
        maxOutputTokens: 4096,
        nativeToolCalling: nativeTools,
        rationale: '标准模型（32k–128k）：常规步幅，按 JSON 探测结果决定是否强制结构化。',
      };
    case 'powerful':
      return {
        tier,
        maxTurnsPerStep: 3,
        maxToolsPerTurn: 10,
        maxRetries: 1,
        reviewEveryNTurns: 4,
        forceStructuredOutput: false,
        contextBudgetTokens: Math.floor((probed.maxContextTokens ?? 128000) * 0.8),
        maxOutputTokens: 8192,
        nativeToolCalling: nativeTools,
        rationale: '强力模型（>128k）：可承担较大步幅，减少强制约束以发挥能力。',
      };
    default:
      return UNUSABLE;
  }
}

/** Downgrade a strategy one tier (used when a turn fails repeatedly). */
export function downgradeStrategy(strategy: AdaptiveStrategy): AdaptiveStrategy {
  const order: ModelTier[] = ['powerful', 'standard', 'small', 'micro'];
  const idx = order.indexOf(strategy.tier);
  if (idx < 0 || idx >= order.length - 1) return strategy; // already micro or unusable
  const next = order[idx + 1]!;
  return {
    ...strategy,
    tier: next,
    maxTurnsPerStep: strategy.maxTurnsPerStep + 2, // finer grain
    maxToolsPerTurn: Math.max(5, strategy.maxToolsPerTurn - 1),
    reviewEveryNTurns: 1, // review every turn after downgrade
    forceStructuredOutput: true,
    rationale: `降级到 ${next}（连续失败）：更细粒度、每轮自检、强制结构化输出。`,
  };
}
