/** @vitest-environment node */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type { AgentRunResult } from '../../engine/core/types.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { JournalProfileRepository } from '../../electron/JournalProfileRepository.js';
import { OutcomeAssistantService } from '../../electron/OutcomeAssistantService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { SubmissionGapService } from '../../electron/SubmissionGapService.js';
import { SubmissionOptimizationService } from '../../electron/SubmissionOptimizationService.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';

// ─── 测试工具 ────────────────────────────────────────────────

type WordBlock = WordDocument['blocks'][number];
const heading = (id: string, text: string): WordBlock => ({ id, kind: 'heading', level: 1, text });
const paragraph = (id: string, text: string): WordBlock => ({ id, kind: 'paragraph', text });

function manuscriptDoc(bodyText: string): WordDocument {
  return {
    type: 'word',
    page: {},
    header: '',
    footer: '',
    blocks: [
      heading('b-title', 'A Study of Testing Methods'),
      heading('b-abs-h', 'Abstract'),
      paragraph('b-abs', 'This paper studies testing methods for desktop research tools.'),
      heading('b-kw-h', 'Keywords'),
      paragraph('b-kw', 'testing, tools, research'),
      heading('b-intro', 'Introduction'),
      paragraph('b-body', bodyText),
      heading('b-ref-h', 'References'),
      paragraph('b-r1', '[1] Smith 2020 Testing.'),
      paragraph('b-r2', '[2] Lee 2021 Methods.'),
    ],
  };
}

function completedRun(finalText: string): AgentRunResult {
  return {
    status: 'completed',
    finalText,
    finalVerified: true,
    messages: [],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    errors: [],
    traceEvents: [],
  };
}

/** 假 agentLoop：返回固定 finalText；calls 计数用于断言「未被调用」。 */
function fakeAgentLoop(finalText: string): { run: () => Promise<AgentRunResult>; calls: () => number } {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      return completedRun(finalText);
    },
    calls: () => calls,
  };
}

const assistantAnswer = (edit: unknown) => JSON.stringify({ answer: '已按投稿优化指令修改稿件。', edit });

// ─── 测试主体 ────────────────────────────────────────────────

