/**
 * Prompt Composer (METIS-206).
 *
 * Combines prompt fragments from selected capabilities into ONE coherent system prompt,
 * avoiding the conflicts that arise from naively concatenating multiple external Skill
 * prompts. Fragments are categorized into layers with deterministic precedence; duplicate
 * rules are de-duplicated by a stable key; conflicts are resolved by layer + specificity.
 *
 * Design (task list METIS-206):
 *   - Layers (precedence high → low): CORE_PRINCIPLE > METHOD_RULE > TASK_TEMPLATE >
 *     OUTPUT_SCHEMA > REVIEW_RULE.
 *   - Order-independence: the final prompt is identical regardless of insertion order,
 *     because fragments are grouped by layer and sorted within layer by key.
 *   - Conflict rule: two fragments with the SAME key from DIFFERENT sources are resolved
 *     by keeping the higher-precedence layer; same-layer same-key duplicates collapse.
 *   - Explainability: every fragment carries `source` (capability id) and `enabledReason`,
 *     and the composer returns `provenance` so each line can be explained (METIS-206
 *     completion: "each turn's prompt can explain its source and enabled reason").
 */

import type { CapabilityManifest } from './types.js';

// ─── Layers ───────────────────────────────────────────────────

export const PROMPT_LAYERS = [
  'core_principle',
  'method_rule',
  'task_template',
  'output_schema',
  'review_rule',
] as const;
export type PromptLayer = (typeof PROMPT_LAYERS)[number];

const LAYER_ORDER: Record<PromptLayer, number> = {
  core_principle: 0,
  method_rule: 1,
  task_template: 2,
  output_schema: 3,
  review_rule: 4,
};

// ─── Fragment ─────────────────────────────────────────────────

export interface PromptFragment {
  /** Stable dedup key. Two fragments with the same key collapse/resolve. */
  key: string;
  layer: PromptLayer;
  text: string;
  /** Capability id that contributed this fragment. */
  source: string;
  /** Why this fragment is enabled in the current turn. */
  enabledReason: string;
}

export interface ComposedPrompt {
  /** The final system prompt text. */
  text: string;
  /** Per-fragment provenance, in the order fragments appear in `text`. */
  provenance: Array<{
    key: string;
    layer: PromptLayer;
    source: string;
    enabledReason: string;
    lineRange: [number, number]; // 1-based start/end line in `text`
  }>;
  /** Keys that were dropped due to conflict resolution (lower precedence lost). */
  resolvedConflicts: Array<{ key: string; kept: string; dropped: string }>;
  /** Total fragment count before dedup. */
  inputFragmentCount: number;
  /** Final fragment count after dedup/conflict resolution. */
  outputFragmentCount: number;
}

// ─── Composer ─────────────────────────────────────────────────

/**
 * Compose fragments into a single system prompt. Order-independent: fragments are grouped
 * by layer (precedence) and sorted by key within each layer, so the output does not depend
 * on the order fragments were pushed in.
 */
export function composePrompt(fragments: PromptFragment[]): ComposedPrompt {
  const inputFragmentCount = fragments.length;
  const resolvedConflicts: ComposedPrompt['resolvedConflicts'] = [];

  // Group by key. For each key, if multiple fragments exist, keep the one in the
  // highest-precedence (lowest LAYER_ORDER) layer; record conflicts.
  const byKey = new Map<string, PromptFragment>();
  for (const frag of fragments) {
    const existing = byKey.get(frag.key);
    if (!existing) {
      byKey.set(frag.key, frag);
      continue;
    }
    if (frag.key === existing.key) {
      // Same key. If same layer too, they're true duplicates — collapse (keep first, stable).
      if (frag.layer === existing.layer) {
        continue;
      }
      // Different layer: keep higher precedence (lower order number).
      if (LAYER_ORDER[frag.layer] < LAYER_ORDER[existing.layer]) {
        resolvedConflicts.push({ key: frag.key, kept: frag.source, dropped: existing.source });
        byKey.set(frag.key, frag);
      } else {
        resolvedConflicts.push({ key: frag.key, kept: existing.source, dropped: frag.source });
      }
    }
  }

  // Now group surviving fragments by layer, sort within layer by key.
  const byLayer = new Map<PromptLayer, PromptFragment[]>();
  for (const layer of PROMPT_LAYERS) byLayer.set(layer, []);
  for (const frag of byKey.values()) {
    byLayer.get(frag.layer)!.push(frag);
  }
  for (const layer of PROMPT_LAYERS) {
    byLayer.get(layer)!.sort((a, b) => a.key.localeCompare(b.key));
  }

  // Render with layer headers, tracking line ranges for provenance.
  const lines: string[] = [];
  const provenance: ComposedPrompt['provenance'] = [];

  const LAYER_HEADERS: Record<PromptLayer, string> = {
    core_principle: '## 核心原则',
    method_rule: '## 方法规则',
    task_template: '## 任务模板',
    output_schema: '## 输出格式',
    review_rule: '## 审查规则',
  };

  for (const layer of PROMPT_LAYERS) {
    const frags = byLayer.get(layer)!;
    if (frags.length === 0) continue;
    lines.push(LAYER_HEADERS[layer]);
    for (const frag of frags) {
      const startLine = lines.length + 1;
      // indent fragment text by 2 spaces; record each as a block
      for (const ln of frag.text.split('\n')) lines.push('  ' + ln);
      const endLine = lines.length;
      provenance.push({
        key: frag.key,
        layer: frag.layer,
        source: frag.source,
        enabledReason: frag.enabledReason,
        lineRange: [startLine, endLine],
      });
    }
    lines.push(''); // blank line between layers
  }

  const text = lines.join('\n').trim();
  return {
    text,
    provenance,
    resolvedConflicts,
    inputFragmentCount,
    outputFragmentCount: provenance.length,
  };
}

// ─── Capability → fragments helper ───────────────────────────

/**
 * Build a default fragment set from a capability manifest. This gives each capability a
 * baseline core_principle (from description) and method_rule (from limitations), so the
 * composer always has something structured to work with. Real task templates are added by
 * the caller (METIS-801~807) per turn.
 */
export function fragmentsFromCapability(cap: CapabilityManifest): PromptFragment[] {
  const frags: PromptFragment[] = [
    {
      key: `${cap.id}.principle`,
      layer: 'core_principle',
      text: cap.description,
      source: cap.id,
      enabledReason: `主能力 ${cap.name}（路由选定）`,
    },
  ];
  for (const lim of cap.limitations) {
    frags.push({
      key: `${cap.id}.limitation.${lim.slice(0, 24)}`,
      layer: 'method_rule',
      text: `约束：${lim}`,
      source: cap.id,
      enabledReason: `能力 ${cap.name} 的方法限制`,
    });
  }
  return frags;
}
