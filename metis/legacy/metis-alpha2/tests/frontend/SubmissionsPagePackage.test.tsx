/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import type { SubmissionCase } from '../../engine/submission/SubmissionRuntimeContract.js';

function caseFixture(overrides: Partial<SubmissionCase> = {}): SubmissionCase {
  return {
    contractVersion: 1, id: 'case-1', seriesId: 'series-1', projectId: 'project-1',
    title: '生成式AI研究论文', status: 'READY_TO_SUBMIT', articleType: 'research_article',
    targetJournalName: 'Journal A', targetJournalId: 'jp-1',
    sourceOutcomeId: 'out-1', sourceOutcomeVersion: 3,
    workingOutcomeId: null, workingOutcomeVersion: null, submittedOutcomeVersion: null,
    submissionMethod: null, submissionPortalUrl: '', remoteSubmissionId: '', notes: '',
    createdAt: 1, updatedAt: 2, submittedAt: null, decisionAt: null, acceptedAt: null, publishedAt: null,
    ...overrides,
  };
}

const PREFLIGHT = {
  run: { id: 'run-1', caseId: 'case-1', outcomeId: 'out-1', outcomeVersion: 3, passed: false, blockCount: 1, warnCount: 1, createdAt: 3 },
  checks: [
    { id: 'c1', caseId: 'case-1', runId: 'run-1', checkKey: 'word_count', label: '稿件长度', level: 'block', detail: '超出字数上限', source: 'requirement', createdAt: 3 },
    { id: 'c2', caseId: 'case-1', runId: 'run-1', checkKey: 'statement_coi', label: '利益冲突声明', level: 'warn', detail: '未检测到声明段落', source: 'deterministic', createdAt: 3 },
    { id: 'c3', caseId: 'case-1', runId: 'run-1', checkKey: 'blind_author_names', label: '作者姓名移除', level: 'pass', detail: '未发现作者姓名线索', source: 'deterministic', createdAt: 3 },
  ],
};

const PACKAGE_DRAFT = {
  package: { id: 'pkg-1', caseId: 'case-1', status: 'draft' as const, round: 1, createdAt: 1, updatedAt: 2, frozenAt: null },
  files: [
    { id: 'f1', packageId: 'pkg-1', type: 'main_manuscript', filename: '生成式AI研究论文-v3.docx', outcomeId: 'out-1', outcomeVersion: 3, artifactPath: null, contentHash: 'sha256:x', required: true, validationStatus: 'valid', note: '', createdAt: 1 },
  ],
};

const PACKAGE_FROZEN = {
  package: { id: 'pkg-1', caseId: 'case-1', status: 'frozen' as const, round: 2, createdAt: 1, updatedAt: 2, frozenAt: 3 },
  files: PACKAGE_DRAFT.files,
};

function installMetis(overrides: Record<string, unknown> = {}): void {
  window.metis = {
    listSubmissionCases: vi.fn().mockResolvedValue([caseFixture()]),
    listSubmissionEvents: vi.fn().mockResolvedValue([]),
    changeSubmissionStatus: vi.fn(),
    getSubmissionPreflight: vi.fn().mockResolvedValue(PREFLIGHT),
    getSubmissionPackage: vi.fn().mockResolvedValue(PACKAGE_DRAFT),
    assembleSubmissionPackage: vi.fn(),
    attachSubmissionPackageOutcome: vi.fn(),
    removeSubmissionPackageFile: vi.fn().mockResolvedValue(true),
    exportSubmissionPackage: vi.fn(),
    freezeSubmissionPackage: vi.fn(),
    validateSubmissionPackage: vi.fn(),
    generateSubmissionCoverLetter: vi.fn().mockResolvedValue({ ok: true, outcomeId: 'out-2', version: 3, needsConfirmation: ['作者姓名', '基金号'], extraction: 'template' }),
    ...overrides,
  } as unknown as typeof window.metis;
}

describe('SubmissionsPage 投稿检查与材料包（P2）', () => {
  beforeEach(() => {
    window.metis = undefined;
    researchWorkspaceStore.setState({ activeProjectId: 'project-1' });
  });

  it('预检清单按级别渲染，存在必须处理项时禁用进入待投稿按钮', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect(await screen.findByText('必须处理')).toBeTruthy();
    expect(screen.getByText('提醒')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('稿件长度')).toBeTruthy();
    expect(screen.getAllByText('利益冲突声明').length).toBeGreaterThan(0);
    // 有必须处理项 → 推进按钮禁用。
    const advance = (await screen.findByRole('button', { name: /检查完成，进入待投稿/u })) as HTMLButtonElement;
    expect(advance.disabled).toBe(true);
  });

  it('材料包文件清单渲染校验徽章；冻结后隐藏移除按钮并显示冻结徽章', async () => {
    installMetis({ getSubmissionPackage: vi.fn().mockResolvedValue(PACKAGE_FROZEN) });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect(await screen.findByText(/已冻结 · 第 2 轮/u)).toBeTruthy();
    expect(screen.getByText('有效')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull();
  });

  it('冻结被拒绝时显示未通过提示', async () => {
    installMetis({
      freezeSubmissionPackage: vi.fn().mockResolvedValue({ ok: false, code: 'preflight_not_passed', blockers: [] }),
    });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '定稿冻结' }));
    expect(await screen.findByText('投稿检查未全部通过，无法冻结。')).toBeTruthy();
    await waitFor(() => expect(window.metis!.freezeSubmissionPackage).toHaveBeenCalledWith({ projectId: 'project-1', packageId: 'pkg-1' }));
  });

  it('Cover Letter 生成成功后显示需研究者确认的事实清单', async () => {
    installMetis();
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '生成 Cover Letter' }));
    expect(await screen.findByText('以下事实需要研究者本人填写，系统不会代为编造：')).toBeTruthy();
    expect(screen.getByText('作者姓名')).toBeTruthy();
    expect(screen.getByText('基金号')).toBeTruthy();
    expect(screen.getByText('当前为模板草稿（未配置模型时生成）。')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '重新生成（将保存为新版本）' })).toBeTruthy();
  });

  it('无预检数据时显示引导文案且推进按钮不渲染', async () => {
    installMetis({ getSubmissionPreflight: vi.fn().mockResolvedValue(null) });
    const { default: SubmissionsPage } = await import('../../src/pages/SubmissionsPage.js');
    render(<SubmissionsPage />);
    expect(await screen.findByText('尚未运行投稿检查。运行后将逐项核对稿件与期刊要求。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /检查完成，进入待投稿/u })).toBeNull();
  });
});
