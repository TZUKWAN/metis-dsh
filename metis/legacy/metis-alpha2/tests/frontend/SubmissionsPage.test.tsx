/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import type { SubmissionCase } from '../../engine/submission/SubmissionRuntimeContract.js';

function caseFixture(overrides: Partial<SubmissionCase> = {}): SubmissionCase {
  return {
    contractVersion: 1, id: 'case-1', seriesId: 'series-1', projectId: 'project-1',
    title: '生成式AI研究论文', status: 'UNDER_REVIEW', articleType: 'research_article',
    targetJournalName: 'Journal A', targetJournalId: null,
    sourceOutcomeId: 'out-1', sourceOutcomeVersion: 3,
    workingOutcomeId: null, workingOutcomeVersion: null, submittedOutcomeVersion: 3,
    submissionMethod: null, submissionPortalUrl: '', remoteSubmissionId: '', notes: '',
    createdAt: 1, updatedAt: 2, submittedAt: 2, decisionAt: null, acceptedAt: null, publishedAt: null,
    ...overrides,
  };
}

function installMetis(overrides: Record<string, unknown> = {}): void {
  window.metis = {
    listSubmissionCases: vi.fn().mockResolvedValue([caseFixture()]),
    listSubmissionEvents: vi.fn().mockResolvedValue([
      { id: 'e1', caseId: 'case-1', type: 'submitted', description: 'DRAFT → SUBMITTED', source: 'human', createdAt: 10 },
    ]),
    changeSubmissionStatus: vi.fn().mockResolvedValue(caseFixture({ status: 'REVISION_REQUIRED', decisionAt: 5 })),
    updateSubmissionCase: vi.fn().mockResolvedValue(caseFixture({ notes: '备注A' })),
    createSubmissionCase: vi.fn().mockResolvedValue({ ok: true, series: { contractVersion: 1, id: 's1', projectId: 'project-1', sourceOutcomeId: 'out-1', title: '', notes: '', createdAt: 1, updatedAt: 1 }, submissionCase: caseFixture({ id: 'case-2', status: 'JOURNAL_SELECTED' }) }),
    listOutcomes: vi.fn().mockResolvedValue([{ id: 'out-1', title: '论文一', kind: 'word', currentVersion: 3 }]),
    ...overrides,
  } as unknown as typeof window.metis;
}

describe('SubmissionsPage（投稿驾驶舱 P0）', () => {
  beforeEach(() => {
    window.metis = undefined;
    researchWorkspaceStore.setState({ activeProjectId: 'project-1' });
  });

  it('renders the case list and case detail with lifecycle stages and timeline', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect((await screen.findAllByText('生成式AI研究论文')).length).toBeGreaterThan(0);
    expect(screen.getByText('审稿中')).toBeTruthy();
    // 生命周期阶段条：跟踪阶段高亮（当前）。
    expect(screen.getByText('跟踪').className).toContain('current');
    // Timeline 事件可见。
    expect(await screen.findByText('DRAFT → SUBMITTED')).toBeTruthy();
    // 事实卡：已提交冻结版本可见。
    expect(screen.getByText('v3')).toBeTruthy();
  });

  it('advances the status through the persisted state machine', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect((await screen.findAllByText('生成式AI研究论文')).length).toBeGreaterThan(0);
    // UNDER_REVIEW 的合法下一状态包含 REVISION_REQUIRED。
    const select = screen.getByLabelText('选择下一状态') as HTMLSelectElement;
    const options = [...select.options].map((option) => option.value);
    expect(options).toContain('REVISION_REQUIRED');
    expect(options).not.toContain('DRAFT');
    fireEvent.change(select, { target: { value: 'REVISION_REQUIRED' } });
    fireEvent.click(screen.getByText('确认推进'));
    await waitFor(() => expect(window.metis!.changeSubmissionStatus).toHaveBeenCalledWith({
      projectId: 'project-1',
      change: { caseId: 'case-1', to: 'REVISION_REQUIRED', reason: '', source: 'human' },
    }));
  });

  it('surfaces the dual-submission risk when the outcome already has an active case', async () => {
    installMetis({
      createSubmissionCase: vi.fn().mockResolvedValue({ ok: false, code: 'duplicate_active', activeCaseId: 'case-1', activeJournal: 'Journal A' }),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByText('新建投稿'));
    // 弹窗默认选中第一个成果；指定期刊并提交。
    fireEvent.change(await screen.findByLabelText('输入目标期刊名称'), { target: { value: 'Journal B' } });
    fireEvent.click(screen.getByText('创建投稿事务'));
    expect(await screen.findByText(/一稿多投风险/u)).toBeTruthy();
    expect(window.metis!.createSubmissionCase).toHaveBeenCalled();
  });
});
