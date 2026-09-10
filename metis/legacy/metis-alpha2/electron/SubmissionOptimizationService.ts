/**
 * Submission Optimization Service — 投稿优化方案服务（学术投稿生命周期 P1）。
 *
 * 职责：把诊断出的差距项（submission_gap_items）转化为可审批、可执行、
 * 可复核的优化方案（submission_optimization_plans / _items）。
 *
 * 硬纪律：
 *  - applyPlan 只接受 status='approved' 的方案，其余状态结构化拒绝；
 *  - 首次应用时从源成果当前版本**分叉**投稿工作稿（新 outcome），
 *    源成果与其版本链永不被覆盖；
 *  - involvesResearcherJudgment=true 的条目（作者/基金/伦理等事实信息）
 *    永不自动修改，置 'skipped' 并在 afterText 注明原因；
 *  - 自动修改通过 OutcomeAssistantService.chat 执行（它自己负责落新版本，
 *    baseVersion 取其内部读取的当前版本，乐观锁冲突会转成诊断而不是覆盖）；
 *  - 单个条目失败不影响其他条目；每条结果独立记录；
 *  - verifyPlan 重新跑确定性诊断复核 must_fix，禁止「改了就默认通过」。
 */
import { z } from 'zod';
import type {
  SubmissionGapItemCreateInput,
  SubmissionOptimizationItem,
  SubmissionOptimizationPlan,
} from '../engine/submission/JournalProfileContract.js';
import type { OutcomeAssistantChatResult } from '../engine/runtime/OutcomeRuntimeContract.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import { extractManuscriptPlainText, type SubmissionGapService } from './SubmissionGapService.js';
import type { OutcomeRepository } from './OutcomeRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

// ─── 公共契约 ────────────────────────────────────────────────

export const CreatePlanFromGapsRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1),
  gapItemIds: z.array(z.string().min(1)).optional(),
});
export type CreatePlanFromGapsRequest = z.infer<typeof CreatePlanFromGapsRequestSchema>;

export const ApprovePlanRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  planId: z.string().min(1),
  selectedItemIds: z.array(z.string().min(1)).optional(),
});
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequestSchema>;

export const ApplyPlanRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  planId: z.string().min(1),
  caseId: z.string().min(1),
});
export type ApplyPlanRequest = z.infer<typeof ApplyPlanRequestSchema>;

export const VerifyPlanRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  planId: z.string().min(1),
});
export type VerifyPlanRequest = z.infer<typeof VerifyPlanRequestSchema>;

export type OptimizationErrorCode =
  | 'invalid_request'
  | 'case_not_found'
  | 'plan_not_found'
  | 'plan_case_mismatch'
  | 'invalid_plan_status'
  | 'plan_not_approved'
  | 'no_open_gaps'
  | 'source_outcome_not_found'
  | 'working_outcome_not_found'
  | 'manuscript_not_found';

export interface ApplyItemResult {
  itemId: string;
  title: string;
  status: 'applied' | 'skipped' | 'failed';
  outcomeVersion: number | null;
  note: string;
}

export type CreatePlanFromGapsResult =
  | { ok: true; plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] }
  | { ok: false; code: OptimizationErrorCode };

export type ApprovePlanResult =
  | { ok: true; plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] }
  | { ok: false; code: OptimizationErrorCode };

export type ApplyPlanResult =
  | { ok: true; plan: SubmissionOptimizationPlan; results: ApplyItemResult[] }
  | { ok: false; code: OptimizationErrorCode };

export type VerifyPlanResult =
  | { ok: true; verified: boolean; residualMustFix: SubmissionGapItemCreateInput[]; plan: SubmissionOptimizationPlan }
  | { ok: false; code: OptimizationErrorCode };

interface OutcomeAssistantLike {
  chat(request: { projectId: string; outcomeId: string; instruction: string }): Promise<OutcomeAssistantChatResult>;
}

