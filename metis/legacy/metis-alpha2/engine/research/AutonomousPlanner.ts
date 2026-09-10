/**
 * AutonomousPlanner — online reflective planner for the autonomous research loop.
 *
 * Unlike GoalEngine (which generates one frozen DAG up front), the planner
 * decides one phase at a time and reflects after each phase to decide whether
 * to advance, redo, roll back, or finish. This is the "while not done: pick
 * next phase" core that turns the existing research building blocks into an
 * autonomous loop.
 *
 * The planner is provider-driven for the reflection step but deterministic for
 * phase ordering (idea → experiment → analysis → paper), so a provider failure
 * degrades gracefully to a fixed linear schedule instead of stalling the loop.
 */

import type { BaseProvider } from '../providers/BaseProvider.js';
import { ResearchPhaseKindSchema, type ResearchPhaseKind } from '../runtime/AutonomousRuntimeContract.js';
import type { ResearchMethodSpec } from './researchMethods.js';
import { selectResearchMethodWithProvider } from './researchMethods.js';

// ─── Plan model ───────────────────────────────────────────────

export const PHASE_ORDER: readonly ResearchPhaseKind[] = ['idea', 'experiment', 'analysis', 'paper'] as const;

export const PHASE_NAMES: Record<ResearchPhaseKind, string> = {
  idea: '选题与假设',
  experiment: '实验设计与执行',
  analysis: '结果分析',
  paper: '论文撰写',
  question_formulation: '研究问题界定',
  literature_review: '文献综述',
  source_discovery: '资料发现',
  screening: '文献筛选',
  conceptual_analysis: '概念与理论分析',
  source_criticism: '史料批判',
  research_design: '研究设计',
  data_collection: '资料与数据获取',
  coding: '质性编码',
  data_preparation: '数据准备',
  statistics: '定量分析',
  triangulation: '三角互证与稳健性检验',
  argumentation: '论证构建',
  writing: '论文写作',
  synthesis: '综合归纳',
  quality_audit: '研究质量审计',
};

export interface PlannedPhase {
  phase: ResearchPhaseKind;
  name: string;
  iteration: number;
}

export interface ResearchPlan {
  goal: string;
  /** Linear plan the loop walks; redos append duplicate phase entries. */
  phases: PlannedPhase[];
  /** Per-phase revision notes injected into the phase prompt on (re)execution. */
  revisionNotes: Partial<Record<ResearchPhaseKind, string>>;
  /** Automatically selected method contract for humanities/social-science runs. */
  methodSpec?: ResearchMethodSpec;
}

export interface PhaseHistoryEntry {
  phase: ResearchPhaseKind;
  iteration: number;
  output: string;
}

export type ReflectionDecision = 'advance' | 'redo' | 'rollback' | 'done';

export interface Reflection {
  phase: ResearchPhaseKind;
  decision: ReflectionDecision;
  /** Next phase to execute (required unless decision is 'done'). */
  nextPhase?: ResearchPhaseKind;
  qualityScore: number; // 0..1
  reasoning: string;
  /** Injected into the next iteration's prompt when redo/rollback. */
  revisionNote?: string;
}

export interface ReflectionContext {
  nextPhase?: ResearchPhaseKind;
  isFinal?: boolean;
  allowedPhases?: ResearchPhaseKind[];
  qualityCriteria?: string[];
}

// ─── Planner ──────────────────────────────────────────────────

export interface AutonomousPlannerOptions {
  provider?: BaseProvider;
  /** Quality threshold below which an "advance" is downgraded to a redo. Default 0.5. */
  redoThreshold?: number;
  /** Per-phase redo cap; exceeding it forces advancement to avoid infinite loops. */
  maxRedosPerPhase?: number;
}

const DEFAULT_REDO_THRESHOLD = 0.5;
const DEFAULT_MAX_REDOS_PER_PHASE = 2;

export class AutonomousPlanner {
  private readonly provider?: BaseProvider;
  private readonly redoThreshold: number;
  private readonly maxRedosPerPhase: number;
  private readonly redoCounts = new Map<ResearchPhaseKind, number>();

  constructor(options: AutonomousPlannerOptions = {}) {
    this.provider = options.provider;
    this.redoThreshold = options.redoThreshold ?? DEFAULT_REDO_THRESHOLD;
    this.maxRedosPerPhase = options.maxRedosPerPhase ?? DEFAULT_MAX_REDOS_PER_PHASE;
  }

  /** Build the initial linear plan for a user goal. */
  proposeInitialGoal(goal: string): ResearchPlan {
    return {
      goal,
      phases: PHASE_ORDER.map((phase, index) => ({
        phase,
        name: PHASE_NAMES[phase],
        iteration: index + 1,
      })),
      revisionNotes: {},
    };
  }

