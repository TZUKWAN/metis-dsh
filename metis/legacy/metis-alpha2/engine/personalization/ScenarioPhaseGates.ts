/**
 * Scenario phased-build acceptance gates (2026-08-23, requested by 刘总).
 *
 * The scenario compiler works through five ordered phases. After each phase a
 * deterministic gate verifies that this phase's parts exist and are structurally
 * sound BEFORE the loop moves on — failures go back to the model with concrete
 * issues so the phase can be repaired immediately instead of surfacing at the
 * end as one giant validation dump.
 *
 * Pure functions only: no I/O, no model calls, fully unit-testable.
 */

import type { ScenarioDefinition } from '../runtime/PersonalizationRuntimeContract.js';
import {
  collectDeliverableCompletenessGaps,
  formatDeliverableCompletenessIssues,
  normalizeScenarioHarness,
  renderScenarioMetisMarkdown,
} from './ScenarioHarness.js';

export const SCENARIO_PHASE_ORDER = ['basics', 'deliverable', 'workflow', 'rules', 'output_plan'] as const;

export type ScenarioPhase = (typeof SCENARIO_PHASE_ORDER)[number];

export interface PhaseGateResult {
  ok: boolean;
  issues: string[];
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The Markdown that normalizeScenarioHarness produces when every structured
 * Metis field is empty. A rules-phase draft equal to (or barely above) this
 * template means the model never wrote real rules.
 */
function emptyMetisTemplate(): string {
  return renderScenarioMetisMarkdown({
    purpose: '', roleBoundaries: '', researchRules: '', writingRules: '',
    toolRules: '', qualityGates: '', failureRecovery: '', markdown: '',
  } as Parameters<typeof renderScenarioMetisMarkdown>[0]);
}

/** Gate for Phase 1 — name / description / capability must be real content. */
function checkBasics(scenario: ScenarioDefinition): string[] {
  const issues: string[] = [];
  if (!hasText(scenario.name)) issues.push('scenario.name 为空：请写出场景名称。');
  if (!hasText(scenario.description) || scenario.description.trim().length < 20) {
    issues.push('scenario.description 缺失或过短（至少 20 字）：请描述这个场景要完成什么、给谁用。');
  }
  if (!hasText(scenario.capability)) issues.push('scenario.capability 为空：请设定场景能力标识（如 research）。');
  return issues;
}

/** Gate for Phase 2 — deliverable type/length/sections must be complete. */
function checkDeliverable(scenario: ScenarioDefinition): string[] {
  const issues: string[] = [];
  const deliverable = scenario.deliverable;
  if (!deliverable) return ['deliverable 整体缺失：请先定义交付物类型与结构。'];
  if (!hasText(deliverable.type)) issues.push('deliverable.type 为空：请从允许枚举中选择交付物类型。');
  if (!hasText(deliverable.globalLength)) issues.push('deliverable.globalLength 为空：请给出总篇幅要求（字符串，如 "7500字"）。');
  const sections = deliverable.sections ?? [];
  if (sections.length === 0) issues.push('deliverable.sections 为空：请至少定义一个章节，并给每个章节稳定的 id 与标题。');
  // 二级章节强制（2026-08-28 刘总要求）：AI 编译不允许产出"20 个一级章节、
  // 0 个二级章节"的空壳结构。每章至少要有政策下限（默认 3）个带标题的子章节。
  const minSecondary = Math.max(0, deliverable.secondarySections?.min ?? 3);
  sections.forEach((section, index) => {
    if (!hasText(section.title)) issues.push(`deliverable.sections[${index}]（${section.id || '无 id'}）标题为空。`);
    if (section.kind === 'chapter' && minSecondary > 0) {
      const childCount = (section.children ?? []).filter((child) => hasText(child.title)).length;
      if (childCount < minSecondary) {
        issues.push(`deliverable.sections[${index}]（${section.title}）二级章节不足（${childCount}/${minSecondary}）：请为该章补充至少 ${minSecondary} 个带标题的二级章节（children）。`);
      }
    }
  });
  // 内容完整性门（2026-09-04 刘总要求）：骨架上屏不等于阶段通过。每个部分按
  // kind 必填的 purpose/instructions/requirements/lengthTarget 与全局
  // globalInstructions 缺失或为占位文本时，deliverable 阶段不予放行（与
  // assessScenarioHarness 共用同一份集中规则，不在门禁处另写一套判断）。
  issues.push(...formatDeliverableCompletenessIssues(collectDeliverableCompletenessGaps(scenario)));
  return issues;
}

/** Gate for Phase 3 — every workflow step needs name/prompt/criteria. */
function checkWorkflow(scenario: ScenarioDefinition): string[] {
  const issues: string[] = [];
  if (scenario.workflow.length === 0) return ['workflow 为空：请至少添加一个工作流步骤（含稳定 id、名称、专属 prompt）。'];
  scenario.workflow.forEach((step, index) => {
    const label = step.name || step.id || `#${index}`;
    if (!hasText(step.name)) issues.push(`workflow[${index}] 步骤名为空。`);
    if (!hasText(step.prompt)) issues.push(`workflow[${index}]（${label}）缺少专属 prompt：写明这一步让模型做什么。`);
    if (!Array.isArray(step.completionCriteria) || step.completionCriteria.filter(hasText).length === 0) {
      issues.push(`workflow[${index}]（${label}）缺少 completionCriteria：至少一条可判定的完成标准。`);
    }
    if (!hasText(step.id)) issues.push(`workflow[${index}] 缺少稳定 id。`);
  });
  return issues;
}

/** Gate for Phase 4 — Scenario Metis.md 与 workflowPrompt 必须是实文。 */
function checkRules(scenario: ScenarioDefinition): string[] {
  const issues: string[] = [];
  const metisMarkdown = scenario.scenarioMetis?.markdown?.trim() ?? '';
  if (metisMarkdown.length < 60) {
    issues.push('scenarioMetis.markdown 缺失或内容过少：请写入贯穿整个工作流的真实规则文档（不少于 60 字）。');
  } else if (metisMarkdown === emptyMetisTemplate()) {
    issues.push('scenarioMetis.markdown 目前只是空白模板：请补充 Purpose/研究规则/写作规则等实质内容。');
  }
  if (!hasText(scenario.workflowPrompt)) {
    issues.push('workflowPrompt 为空：请写明端到端运行规则（步骤衔接、产物流转、质量把关）。');
  }
  return issues;
}

/** Gate for Phase 5 — output plan quality criteria must exist. */
function checkOutputPlan(scenario: ScenarioDefinition): string[] {
  const issues: string[] = [];
  const plan = scenario.output?.plan;
  if (!plan) return ['output.plan 缺失：请定义主交付物与质量标准。'];
  if (!hasText(plan.primaryDeliverable)) issues.push('output.plan.primaryDeliverable 为空：请给主交付物一个简短标题。');
  if (!Array.isArray(plan.qualityCriteria) || plan.qualityCriteria.filter((item) => hasText((item as { text?: unknown })?.text ?? item)).length === 0) {
    issues.push('output.plan.qualityCriteria 为空：请给出至少一条可核验的质量标准。');
  }
  return issues;
}

const PHASE_CHECKERS: Record<ScenarioPhase, (scenario: ScenarioDefinition) => string[]> = {
  basics: checkBasics,
  deliverable: checkDeliverable,
  workflow: checkWorkflow,
  rules: checkRules,
  output_plan: checkOutputPlan,
};

export const SCENARIO_PHASE_LABELS: Record<ScenarioPhase, string> = {
  basics: '基本信息',
  deliverable: '交付物结构',
  workflow: '连续工作流',
  rules: '场景规则（Scenario Metis.md）',
  output_plan: '输出计划',
};

/**
 * Deterministic acceptance gate for one build phase. Always evaluates against
 * the normalized form so engine defaults cannot mask missing user content.
 */
export function checkPhaseGate(phase: ScenarioPhase, draft: ScenarioDefinition): PhaseGateResult {
  let normalized: ScenarioDefinition;
  try {
    normalized = normalizeScenarioHarness(draft);
  } catch (error) {
    return { ok: false, issues: [String(error instanceof Error ? error.message : error).slice(0, 400)] };
  }
  const issues = PHASE_CHECKERS[phase](normalized);
  return { ok: issues.length === 0, issues };
}

/** Run every gate; used by the final self-audit before returning to the renderer. */
export function runAllPhaseGates(draft: ScenarioDefinition): Array<{ phase: ScenarioPhase; result: PhaseGateResult }> {
  return SCENARIO_PHASE_ORDER.map((phase) => ({ phase, result: checkPhaseGate(phase, draft) }));
}

/** Flatten audit results into numbered repair instructions for the model. */
export function formatAuditIssues(
  entries: Array<{ phase: ScenarioPhase; result: PhaseGateResult }>,
  extraIssues: readonly string[],
): string[] {
  const lines: string[] = [];
  let index = 1;
  for (const entry of entries) {
    for (const issue of entry.result.issues) {
      lines.push(`${index++}. [${SCENARIO_PHASE_LABELS[entry.phase]}] ${issue}`);
    }
  }
  for (const issue of extraIssues) {
    lines.push(`${index++}. ${issue.slice(0, 400)}`);
  }
  return lines;
}