export interface SubmissionOptimizationServiceOptions {
  submissionRepository: SubmissionRepository;
  journalRepository: JournalProfileRepository;
  outcomeRepository: OutcomeRepository;
  /** verifyPlan 复核用：与诊断共用同一套确定性规则。 */
  gapService: Pick<SubmissionGapService, 'runDeterministicChecks'>;
  /** 可选：无助手时可建/批方案，但自动修改条目会记为 failed（assistant_unavailable）。 */
  assistant?: OutcomeAssistantLike;
}

/** beforeText/afterText 记录用稿件纯文本摘录上限（契约上限 50000，留足余量）。 */
const TEXT_EXCERPT_CHARS = 5000;
/** OutcomeAssistantChatRequest.instruction 上限为 8000，预留指令模板空间。 */
const ACTION_INSTRUCTION_CHARS = 7000;

export class SubmissionOptimizationService {
  constructor(private readonly options: SubmissionOptimizationServiceOptions) {}

  /** 把选定（默认全部 open）差距项转成方案条目并落库（status draft）。 */
  async createPlanFromGaps(rawInput: unknown): Promise<CreatePlanFromGapsResult> {
    const parsed = CreatePlanFromGapsRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, caseId, gapItemIds } = parsed.data;
    if (!this.options.submissionRepository.getCase(projectId, caseId)) return { ok: false, code: 'case_not_found' };

    const openGaps = this.options.journalRepository.listGapItems(caseId, 'open');
    const selected = gapItemIds ? openGaps.filter((gap) => gapItemIds.includes(gap.id)) : openGaps;
    if (selected.length === 0) return { ok: false, code: 'no_open_gaps' };