  /** Reset retry accounting for a newly-started research session. */
  startRun(): void {
    this.redoCounts.clear();
  }

  /** Build an automatic humanities/social-science plan from the research goal. */
  async proposeResearchPlan(goal: string): Promise<ResearchPlan> {
    const methodSpec = await selectResearchMethodWithProvider(goal, this.provider);
    return {
      goal,
      phases: methodSpec.phases.map((item, index) => ({
        phase: item.action,
        name: item.name,
        iteration: index + 1,
      })),
      revisionNotes: {},
      methodSpec,
    };
  }

  /**
   * Reflect on a completed phase's output and decide the next move.
   * Provider-driven when available; deterministic fallback otherwise.
   */
  async reflect(
    phase: ResearchPhaseKind,
    output: string,
    history: PhaseHistoryEntry[],
    goal: string,
    context: ReflectionContext = {},
  ): Promise<Reflection> {
    if (this.provider) {
      try {
        const reflection = await this.reflectWithProvider(phase, output, history, goal, context);
        if (reflection) return this.enforceRedoCap(phase, reflection, context.nextPhase);
      } catch {
        // fall through to deterministic reflection
      }
    }
    return this.deterministicReflect(phase, output, context);
  }

  /** Pick the next phase to execute given the plan and completed history. */
  pickNextPhase(plan: ResearchPlan, history: PhaseHistoryEntry[]): PlannedPhase | null {
    const completedCount = history.length;
    if (completedCount >= plan.phases.length) return null;
    return plan.phases[completedCount] ?? null;
  }

  /** Append a redo of `phase` to the plan, carrying the revision note. */
  reviseForRedo(
    plan: ResearchPlan,
    phase: ResearchPhaseKind,
    revisionNote: string,
    insertAt?: number,
  ): void {
    const lastIteration = plan.phases.filter((p) => p.phase === phase).length;
    const retry = {
      phase,
      name: `${PHASE_NAMES[phase]}（重做 #${lastIteration + 1}）`,
      iteration: lastIteration + 1,
    };
    if (insertAt === undefined) plan.phases.push(retry);
    else plan.phases.splice(Math.max(0, Math.min(plan.phases.length, insertAt)), 0, retry);
    plan.revisionNotes[phase] = revisionNote;
  }

  /** Roll back to a previous phase: drop subsequent history + plan tail. */
  reviseForRollback(
    plan: ResearchPlan,
    history: PhaseHistoryEntry[],
    targetPhase: ResearchPhaseKind,
    revisionNote: string,
  ): void {
    const targetIndex = history.findIndex((h) => h.phase === targetPhase);
    if (targetIndex < 0) return;
    // Truncate history to just before the target phase's first occurrence.
    history.splice(targetIndex);
    // Rebuild the plan from that execution point while preserving all
    // downstream phases. The previous implementation kept only the rollback
    // target and silently discarded the rest of the research method.
    const keep = history.length;
    const originalTargetIndex = plan.phases.findIndex((item, index) => index >= keep && item.phase === targetPhase);
    const tailStart = originalTargetIndex >= 0 ? originalTargetIndex : keep;
    const tail = plan.phases.slice(tailStart).map((item, index) => (
      index === 0
        ? { ...item, name: `${PHASE_NAMES[targetPhase]}（回退重做）`, iteration: item.iteration + 1 }
        : { ...item }
    ));
    plan.phases = [...plan.phases.slice(0, keep), ...tail];
    plan.revisionNotes[targetPhase] = revisionNote;
  }

  get revisionNotes(): Partial<Record<ResearchPhaseKind, string>> {
    return {};
  }

  // ─── Internals ──────────────────────────────────────────────

  private enforceRedoCap(
    phase: ResearchPhaseKind,
    reflection: Reflection,
    plannedNextPhase?: ResearchPhaseKind,
  ): Reflection {
    // Quality safety-net: if the provider said "advance" but the score is below
    // the redo threshold, downgrade to a redo (the phase output is too weak to
    // build on). This catches providers that are too eager to advance.
    let effective = reflection;
    if (
      reflection.decision === 'advance'
      && reflection.qualityScore < this.redoThreshold
    ) {
      effective = {
        ...reflection,
        decision: 'redo',
        reasoning: `${reflection.reasoning}\n（质量 ${reflection.qualityScore.toFixed(2)} 低于重做阈值 ${this.redoThreshold}，自动降级为重做）`,
      };
    }

    if (effective.decision !== 'redo' && effective.decision !== 'rollback') return effective;
    const count = (this.redoCounts.get(phase) ?? 0) + 1;
    this.redoCounts.set(phase, count);
    if (count > this.maxRedosPerPhase) {
      // Force advancement to avoid stalling the loop on a stubborn phase.
      const nextPhase = plannedNextPhase ?? nextPhaseAfter(phase);
      return {
        phase,
        decision: 'advance',
        nextPhase,
        qualityScore: effective.qualityScore,
        reasoning: `${effective.reasoning}\n（已达该阶段重做上限 ${this.maxRedosPerPhase} 次，强制推进到 ${nextPhase ?? '完成'}）`,
      };
    }
    return effective;
  }

