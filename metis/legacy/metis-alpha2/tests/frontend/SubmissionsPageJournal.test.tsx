/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import type { SubmissionCase } from '../../engine/submission/SubmissionRuntimeContract.js';
import type {
  JournalCorpusItem,
  JournalPatternObservation,
  JournalProfile,
  JournalProfileSnapshot,
  JournalRequirement,
  SubmissionGapItem,
  SubmissionOptimizationItem,
  SubmissionOptimizationPlan,
} from '../../engine/submission/JournalProfileContract.js';

function caseFixture(overrides: Partial<SubmissionCase> = {}): SubmissionCase {
  return {
    contractVersion: 1, id: 'case-1', seriesId: 'series-1', projectId: 'project-1',
    title: '生成式AI研究论文', status: 'JOURNAL_SELECTED', articleType: 'research_article',
    targetJournalName: 'Journal A', targetJournalId: null,
    sourceOutcomeId: 'out-1', sourceOutcomeVersion: 3,
    workingOutcomeId: null, workingOutcomeVersion: null, submittedOutcomeVersion: null,
    submissionMethod: null, submissionPortalUrl: '', remoteSubmissionId: '', notes: '',
    createdAt: 1, updatedAt: 2, submittedAt: null, decisionAt: null, acceptedAt: null, publishedAt: null,
    ...overrides,
  };
}

const PROFILE: JournalProfile = {
  id: 'jp-1', projectId: 'project-1', canonicalName: 'Journal of Testing',
  issn: '1234-5678', publisher: 'Test Publisher',
  homepageUrl: 'https://journal.example.com', submissionPortalUrl: 'https://submit.example.com',
  platform: 'editorial_manager', articleTypes: ['research_article'], createdAt: 1, updatedAt: 2,
};

const SNAPSHOT: JournalProfileSnapshot = {
  id: 'snap-1', profileId: 'jp-1', caseId: 'case-1', retrievedAt: 1700000000000, note: '', createdAt: 1,
};

const REQUIREMENT: JournalRequirement = {
  id: 'req-1', snapshotId: 'snap-1', ruleKey: 'word_limit', valueText: '正文不超过 8000 字',
  ruleType: 'official_requirement', sourceUrl: 'https://journal.example.com/guidelines',
  sourceTitle: 'Author Guidelines', evidenceSnippet: 'Manuscripts should not exceed 8,000 words.',
  confidence: 'high', retrievedAt: 1700000000000, createdAt: 1, updatedAt: 1,
};

const OBSERVATION: JournalPatternObservation = {
  id: 'obs-1', snapshotId: 'snap-1', patternKey: 'abstract',
  observation: '摘要普遍采用结构化四段式写法', evidenceLevel: 'abstract',
  sampleSize: 12, supportingItemIds: ['corpus-1'], confidence: 'medium', createdAt: 1,
};

const CORPUS_ITEM: JournalCorpusItem = {
  id: 'corpus-1', profileId: 'jp-1', snapshotId: 'snap-1', title: 'A recent paper',
  authors: ['Smith'], year: 2025, doi: '', url: 'https://journal.example.com/paper/1',
  abstract: '', source: 'openalex', venueName: 'Journal of Testing', issn: '1234-5678',
  similarityScore: 0.87, fulltextAvailable: true, createdAt: 1,
};