describe('SubmissionGapService + SubmissionOptimizationService', () => {
  let db: Database.Database;
  let outcomeRepo: OutcomeRepository;
  let submissionRepo: SubmissionRepository;
  let journalRepo: JournalProfileRepository;
  let gapService: SubmissionGapService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
    outcomeRepo = new OutcomeRepository(db);
    submissionRepo = new SubmissionRepository(db);
    journalRepo = new JournalProfileRepository(db);
    gapService = new SubmissionGapService({
      submissionRepository: submissionRepo,
      journalRepository: journalRepo,
      outcomeRepository: outcomeRepo,
    });
  });

  function makeAssistant(finalText: string) {
    const loop = fakeAgentLoop(finalText);
    const service = new OutcomeAssistantService({
      repository: outcomeRepo,
      agentLoop: loop,
      modelName: 'mock-model',
      projectContext: { collect: () => ({ sources: [], prompt: '', diagnostics: [] }) },
    });
    return { service, calls: loop.calls };
  }

  function makeOptimizationService(assistant?: OutcomeAssistantService) {
    return new SubmissionOptimizationService({
      submissionRepository: submissionRepo,
      journalRepository: journalRepo,
      outcomeRepository: outcomeRepo,
      gapService,
      ...(assistant ? { assistant } : {}),
    });
  }

  /** 建源成果（v1）+ case；带 journal 时建 profile/snapshot 并回填 targetJournalId。 */
  function seedCase(options: { bodyWords?: number; withJournal?: boolean; requirements?: Parameters<JournalProfileRepository['replaceRequirements']>[1] }) {
    const source = outcomeRepo.create({
      projectId: 'p1',
      categoryId: null,
      title: '论文一',
      kind: 'word',
      content: manuscriptDoc('word '.repeat(options.bodyWords ?? 10)),
      note: '初稿',
    });
    const { submissionCase } = submissionRepo.createCase({
      projectId: 'p1',
      title: '论文一',
      sourceOutcomeId: source.outcome.id,
      sourceOutcomeVersion: 1,
      targetJournalName: 'Journal of Testing',
    });
    let snapshotId: string | null = null;
    if (options.withJournal) {
      const profile = journalRepo.upsertProfile('p1', { canonicalName: 'Journal of Testing' });
      snapshotId = journalRepo.createSnapshot(profile.id, submissionCase.id, '调研').id;
      if (options.requirements) journalRepo.replaceRequirements(snapshotId, options.requirements);
      submissionRepo.updateCase('p1', { caseId: submissionCase.id, targetJournalId: profile.id });
    }
    return { source, submissionCase, snapshotId };
  }

  const WORD_LIMIT_REQUIREMENT = [{
    ruleKey: 'word_limit' as const,
    valueText: '正文不超过 100 词',
    sourceUrl: 'https://example.com/author-guidelines',
    sourceTitle: 'Author Guidelines',
    evidenceSnippet: 'Manuscripts should not exceed 100 words.',
    confidence: 'high' as const,
  }];

  // ── diagnose ───────────────────────────────────────────────

  it('diagnose 字数超限 → must_fix + evidence 完整，且重复运行不重复落库', async () => {
    const { submissionCase } = seedCase({ bodyWords: 140, withJournal: true, requirements: WORD_LIMIT_REQUIREMENT });
    const result = await gapService.diagnose({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gap = result.items.find((item) => item.title === '全文篇幅超出期刊字数上限');
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe('must_fix');
    expect(gap!.sourceType).toBe('official_requirement');
    // evidence 同时引用要求原文摘录与稿件实测数值。
    expect(gap!.evidence).toContain('Manuscripts should not exceed 100 words.');
    expect(gap!.evidence).toMatch(/稿件实测：全文约 1\d\d 词\/字/u);
    expect(gap!.recommendedAction).toContain('100');
    // 已真实落库。
    expect(journalRepo.listGapItems(submissionCase.id, 'open')).toHaveLength(1);
    // 幂等：再次 diagnose 不产生重复 open 项。
    const again = await gapService.diagnose({ projectId: 'p1', caseId: submissionCase.id });
    expect(again.ok && again.items).toHaveLength(1);
    expect(journalRepo.listGapItems(submissionCase.id)).toHaveLength(1);
  });

  it('diagnose 无任何期刊要求数据时不编造差距', async () => {
    const { submissionCase } = seedCase({ bodyWords: 5000, withJournal: false });
    const result = await gapService.diagnose({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
    expect(journalRepo.listGapItems(submissionCase.id)).toHaveLength(0);
  });

  it('diagnose 范式项标为 published_pattern 而非 official_requirement，低证据观察不采纳', async () => {
    const { submissionCase, snapshotId } = seedCase({ withJournal: true, requirements: [] });
    journalRepo.replacePatternObservations(snapshotId!, [
      {
        patternKey: 'abstract',
        observation: '近年摘要普遍采用结构化四段式',
        evidenceLevel: 'abstract',
        sampleSize: 5,
        confidence: 'high',
      },
      {
        patternKey: 'title',
        observation: '标题普遍偏短',
        evidenceLevel: 'metadata_only',
        sampleSize: 1,
      },
    ]);
    const result = await gapService.diagnose({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    const pattern = result.items[0]!;
    expect(pattern.sourceType).toBe('published_pattern');
    expect(pattern.severity).toBe('strongly_recommended');
    expect(pattern.evidence).toContain('近期 5 篇样本');
    expect(pattern.evidence).toContain('非官方硬性要求');
    // 低证据观察（metadata_only / 样本 1）不产生差距项。
    expect(result.items.some((item) => item.title.includes('title'))).toBe(false);
    // 任何范式观察都不得进入 official_requirement。
    expect(result.items.every((item) => item.sourceType !== 'official_requirement')).toBe(true);
  });

  // ── 方案全流程 ─────────────────────────────────────────────

  it('createPlanFromGaps → approve → apply → verify 全流程：分叉工作稿、源成果版本不变', async () => {
    const { source, submissionCase } = seedCase({ bodyWords: 140, withJournal: true, requirements: WORD_LIMIT_REQUIREMENT });
    const diagnosed = await gapService.diagnose({ projectId: 'p1', caseId: submissionCase.id });
    expect(diagnosed.ok).toBe(true);
    if (!diagnosed.ok) return;
    const gap = diagnosed.items[0]!;

    const { service: assistant } = makeAssistant(assistantAnswer({
      kind: 'word',
      replacements: [{ blockId: 'b-body', text: 'A concise revised body.' }],
      note: '压缩正文至字数上限内',
    }));
    const optimization = makeOptimizationService(assistant);

    // 1. 建方案：gap → plan item 字段映射正确，gap 转 planned。
    const created = await optimization.createPlanFromGaps({ projectId: 'p1', caseId: submissionCase.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.plan.status).toBe('draft');
    expect(created.items).toHaveLength(1);
    const planItem = created.items[0]!;
    expect(planItem.gapItemId).toBe(gap.id);
    expect(planItem.title).toBe(gap.title);
    expect(planItem.action).toBe(gap.recommendedAction);
    expect(planItem.involvesResearcherJudgment).toBe(false);
    expect(journalRepo.listGapItems(submissionCase.id, 'planned')).toHaveLength(1);

    // 2. 审批：未给 selectedItemIds → 全部 selected。
    const approved = await optimization.approvePlan({ projectId: 'p1', planId: created.plan.id });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.plan.status).toBe('approved');
    expect(approved.items[0]!.status).toBe('selected');

    // 3. 应用：分叉工作稿 + AI 修改落新版本。
    const applied = await optimization.applyPlan({ projectId: 'p1', planId: created.plan.id, caseId: submissionCase.id });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.results).toHaveLength(1);
    expect(applied.results[0]!.status).toBe('applied');
    expect(applied.results[0]!.outcomeVersion).toBe(2);
    expect(applied.plan.status).toBe('applied');

    const updatedCase = submissionRepo.getCase('p1', submissionCase.id)!;
    // 工作稿是分叉出的新成果，绝不是源成果本身。
    expect(updatedCase.workingOutcomeId).toBeTruthy();
    expect(updatedCase.workingOutcomeId).not.toBe(source.outcome.id);
    expect(updatedCase.workingOutcomeVersion).toBe(2);
    const working = outcomeRepo.get('p1', updatedCase.workingOutcomeId!)!;
    expect(working.outcome.title).toBe('论文一｜Journal of Testing投稿版');
    const workingDoc = working.version.content as WordDocument;
    expect(workingDoc.blocks.find((block) => block.id === 'b-body')!.text).toBe('A concise revised body.');

    // 源成果与其版本链完全未被触碰。
    const sourceAfter = outcomeRepo.get('p1', source.outcome.id)!;
    expect(sourceAfter.outcome.currentVersion).toBe(1);
    const sourceDoc = sourceAfter.version.content as WordDocument;
    expect(sourceDoc.blocks.find((block) => block.id === 'b-body')!.text).toBe('word '.repeat(140));

    // 条目回链到工作稿新版本；gap 转 applied。
    const storedItem = journalRepo.listPlanItems(created.plan.id)[0]!;
    expect(storedItem.status).toBe('applied');
    expect(storedItem.outcomeId).toBe(updatedCase.workingOutcomeId);
    expect(storedItem.outcomeVersion).toBe(2);
    expect(storedItem.beforeText).toContain('word word');
    expect(storedItem.afterText).toContain('A concise revised body.');
    expect(journalRepo.listGapItems(submissionCase.id)[0]!.status).toBe('applied');

    // 时间线记录 optimization_applied（agent 来源）。
    const events = submissionRepo.listEvents('p1', submissionCase.id);
    expect(events.some((event) => event.type === 'optimization_applied' && event.source === 'agent')).toBe(true);

    // 4. 复核：字数已回到上限内 → verified。
    const verified = await optimization.verifyPlan({ projectId: 'p1', planId: created.plan.id });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.verified).toBe(true);
    expect(verified.residualMustFix).toHaveLength(0);
    expect(verified.plan.status).toBe('verified');
    expect(journalRepo.listGapItems(submissionCase.id)[0]!.status).toBe('verified');
  });

  it('involvesResearcherJudgment 的条目不会被自动修改', async () => {
    const { source, submissionCase } = seedCase({ withJournal: false });
    journalRepo.createGapItems(submissionCase.id, [
      {
        severity: 'must_fix',
        title: '补充基金资助信息',
        problem: '缺少基金声明',
        evidence: 'Author Guidelines: funding statement required.',
        sourceType: 'official_requirement',
        recommendedAction: '在致谢前补充基金资助声明',
        requiresResearcherJudgment: true,
      },
      {
        severity: 'optional',
        title: '润色引言措辞',
        problem: '引言可以更简洁',
        evidence: '稿件引言段落冗长',
        sourceType: 'manuscript',
        recommendedAction: '精简引言',
        requiresResearcherJudgment: false,
      },
    ]);
    const { service: assistant, calls } = makeAssistant(assistantAnswer({
      kind: 'word',
      replacements: [{ blockId: 'b-body', text: 'Polished introduction.' }],
      note: '润色',
    }));
    const optimization = makeOptimizationService(assistant);

    const created = await optimization.createPlanFromGaps({ projectId: 'p1', caseId: submissionCase.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.items).toHaveLength(2);
    const approved = await optimization.approvePlan({ projectId: 'p1', planId: created.plan.id });
    expect(approved.ok).toBe(true);

    const applied = await optimization.applyPlan({ projectId: 'p1', planId: created.plan.id, caseId: submissionCase.id });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const byTitle = new Map(applied.results.map((result) => [result.title, result]));
    // 涉及研究者判断的条目：skipped + 注明未自动修改。
    expect(byTitle.get('补充基金资助信息')!.status).toBe('skipped');
    expect(byTitle.get('润色引言措辞')!.status).toBe('applied');
    // 助手只被调用了 1 次（非 judgment 条目）。
    expect(calls()).toBe(1);
    const judgmentItem = journalRepo.listPlanItems(created.plan.id).find((item) => item.title === '补充基金资助信息')!;
    expect(judgmentItem.status).toBe('skipped');
    expect(judgmentItem.afterText).toContain('需要研究者确认，未自动修改');
    expect(judgmentItem.outcomeVersion).toBeNull();
    // 工作稿只产生了一个 AI 版本（分叉 v1 + 润色 v2）；源成果不变。
    const updatedCase = submissionRepo.getCase('p1', submissionCase.id)!;
    expect(outcomeRepo.get('p1', updatedCase.workingOutcomeId!)!.outcome.currentVersion).toBe(2);
    expect(outcomeRepo.get('p1', source.outcome.id)!.outcome.currentVersion).toBe(1);
    expect(applied.plan.status).toBe('applied');
  });

  it('approvePlan 支持部分选择：未选中的条目置 skipped', async () => {
    const { submissionCase } = seedCase({ withJournal: false });
    journalRepo.createGapItems(submissionCase.id, [
      { severity: 'must_fix', title: '问题甲', sourceType: 'official_requirement', recommendedAction: '改甲' },
      { severity: 'optional', title: '问题乙', sourceType: 'manuscript', recommendedAction: '改乙' },
    ]);
    const optimization = makeOptimizationService();
    const created = await optimization.createPlanFromGaps({ projectId: 'p1', caseId: submissionCase.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [first, second] = created.items;
    const approved = await optimization.approvePlan({ projectId: 'p1', planId: created.plan.id, selectedItemIds: [first!.id] });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.plan.status).toBe('approved');
    expect(approved.items.find((item) => item.id === first!.id)!.status).toBe('selected');
    expect(approved.items.find((item) => item.id === second!.id)!.status).toBe('skipped');
  });

  it('applyPlan 在非 approved 状态被结构化拒绝', async () => {
    const { submissionCase } = seedCase({ withJournal: false });
    journalRepo.createGapItems(submissionCase.id, [
      { severity: 'must_fix', title: '问题甲', sourceType: 'official_requirement', recommendedAction: '改甲' },
    ]);
    const optimization = makeOptimizationService();
    const created = await optimization.createPlanFromGaps({ projectId: 'p1', caseId: submissionCase.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // draft 状态直接应用 → 拒绝，且方案状态不变。
    const rejected = await optimization.applyPlan({ projectId: 'p1', planId: created.plan.id, caseId: submissionCase.id });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('plan_not_approved');
    expect(journalRepo.getPlan(created.plan.id)!.status).toBe('draft');
    // 其他 case 的 planId 也拒绝。
    const mismatched = await optimization.applyPlan({ projectId: 'p1', planId: created.plan.id, caseId: 'case-x' });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.code).toBe('plan_case_mismatch');
  });

  it('verifyPlan 发现残留 must_fix 时不置 verified，返回残留清单', async () => {
    const { submissionCase } = seedCase({ bodyWords: 140, withJournal: true, requirements: WORD_LIMIT_REQUIREMENT });
    await gapService.diagnose({ projectId: 'p1', caseId: submissionCase.id });
    // 助手「改了但没改够」：仍然超限。
    const { service: assistant } = makeAssistant(assistantAnswer({
      kind: 'word',
      replacements: [{ blockId: 'b-body', text: 'filler '.repeat(120).trimEnd() }],
      note: '压缩正文',
    }));
    const optimization = makeOptimizationService(assistant);
    const created = await optimization.createPlanFromGaps({ projectId: 'p1', caseId: submissionCase.id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await optimization.approvePlan({ projectId: 'p1', planId: created.plan.id });
    const applied = await optimization.applyPlan({ projectId: 'p1', planId: created.plan.id, caseId: submissionCase.id });
    expect(applied.ok).toBe(true);

    const verified = await optimization.verifyPlan({ projectId: 'p1', planId: created.plan.id });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    // 改了就默认通过是被禁止的：确定性复核发现字数仍超限。
    expect(verified.verified).toBe(false);
    expect(verified.residualMustFix).toHaveLength(1);
    expect(verified.residualMustFix[0]!.title).toBe('全文篇幅超出期刊字数上限');
    expect(verified.plan.status).toBe('applied');
    expect(journalRepo.getPlan(created.plan.id)!.status).toBe('applied');
  });
});