  private async reflectWithProvider(
    phase: ResearchPhaseKind,
    output: string,
    history: PhaseHistoryEntry[],
    goal: string,
    context: ReflectionContext,
  ): Promise<Reflection | null> {
    const transcript = history.slice(-6)
      .map((h) => `[${h.phase}#${h.iteration}] ${h.output.slice(0, 800)}`)
      .join('\n\n');

    const response = await this.provider!.complete([
      {
        role: 'system',
        content: [
          'You are the reflection module of an autonomous research engine.',
          'Evaluate the most recently completed research phase and decide the next action.',
          'Return ONLY a JSON object, no preamble, in this exact shape:',
          '{"decision":"advance|redo|rollback|done","qualityScore":0.0-1.0,"nextPhase":"允许的阶段之一","reasoning":"...","revisionNote":"..."}',
          'Rules:',
          '- "advance": quality is sufficient, move to nextPhase.',
          '- "redo": quality is borderline, re-run the SAME phase with revisionNote.',
          '- "rollback": the phase revealed a flaw in an earlier phase; nextPhase names the earlier phase to redo.',
          '- "done": only when the method plan is complete and its quality criteria are met.',
          '- qualityScore reflects rigor/completeness of the phase output, not its length.',
          `- 允许的阶段：${(context.allowedPhases ?? [...PHASE_ORDER]).join(', ')}。`,
          context.nextPhase ? `- 当前计划的下一阶段是 ${context.nextPhase}。` : '- 当前阶段之后没有计划阶段。',
          context.qualityCriteria?.length ? `- 方法质量标准：${context.qualityCriteria.join('；')}` : '',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Research goal: ${goal}`,
          `Just completed phase: ${phase}`,
          `Phase output:\n${output.slice(0, 6000)}`,
          transcript ? `\nRecent history:\n${transcript}` : '',
        ].join('\n'),
      },
      ], undefined, { temperature: 0.3, thinking: true });

    return parseReflectionJson(phase, response.content);
  }

  private deterministicReflect(
    phase: ResearchPhaseKind,
    output: string,
    context: ReflectionContext,
  ): Reflection {
    if (!output.trim()) {
      return {
        phase,
        decision: 'redo',
        qualityScore: 0,
        reasoning: '阶段没有产生可用研究产出，自动重做而不是带着空结果继续。',
        revisionNote: '上次产出为空。缩小任务范围，核对工具和资料可用性后重新执行。',
      };
    }
    // No provider: trust the phase produced something and advance linearly.
    // After the final planned phase, mark done.
    if (context.isFinal || phase === 'paper') {
      return {
        phase,
        decision: 'done',
        qualityScore: 1,
        reasoning: '已完成论文阶段（无反思模型可用，按线性计划结束）。',
      };
    }
    return {
      phase,
      decision: 'advance',
      nextPhase: context.nextPhase ?? nextPhaseAfter(phase),
      qualityScore: 1,
      reasoning: '无反思模型可用，按线性计划推进到下一阶段。',
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

export function nextPhaseAfter(phase: ResearchPhaseKind): ResearchPhaseKind | undefined {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx >= 0 && idx < PHASE_ORDER.length - 1 ? PHASE_ORDER[idx + 1] : undefined;
}

function parseReflectionJson(phase: ResearchPhaseKind, raw: string): Reflection | null {
  try {
    const text = String(raw ?? '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
    const candidate = (fenced?.[1] ?? text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      decision?: string;
      qualityScore?: number;
      nextPhase?: string;
      reasoning?: string;
      revisionNote?: string;
    };

    const decision = normalizeDecision(parsed.decision);
    if (!decision) return null;

    const qualityScore = clamp01(Number(parsed.qualityScore));
    const reasoning = String(parsed.reasoning ?? '').slice(0, 4000) || '反思未给出理由。';
    const nextPhase = normalizePhase(parsed.nextPhase);
    const revisionNote = parsed.revisionNote ? String(parsed.revisionNote).slice(0, 2000) : undefined;

    return {
      phase,
      decision,
      nextPhase: decision === 'done' ? undefined : nextPhase,
      qualityScore,
      reasoning,
      revisionNote: decision === 'redo' || decision === 'rollback' ? revisionNote : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeDecision(raw: unknown): ReflectionDecision | null {
  if (raw === 'advance' || raw === 'redo' || raw === 'rollback' || raw === 'done') return raw;
  return null;
}

function normalizePhase(raw: unknown): ResearchPhaseKind | undefined {
  const parsed = ResearchPhaseKindSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