function gapFixture(overrides: Partial<SubmissionGapItem> = {}): SubmissionGapItem {
  return {
    id: 'gap-1', caseId: 'case-1', severity: 'must_fix', title: '摘要超出字数限制',
    problem: '摘要 320 字，超出该刊 250 字上限', evidence: 'Author Guidelines: abstract ≤ 250 words',
    sourceType: 'official_requirement', affectedLocation: '摘要', recommendedAction: '压缩摘要至 250 字以内',
    requiresResearcherJudgment: false, estimatedImpact: 'high', status: 'open', createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

const PLAN: SubmissionOptimizationPlan = {
  id: 'plan-1', caseId: 'case-1', status: 'draft', createdAt: 1, updatedAt: 1,
  approvedAt: null, appliedAt: null,
};

const PLAN_ITEMS: SubmissionOptimizationItem[] = [
  {
    id: 'item-1', planId: 'plan-1', gapItemId: 'gap-1', title: '压缩摘要',
    action: '将摘要压缩至 250 字以内', risk: '', involvesResearcherJudgment: false,
    status: 'pending', beforeText: '', afterText: '', outcomeId: null, outcomeVersion: null, createdAt: 1, updatedAt: 1,
  },
  {
    id: 'item-2', planId: 'plan-1', gapItemId: null, title: '调整章节顺序',
    action: '按该刊惯例调整章节顺序', risk: '可能改变叙事结构', involvesResearcherJudgment: true,
    status: 'pending', beforeText: '', afterText: '', outcomeId: null, outcomeVersion: null, createdAt: 1, updatedAt: 1,
  },
];

function journalData() {
  return { profile: PROFILE, snapshot: SNAPSHOT, requirements: [REQUIREMENT], observations: [OBSERVATION], corpus: [CORPUS_ITEM] };
}

function installMetis(overrides: Record<string, unknown> = {}): void {
  window.metis = {
    listSubmissionCases: vi.fn().mockResolvedValue([caseFixture()]),
    listSubmissionEvents: vi.fn().mockResolvedValue([]),
    changeSubmissionStatus: vi.fn().mockResolvedValue(caseFixture({ status: 'PROFILING' })),
    updateSubmissionCase: vi.fn().mockResolvedValue(caseFixture()),
    identifySubmissionJournal: vi.fn().mockResolvedValue({ ok: true, profile: PROFILE }),
    getSubmissionJournalProfile: vi.fn().mockResolvedValue(journalData()),
    fetchSubmissionJournalGuidelines: vi.fn().mockResolvedValue({ ok: true, snapshot: SNAPSHOT, requirements: [REQUIREMENT], extraction: 'llm' }),
    diffSubmissionJournalSnapshots: vi.fn().mockResolvedValue(null),
    buildSubmissionJournalCorpus: vi.fn().mockResolvedValue({ ok: true, items: [CORPUS_ITEM] }),
    analyzeSubmissionJournalPatterns: vi.fn().mockResolvedValue({ ok: true, observations: [OBSERVATION] }),
    diagnoseSubmissionCase: vi.fn().mockResolvedValue({
      ok: true,
      items: [gapFixture(), gapFixture({ id: 'gap-2', severity: 'optional', title: '关键词数量可优化', problem: '当前 3 个关键词，该刊近年论文多为 5 个', evidence: '语料归纳', sourceType: 'published_pattern', requiresResearcherJudgment: true })],
    }),
    createSubmissionOptimizationPlan: vi.fn().mockResolvedValue({ ok: true, plan: PLAN, items: PLAN_ITEMS }),
    getSubmissionOptimizationPlan: vi.fn().mockResolvedValue(null),
    approveSubmissionOptimizationPlan: vi.fn().mockResolvedValue({ ok: true }),
    applySubmissionOptimizationPlan: vi.fn().mockResolvedValue({ ok: true }),
    verifySubmissionOptimizationPlan: vi.fn().mockResolvedValue({ ok: true, passed: true, remaining: [] }),
    updateSubmissionGapItem: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as typeof window.metis;
}

describe('SubmissionsPage 期刊研究（P1）', () => {
  beforeEach(() => {
    window.metis = undefined;
    researchWorkspaceStore.setState({ activeProjectId: 'project-1' });
  });

  it('JOURNAL_SELECTED 状态渲染期刊身份卡与抓取按钮', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect(await screen.findByText('Journal of Testing')).toBeTruthy();
    expect(screen.getByText('1234-5678')).toBeTruthy();
    expect(screen.getByText('Test Publisher')).toBeTruthy();
    expect(screen.getByText('抓取官方投稿要求')).toBeTruthy();
    // 身份卡含主页与投稿平台链接。
    expect(screen.getByRole('link', { name: 'https://journal.example.com' })).toBeTruthy();
  });

  it('抓取成功后渲染官方要求清单（含来源链接）', async () => {
    // 首次加载尚无要求；抓取落库后重新加载即可见。
    const getProfile = vi.fn()
      .mockResolvedValueOnce({ ...journalData(), requirements: [] })
      .mockResolvedValue(journalData());
    installMetis({ getSubmissionJournalProfile: getProfile });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByText('抓取官方投稿要求'));
    expect(await screen.findByText('正文不超过 8000 字')).toBeTruthy();
    // 按 ruleKey 分组的中文化标签。
    expect(screen.getByText('稿件长度')).toBeTruthy();
    const source = screen.getByRole('link', { name: 'Author Guidelines' }) as HTMLAnchorElement;
    expect(source.href).toBe('https://journal.example.com/guidelines');
  });

  it('范式观察醒目标注「经验范式（非官方要求）」', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    const badges = await screen.findAllByText('经验范式（非官方要求）');
    expect(badges.length).toBeGreaterThan(0);
    expect(screen.getByText('摘要普遍采用结构化四段式写法')).toBeTruthy();
    expect(screen.getByText('样本数 12')).toBeTruthy();
    expect(screen.getByText('含摘要')).toBeTruthy();
  });

  it('诊断后按三级严重度分组渲染差距清单', async () => {
    installMetis({
      listSubmissionCases: vi.fn().mockResolvedValue([caseFixture({ status: 'DIAGNOSING' })]),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByText('开始诊断'));
    expect(await screen.findByText('必须修改')).toBeTruthy();
    expect(screen.getByText('可选优化')).toBeTruthy();
    expect(screen.getByText('摘要超出字数限制')).toBeTruthy();
    expect(screen.getByText('需要研究者判断')).toBeTruthy();
    expect(window.metis!.diagnoseSubmissionCase).toHaveBeenCalledWith({ projectId: 'project-1', caseId: 'case-1' });
  });

  it('方案勾选 → 批准 → 执行调用链参数正确', async () => {
    installMetis({
      listSubmissionCases: vi.fn().mockResolvedValue([caseFixture({ status: 'DIAGNOSING' })]),
      getSubmissionOptimizationPlan: vi.fn().mockResolvedValue({ plan: PLAN, items: PLAN_ITEMS }),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '压缩摘要' }));
    fireEvent.click(screen.getByText('批准并执行所选'));
    await waitFor(() => expect(window.metis!.approveSubmissionOptimizationPlan).toHaveBeenCalledWith({
      projectId: 'project-1', planId: 'plan-1', selectedItemIds: ['item-1'],
    }));
    await waitFor(() => expect(window.metis!.applySubmissionOptimizationPlan).toHaveBeenCalledWith({
      projectId: 'project-1', planId: 'plan-1', caseId: 'case-1',
    }));
  });

  it('抓取失败显示人性化错误文案且不崩溃', async () => {
    installMetis({
      fetchSubmissionJournalGuidelines: vi.fn().mockResolvedValue({ ok: false, code: 'not_found' }),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByText('抓取官方投稿要求'));
    expect(await screen.findByText('未找到该期刊的官方投稿要求页面。')).toBeTruthy();
  });
});
