/**
 * Budget profiles for different model sizes.
 *
 * Ported from metis/runtime/profiles.py + metis/runtime/budgets.py.
 */

import type { BudgetConfig, ModelProfile, ModelProfileName } from '../core/types.js';

const PROFILES: Record<ModelProfileName, ModelProfile> = {
  // Small model profiles — context-appropriate for 7B-14B models
  micro_4k: {
    name: 'micro_4k',
    budget: {
      modelContextTokens: 4_096,
      modelOutputTokens: 2_048,
      contextThreshold: 0.65,
      perToolChars: 2_000,
      maxToolResultChars: 1_500,
      maxTurns: 15,
    },
    requireDoneEvidenceRefs: false,
  },
  micro_8k: {
    name: 'micro_8k',
    budget: {
      modelContextTokens: 8_192,
      modelOutputTokens: 4_096,
      contextThreshold: 0.70,
      perToolChars: 4_000,
      maxToolResultChars: 2_500,
      maxTurns: 14,
    },
    requireDoneEvidenceRefs: false,
  },
  micro_16k: {
    name: 'micro_16k',
    budget: {
      modelContextTokens: 16_384,
      modelOutputTokens: 4_096,
      contextThreshold: 0.75,
      perToolChars: 8_000,
      maxToolResultChars: 4_000,
      maxTurns: 12,
    },
    requireDoneEvidenceRefs: false,
  },
  small: {
    name: 'small',
    budget: {
      modelContextTokens: 32_000,
      modelOutputTokens: 4_096,
      contextThreshold: 0.8,
      perToolChars: 20_000,
      maxToolResultChars: 10_000,
      maxTurns: 10,
    },
    requireDoneEvidenceRefs: false,
  },
  balanced: {
    name: 'balanced',
    budget: {
      modelContextTokens: 128_000,
      modelOutputTokens: 8_192,
      contextThreshold: 0.8,
      perToolChars: 40_000,
      maxToolResultChars: 20_000,
      maxTurns: 12,
    },
    requireDoneEvidenceRefs: false,
  },
  deep: {
    name: 'deep',
    budget: {
      modelContextTokens: 200_000,
      modelOutputTokens: 16_384,
      contextThreshold: 0.8,
      perToolChars: 60_000,
      maxToolResultChars: 30_000,
      maxTurns: 20,
    },
    requireDoneEvidenceRefs: false,
  },
  small_strict: {
    name: 'small_strict',
    budget: {
      modelContextTokens: 32_000,
      modelOutputTokens: 4_096,
      contextThreshold: 0.8,
      perToolChars: 20_000,
      maxToolResultChars: 10_000,
      maxTurns: 10,
    },
    requireDoneEvidenceRefs: true,
  },
};

export function getProfile(name: ModelProfileName): ModelProfile {
  return PROFILES[name] ?? PROFILES.small;
}

export function getDefaultBudget(): BudgetConfig {
  return PROFILES.small.budget;
}
