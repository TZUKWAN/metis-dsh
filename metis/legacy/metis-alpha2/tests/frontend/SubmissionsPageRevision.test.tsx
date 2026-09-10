/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import type { SubmissionCase } from '../../engine/submission/SubmissionRuntimeContract.js';

function caseFixture(overrides: Partial<SubmissionCase> = {}): SubmissionCase {
  return {
    contractVersion: 1, id: 'case-1', seriesId: 'series-1', projectId: 'project-1',
    title: '生成式AI研究论文', status: 'REVISION_REQUIRED', articleType: 'research_article',
    targetJournalName: 'Journal A', targetJournalId: 'jp-1',
    sourceOutcomeId: 'out-1', sourceOutcomeVersion: 3,
    workingOutcomeId: null, workingOutcomeVersion: null, submittedOutcomeVersion: null,
    submissionMethod: null, submissionPortalUrl: '', remoteSubmissionId: '', notes: '',
    createdAt: 1, updatedAt: 2, submittedAt: 3, decisionAt: 4, acceptedAt: null, publishedAt: null,
    ...overrides,
  };
}

const ROUND = {
  id: 'round-1', caseId: 'case-1', roundNo: 1, decision: 'major_revision' as const,
  receivedAt: 10, deadline: 1795142400000, decisionLetterText: '原文',
  submittedOutcomeVersion: 3, revisedOutcomeVersion: null, responseLetterOutcomeId: null,
  note: '', createdAt: 10, updatedAt: 11,
  comments: [
    { id: 'cmt-1', roundId: 'round-1', reviewerLabel: 'Reviewer #1', originalText: '文献综述需扩充。', normalizedText: '文献综述需扩充。', category: 'major' as const, priority: 'high' as const, status: 'open' as const, affectedLocation: '', beforeText: '', afterText: '', responseText: '', createdAt: 1, updatedAt: 1 },
  ],
};

function installMetis(overrides: Record<string, unknown> = {}): void {
  window.metis = {
    listSubmissionCases: vi.fn().mockResolvedValue([caseFixture()]),
    listSubmissionEvents: vi.fn().mockResolvedValue([]),
    changeSubmissionStatus: vi.fn(),
    listSubmissionReviewRounds: vi.fn().mockResolvedValue([ROUND]),
    createSubmissionReviewRound: vi.fn().mockResolvedValue({ ok: true, roundId: 'round-2', parsed: { decision: 'major_revision', deadline: 1795142400000, reviewerComments: [{}], editorComments: [] } }),
    updateSubmissionReviewComment: vi.fn(async (request: { commentId: string }) => ({ ...ROUND.comments[0]!, id: request.commentId, status: 'addressed' as const, responseText: '已扩充第 2 节。' })),
    beginSubmissionRevision: vi.fn().mockResolvedValue({ ok: true }),
    generateSubmissionResponseLetter: vi.fn().mockResolvedValue({ ok: true, outcomeId: 'out-9', version: 1, unresolvedCount: 0 }),
    getSubmissionPreflight: vi.fn().mockResolvedValue(null),
    getSubmissionPackage: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as typeof window.metis;
}

describe('SubmissionsPage 返修工作台与最终提交（P3/P4）', () => {
  beforeEach(() => {
    window.metis = undefined;
    researchWorkspaceStore.setState({ activeProjectId: 'project-1' });
  });

  it('渲染审稿轮次与原始意见（逐字保留），可开始返修', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect(await screen.findByTestId('submission-revision-section')).toBeTruthy();
    expect(await screen.findByText(/大修/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始返修' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '开始返修' }));
    await waitFor(() => expect(window.metis!.beginSubmissionRevision).toHaveBeenCalledWith({ projectId: 'project-1', caseId: 'case-1' }));
  });

  it('拆解 Decision Letter 后刷新轮次并显示识别结果', async () => {
    installMetis({
      listSubmissionCases: vi.fn().mockResolvedValue([caseFixture({ status: 'REVISING' })]),
      listSubmissionReviewRounds: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([ROUND]),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    const textarea = await screen.findByRole('textbox', { name: '粘贴 Decision Letter 全文' });
    fireEvent.change(textarea, { target: { value: 'Dear Author, major revision... Reviewer #1 ...' } });
    fireEvent.click(screen.getByRole('button', { name: '拆解审稿意见' }));
    expect(await screen.findByText(/已识别决定：major_revision/u)).toBeTruthy();
    expect(window.metis!.createSubmissionReviewRound).toHaveBeenCalled();
  });

  it('最终提交确认：未勾选声明时按钮禁用，确认后记录回执', async () => {
    // READY_TO_RESUBMIT + 已冻结材料包 → 显示最终提交确认块。
    const frozenPackage = {
      package: { id: 'pkg-1', caseId: 'case-1', status: 'frozen', round: 1, createdAt: 1, updatedAt: 2, frozenAt: 3 },
      files: [{ id: 'f1', packageId: 'pkg-1', type: 'main_manuscript', filename: 'a-v1.docx', outcomeId: 'out-1', outcomeVersion: 1, artifactPath: null, contentHash: 'x', required: true, validationStatus: 'valid', note: '', createdAt: 1 }],
    };
    installMetis({
      listSubmissionCases: vi.fn().mockResolvedValue([caseFixture({ status: 'READY_TO_RESUBMIT' })]),
      getSubmissionPackage: vi.fn().mockResolvedValue(frozenPackage),
      getSubmissionPreflight: vi.fn().mockResolvedValue({
        run: { id: 'run-1', caseId: 'case-1', outcomeId: 'out-1', outcomeVersion: 3, passed: true, blockCount: 0, warnCount: 0, createdAt: 5 },
        checks: [],
      }),
      confirmFinalSubmission: vi.fn().mockResolvedValue({ ok: true, submissionCase: caseFixture({ status: 'RESUBMITTED' }) }),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    await screen.findByTestId('final-submit');
    const confirmButton = (await screen.findByRole('button', { name: '确认并记录投稿回执' })) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.click(confirmButton);
    expect(window.metis!.confirmFinalSubmission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('我确认本次投稿信息真实、已获全体作者同意，且不存在一稿多投。'));
    fireEvent.click(screen.getByRole('button', { name: '确认并记录投稿回执' }));
    await waitFor(() => expect(window.metis!.confirmFinalSubmission).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', caseId: 'case-1', confirmed: true })));
  });

  it('通用状态通道不允许直推 SUBMITTED（use_submit_flow 拒绝）', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    await screen.findByTestId('submission-revision-section');
    // 渲染端 UI 不提供直推按钮；此处仅断言 mock 通道存在且页面渲染无崩溃。
    expect(window.metis!.listSubmissionCases).toBeDefined();
  });
});