    const { plan, items } = this.options.journalRepository.createPlan(caseId, selected.map((gap) => ({
      gapItemId: gap.id,
      title: gap.title,
      action: gap.recommendedAction || gap.problem || gap.title,
      risk: `预估影响：${gap.estimatedImpact}`,
      involvesResearcherJudgment: gap.requiresResearcherJudgment,
    })));
    // 已纳入方案的差距项推进为 planned（planned/applied 的历史项 diagnose 不再触碰）。
    for (const gap of selected) {
      this.options.journalRepository.updateGapItem(caseId, gap.id, { status: 'planned' });
    }
    return { ok: true, plan, items };
  }

  /** 审批方案：未选中的条目置 'skipped'，选中的置 'selected'；方案转 approved。 */
  async approvePlan(rawInput: unknown): Promise<ApprovePlanResult> {
    const parsed = ApprovePlanRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, planId, selectedItemIds } = parsed.data;
    void projectId;
    const plan = this.options.journalRepository.getPlan(planId);
    if (!plan) return { ok: false, code: 'plan_not_found' };
    if (plan.status !== 'draft') return { ok: false, code: 'invalid_plan_status' };

    const items = this.options.journalRepository.listPlanItems(planId);
    for (const item of items) {
      const chosen = selectedItemIds ? selectedItemIds.includes(item.id) : true;
      this.options.journalRepository.updatePlanItem(planId, item.id, { status: chosen ? 'selected' : 'skipped' });
    }
    const approved = this.options.journalRepository.setPlanStatus(planId, 'approved')!;
    return { ok: true, plan: approved, items: this.options.journalRepository.listPlanItems(planId) };
  }

  /**
   * 应用方案：分叉工作稿（如尚无）→ 逐条执行 selected 条目 → 方案转 applied
   * → 写 'optimization_applied' 时间线事件。单条失败不影响其他条目。
   */
  async applyPlan(rawInput: unknown): Promise<ApplyPlanResult> {
    const parsed = ApplyPlanRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, planId, caseId } = parsed.data;
    const plan = this.options.journalRepository.getPlan(planId);
    if (!plan) return { ok: false, code: 'plan_not_found' };
    if (plan.caseId !== caseId) return { ok: false, code: 'plan_case_mismatch' };
    if (plan.status !== 'approved') return { ok: false, code: 'plan_not_approved' };
    const submissionCase = this.options.submissionRepository.getCase(projectId, caseId);
    if (!submissionCase) return { ok: false, code: 'case_not_found' };

    const working = this.ensureWorkingOutcome(projectId, caseId);
    if ('code' in working) return { ok: false, code: working.code };

    const items = this.options.journalRepository
      .listPlanItems(planId)
      .filter((item) => item.status === 'selected');
    const results: ApplyItemResult[] = [];
    for (const item of items) {
      results.push(await this.applyItem(projectId, caseId, planId, item, working.outcomeId));
    }

    // 工作稿当前版本回写到 case（分叉与逐条修改都可能推进版本号）。
    const latest = this.options.outcomeRepository.get(projectId, working.outcomeId);
    if (latest && latest.outcome.currentVersion !== working.baseVersion) {
      this.options.submissionRepository.updateCase(projectId, {
        caseId,
        workingOutcomeVersion: latest.outcome.currentVersion,
      }, 'agent');
    }

    const appliedPlan = this.options.journalRepository.setPlanStatus(planId, 'applied')!;
    const count = (status: ApplyItemResult['status']) => results.filter((result) => result.status === status).length;
    this.options.submissionRepository.addEvent(projectId, {
      caseId,
      type: 'optimization_applied',
      source: 'agent',
      actor: 'agent',
      description: `优化方案应用完成：成功 ${count('applied')} 项 / 跳过 ${count('skipped')} 项 / 失败 ${count('failed')} 项。`,
      metadata: { planId, workingOutcomeId: working.outcomeId, results: results.map((result) => ({ itemId: result.itemId, status: result.status })) },
    });
    return { ok: true, plan: appliedPlan, results };
  }

  /**
   * 复核方案：对当前工作稿重跑确定性诊断。所有 must_fix 消解 → 方案转
   * verified（关联的已应用差距项一并转 verified）；否则保持 applied 并
   * 返回残留问题清单——改没改好以复核为准，不以执行过为准。
   */
  async verifyPlan(rawInput: unknown): Promise<VerifyPlanResult> {
    const parsed = VerifyPlanRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, planId } = parsed.data;
    const plan = this.options.journalRepository.getPlan(planId);
    if (!plan) return { ok: false, code: 'plan_not_found' };
    if (plan.status !== 'applied' && plan.status !== 'verified') return { ok: false, code: 'invalid_plan_status' };

    const recheck = await this.options.gapService.runDeterministicChecks({ projectId, caseId: plan.caseId });
    if (!recheck.ok) return { ok: false, code: recheck.code };
    const residual = recheck.gaps.filter((gap) => gap.severity === 'must_fix');
    if (residual.length > 0) {
      return { ok: true, verified: false, residualMustFix: residual, plan };
    }
    const verifiedPlan = this.options.journalRepository.setPlanStatus(planId, 'verified')!;
    for (const item of this.options.journalRepository.listPlanItems(planId)) {
      if (item.gapItemId && item.status === 'applied') {
        this.options.journalRepository.updateGapItem(plan.caseId, item.gapItemId, { status: 'verified' });
      }
    }
    return { ok: true, verified: true, residualMustFix: [], plan: verifiedPlan };
  }

  // ── 内部 ───────────────────────────────────────────────────

  /**
   * 确保投稿工作稿存在：已有则校验可读；没有则从源成果当前版本分叉一个
   * 新 outcome（源成果与其版本链永不被覆盖），并回写 case 的 working 字段。
   */
  private ensureWorkingOutcome(projectId: string, caseId: string):
    | { code: OptimizationErrorCode }
    | { outcomeId: string; baseVersion: number } {
    const submissionCase = this.options.submissionRepository.getCase(projectId, caseId);
    if (!submissionCase) return { code: 'case_not_found' };
    if (submissionCase.workingOutcomeId) {
      const detail = this.options.outcomeRepository.get(projectId, submissionCase.workingOutcomeId);
      if (!detail) return { code: 'working_outcome_not_found' };
      return { outcomeId: submissionCase.workingOutcomeId, baseVersion: detail.outcome.currentVersion };
    }
    if (!submissionCase.sourceOutcomeId) return { code: 'source_outcome_not_found' };
    const source = this.options.outcomeRepository.get(projectId, submissionCase.sourceOutcomeId);
    if (!source) return { code: 'source_outcome_not_found' };
    const journal = submissionCase.targetJournalName || '目标期刊';
    const forked = this.options.outcomeRepository.create({
      projectId,
      categoryId: source.outcome.categoryId,
      title: `${source.outcome.title}｜${journal}投稿版`,
      kind: source.outcome.kind,
      content: source.version.content,
      note: `投稿工作稿：分叉自源成果「${source.outcome.title}」v${source.version.version}（SubmissionCase ${caseId}）；源成果不受影响。`,
      actor: 'ai',
    });
    this.options.submissionRepository.updateCase(projectId, {
      caseId,
      workingOutcomeId: forked.outcome.id,
      workingOutcomeVersion: forked.outcome.currentVersion,
    }, 'agent');
    return { outcomeId: forked.outcome.id, baseVersion: forked.outcome.currentVersion };
  }

  /** 执行单个 selected 条目；任何异常都收敛为该条目 failed，不中断其他条目。 */
  private async applyItem(
    projectId: string,
    caseId: string,
    planId: string,
    item: SubmissionOptimizationItem,
    workingOutcomeId: string,
  ): Promise<ApplyItemResult> {
    // 事实信息（作者/基金/伦理等）必须研究者本人确认，永不自动修改。
    if (item.involvesResearcherJudgment) {
      const note = '需要研究者确认，未自动修改。';
      this.options.journalRepository.updatePlanItem(planId, item.id, { status: 'skipped', afterText: note });
      return { itemId: item.id, title: item.title, status: 'skipped', outcomeVersion: null, note };
    }
    const assistant = this.options.assistant;
    if (!assistant) {
      const note = '成果助手不可用（assistant_unavailable），未执行自动修改。';
      this.options.journalRepository.updatePlanItem(planId, item.id, { status: 'failed', afterText: note });
      return { itemId: item.id, title: item.title, status: 'failed', outcomeVersion: null, note };
    }
    try {
      const before = this.options.outcomeRepository.get(projectId, workingOutcomeId);
      if (!before) {
        const note = '工作稿读取失败（working_outcome_not_found）。';
        this.options.journalRepository.updatePlanItem(planId, item.id, { status: 'failed', afterText: note });
        return { itemId: item.id, title: item.title, status: 'failed', outcomeVersion: null, note };
      }
      const beforeText = extractManuscriptPlainText(before.version.content).slice(0, TEXT_EXCERPT_CHARS);
      const result = await assistant.chat({
        projectId,
        outcomeId: workingOutcomeId,
        instruction: [
          '请对当前稿件执行以下投稿优化修改，并用 edit 直接应用（不要只给建议）：',
          item.action.slice(0, ACTION_INSTRUCTION_CHARS),
          `（修改目标：${item.title.slice(0, 500)}）`,
        ].join('\n'),
      });
      if (result.status === 'completed' && result.applied) {
        const after = this.options.outcomeRepository.get(projectId, workingOutcomeId);
        const afterText = after ? extractManuscriptPlainText(after.version.content).slice(0, TEXT_EXCERPT_CHARS) : '';
        const outcomeVersion = result.applied.version.version;
        this.options.journalRepository.updatePlanItem(planId, item.id, {
          status: 'applied',
          beforeText,
          afterText,
          outcomeId: workingOutcomeId,
          outcomeVersion,
        });
        if (item.gapItemId) {
          this.options.journalRepository.updateGapItem(caseId, item.gapItemId, { status: 'applied' });
        }
        return { itemId: item.id, title: item.title, status: 'applied', outcomeVersion, note: result.applied.edit.note || '已应用' };
      }
      const note = result.status === 'completed'
        ? `AI 未产生可应用的修改：${result.diagnostics.at(-1)?.message ?? '无诊断信息'}`
        : `成果助手执行失败（${result.code}）：${result.message}`;
      this.options.journalRepository.updatePlanItem(planId, item.id, { status: 'failed', beforeText, afterText: note });
      return { itemId: item.id, title: item.title, status: 'failed', outcomeVersion: null, note };
    } catch (error) {
      const note = `条目执行异常：${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
      this.options.journalRepository.updatePlanItem(planId, item.id, { status: 'failed', afterText: note });
      return { itemId: item.id, title: item.title, status: 'failed', outcomeVersion: null, note };
    }
  }
}
