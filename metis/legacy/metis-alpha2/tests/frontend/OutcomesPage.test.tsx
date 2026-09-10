/**
 * Outcomes workbench: the project-scoped three-column surface must use the
 * durable Outcomes bridge and may only present an AI change after main has
 * committed a returned applied version.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

const word = { type: 'word' as const, blocks: [{ id: 'p-1', kind: 'paragraph' as const, text: '原始段落。' }], page: { paper: 'A4' }, header: '', footer: '' };
const outcome = { id: 'out-1', projectId: 'project-1', categoryId: null, title: '研究论文', kind: 'word' as const, status: 'draft' as const, currentVersion: 1, finalVersion: null, createdAt: 1, updatedAt: 1 };
const version = { outcomeId: 'out-1', version: 1, content: word, note: '创建成果', createdBy: 'human' as const, parentVersion: null, sources: [], createdAt: 1 };
const updatedVersion = { ...version, version: 2, content: { ...word, blocks: [{ ...word.blocks[0], text: 'AI 已修改的段落。' }] }, note: 'AI 协同修改', createdBy: 'ai' as const, parentVersion: 1, createdAt: 2 };
const ppt = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'complete' as const, elements: [] }] };
const pptOutcome = { ...outcome, id: 'out-ppt', title: '研究汇报', kind: 'ppt' as const };
const pptVersion = { ...version, outcomeId: 'out-ppt', content: ppt };
const imageDocument = { type: 'other' as const, text: '研究项目封面图片。', media: null };
const imageOutcome = { ...outcome, id: 'out-image', title: '项目封面图', kind: 'image' as const };
const imageVersion = { ...version, outcomeId: 'out-image', content: imageDocument };
const restoredOutcome = { ...outcome, currentVersion: 3, updatedAt: 4 };
const restoredVersion = { ...version, version: 3, note: '恢复到 v1', createdBy: 'restore' as const, parentVersion: 2, createdAt: 4 };

function installMetis() {
  const metis = {
    listOutcomeCategories: vi.fn().mockResolvedValue([]),
    listOutcomes: vi.fn().mockResolvedValue([outcome]),
    getOutcome: vi.fn().mockResolvedValue({ outcome, version }),
    listOutcomeVersions: vi.fn().mockResolvedValue([version]),
    listScopedConversation: vi.fn().mockResolvedValue([]),
    chatOutcomeAssistant: vi.fn().mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '已根据当前成果完成修改。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u1', role: 'user', content: '改写当前内容', sources: [], createdAt: 2 },
      assistantMessage: { id: 'message-a1', role: 'assistant', content: '已根据当前成果完成修改。', sources: [], createdAt: 3 },
      applied: { outcome: { ...outcome, currentVersion: 2, updatedAt: 3 }, version: updatedVersion, edit: { kind: 'word', replacements: [{ blockId: 'p-1', text: 'AI 已修改的段落。' }], note: 'AI 协同修改' } },
    }),
    listPptTemplates: vi.fn().mockResolvedValue([]), savePptTemplate: vi.fn(),
    listPptGenerationSkills: vi.fn().mockResolvedValue([]), savePptGenerationSkill: vi.fn(),
    executeOutcomePptGeneration: vi.fn().mockResolvedValue({ status: 'error', code: 'generation_provider_unavailable', message: '未配置生成模型。', answer: '', sources: [], diagnostics: [] }),
    createOutcomeCategory: vi.fn(), renameOutcomeCategory: vi.fn(), deleteOutcomeCategory: vi.fn(), moveOutcome: vi.fn(),
    createOutcome: vi.fn(), saveOutcome: vi.fn(), restoreOutcome: vi.fn(), renameOutcome: vi.fn(), markOutcomeFinal: vi.fn(),
    archiveOutcome: vi.fn().mockResolvedValue(true),
    listOutcomeTrash: vi.fn().mockResolvedValue([]),
    restoreOutcomeFromTrash: vi.fn().mockResolvedValue(true),
    deleteOutcomePermanent: vi.fn().mockResolvedValue(true),
    importOutcomeWordDocx: vi.fn().mockResolvedValue({ ok: false, code: 'cancelled', message: '已取消 DOCX 导入。', warnings: [] }),
    commitOutcomeWordDocxImportMedia: vi.fn().mockResolvedValue({ ok: false, code: 'invalid_request', message: '未提交 DOCX 媒体。' }),
    exportOutcomeWordDocx: vi.fn().mockResolvedValue({ ok: false, code: 'cancelled', message: '已取消 DOCX 导出。', warnings: [] }),
    importOutcomePptx: vi.fn().mockResolvedValue({ ok: false, code: 'cancelled', message: '已取消 PPTX 导入。', warnings: [] }),
    commitOutcomePptxImportMedia: vi.fn().mockResolvedValue({ ok: false, code: 'invalid_request', message: '未提交 PPTX 媒体。' }),
    exportOutcomePptx: vi.fn().mockResolvedValue({ ok: false, code: 'cancelled', message: '已取消 PPTX 导出。', warnings: [] }),
    openOutcomeInGenoffice: vi.fn().mockResolvedValue({ ok: false, code: 'genoffice_unavailable', message: 'GenOffice 构建产物不可用。' }),
    syncOutcomeFromGenoffice: vi.fn().mockResolvedValue({ ok: false, code: 'external_editor_not_changed', message: 'GenOffice 尚未保存该文件。' }),
     closeOutcomeGenofficeEditor: vi.fn().mockResolvedValue(true),
     stateOutcomeGenofficeEditor: vi.fn().mockResolvedValue({ exists: true, changed: false, session: null }),
    generateOutcomeImage: vi.fn().mockResolvedValue({ ok: false, code: 'image_generation_unconfigured' }),
    readOutcomeMedia: vi.fn().mockResolvedValue(null),
    exportOutcomeMediaSvg: vi.fn().mockResolvedValue({ ok: false, code: 'svg_write_failed', message: '未提交导出。' }),
    locateOutcomeSource: vi.fn().mockResolvedValue({ ok: false, code: 'source_not_locatable' }),
  };
  window.metis = metis as unknown as typeof window.metis;
  return metis;
}

function selectWordText(container: HTMLElement, start: number, end: number) {
  const editable = container.querySelector<HTMLElement>('[data-block="p-1"]');
  const text = editable?.firstChild;
  if (!editable || !text) throw new Error('Word 编辑块未渲染');
  const range = document.createRange();
  range.setStart(text, start); range.setEnd(text, end);
  const selection = window.getSelection();
  selection?.removeAllRanges(); selection?.addRange(range);
  fireEvent.keyUp(editable);
  return editable;
}

describe('OutcomesPage', () => {
  beforeEach(() => {
    // 任务4：OutcomesPage 现在会把“上次选中的成果”持久化到 localStorage；
    // 用例之间必须清掉，避免上一个用例的选中状态被 sticky 恢复进下一个用例。
    window.localStorage.clear();
    researchWorkspaceStore.setState({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', title: '实证研究项目' }] as never,
    });
    installMetis();
  });

  it('renders the project-owned three-column workbench and opens the formal outcome', async () => {
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    expect(await screen.findByText('研究论文')).toBeTruthy();
    expect(container.querySelector('.outcomes-tree')).toBeTruthy();
    expect(container.querySelector('.outcomes-editor')).toBeTruthy();
    expect(container.querySelector('.outcome-assistant')).toBeTruthy();
    fireEvent.click(screen.getByText('研究论文'));
    expect(await screen.findByText('AI 成果助手')).toBeTruthy();
    expect(screen.getByText('原始段落。')).toBeTruthy();
  });

  it('places Word layout before DOCX export in the outcome action row', async () => {
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await waitFor(() => expect(container.querySelector('.outcomes-editor-head__actions')).toBeTruthy());
    const actions = container.querySelector('.outcomes-editor-head__actions');
    if (!actions) throw new Error('成果操作行未渲染');
    const labels = Array.from(actions.querySelectorAll('button')).map((button) => button.textContent?.trim());
    expect(labels.indexOf('保存版本')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('排版')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('导出 DOCX')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('排版')).toBeLessThan(labels.indexOf('导出 DOCX'));
    expect(labels.indexOf('保存版本')).toBeLessThan(labels.indexOf('排版'));
  });

  it('opens a saved Word outcome in Metis Office and exposes explicit sync and discard controls', async () => {
    const metis = installMetis();
    metis.openOutcomeInGenoffice.mockResolvedValue({ ok: true, session: { token: 'oe-word-1', kind: 'word', fileName: '研究论文.docx' } });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findAllByRole('button', { name: '保存版本' });
    fireEvent.click(await screen.findByRole('button', { name: 'Metis Office' }));
    await waitFor(() => expect(metis.openOutcomeInGenoffice).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', version: 1 }));
    expect(await screen.findByRole('button', { name: '同步回 METIS' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '放弃会话' }));
    await waitFor(() => expect(metis.closeOutcomeGenofficeEditor).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', token: 'oe-word-1' }));
    expect(await screen.findByRole('button', { name: 'Metis Office' })).toBeTruthy();
  });

  it('blocks switching away from a dirty Metis Office session instead of discarding it', async () => {
    const metis = installMetis();
    const secondOutcome = { ...outcome, id: 'out-2', title: '第二个成果' };
    const secondVersion = { ...version, outcomeId: secondOutcome.id };
    metis.listOutcomes.mockResolvedValue([outcome, secondOutcome]);
    metis.getOutcome.mockImplementation(async (request: { outcomeId: string }) => request.outcomeId === secondOutcome.id
      ? { outcome: secondOutcome, version: secondVersion }
      : { outcome, version });
    metis.openOutcomeInGenoffice.mockResolvedValue({ ok: true, session: { token: 'oe-dirty', kind: 'word', fileName: '研究论文.docx' } });
    metis.stateOutcomeGenofficeEditor.mockResolvedValue({ exists: true, changed: true, session: { token: 'oe-dirty', kind: 'word', fileName: '研究论文.docx' } });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    fireEvent.click(await screen.findByRole('button', { name: 'Metis Office' }));
    await screen.findByRole('button', { name: '同步回 METIS' });
    fireEvent.click(screen.getByText('第二个成果'));
    await waitFor(() => expect(metis.stateOutcomeGenofficeEditor).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1' }));
    expect(metis.closeOutcomeGenofficeEditor).not.toHaveBeenCalled();
    expect(await screen.findByText(/外部文件有未同步修改/u)).toBeTruthy();
  });

  it('keeps the external session token when sync saved the version but cleanup failed', async () => {
    const metis = installMetis();
    metis.openOutcomeInGenoffice.mockResolvedValue({ ok: true, session: { token: 'oe-warning', kind: 'word', fileName: '研究论文.docx' } });
    metis.syncOutcomeFromGenoffice.mockResolvedValue({ ok: true, warning: '版本已保存，但 GenOffice 会话未能清理。', detail: { outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: { ...updatedVersion, version: 2, outcomeId: outcome.id } } });
    metis.listOutcomeVersions.mockResolvedValue([updatedVersion, version]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    fireEvent.click(await screen.findByRole('button', { name: 'Metis Office' }));
    await screen.findByRole('button', { name: '同步回 METIS' });
    fireEvent.click(screen.getByRole('button', { name: '同步回 METIS' }));
    expect(await screen.findByRole('button', { name: '放弃会话' })).toBeTruthy();
  });

  it('exposes the Metis Office editor entry for PDF and spreadsheet outcomes without treating them as text documents', async () => {
    const metis = installMetis();
    const spreadsheetOutcome = { ...outcome, id: 'out-sheet', title: '实验数据', kind: 'spreadsheet' as const };
    const spreadsheetVersion = { ...version, outcomeId: spreadsheetOutcome.id, content: { type: 'spreadsheet' as const, media: { id: 'sheet-media', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const, displayName: '实验数据.xlsx', byteLength: 1024 }, workbook: { sheetNames: ['Sheet1'], activeSheet: 'Sheet1', activeCell: 'A1' } } };
    metis.listOutcomes.mockResolvedValue([spreadsheetOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: spreadsheetOutcome, version: spreadsheetVersion });
    metis.listOutcomeVersions.mockResolvedValue([spreadsheetVersion]);
    metis.openOutcomeInGenoffice.mockResolvedValue({ ok: false, code: 'outcome_kind_mismatch', message: '当前成果没有可交给 GenOffice 的真实文件媒体。' });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('实验数据'));
    await screen.findAllByRole('button', { name: '保存版本' });
    expect(screen.getByRole('button', { name: 'Metis Office' })).toBeTruthy();
    expect(screen.queryByText('PDF / 图片成果')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Metis Office' }));
    expect(await screen.findByText('当前成果没有可交给 GenOffice 的真实文件媒体。')).toBeTruthy();
  });

  it('uses the durable assistant bridge and refreshes only main-committed AI versions', async () => {
    const metis = window.metis as unknown as { chatOutcomeAssistant: ReturnType<typeof vi.fn> };
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    const composer = await screen.findByPlaceholderText('例如：根据项目中的实验结果重写当前段落');
    fireEvent.change(composer, { target: { value: '改写当前内容' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '改写当前内容' }));
    expect(await screen.findByText('AI 已修改的段落。')).toBeTruthy();
    expect(screen.getByText(/AI 已将经过校验的修改保存为新版本/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看成果协作历史' }));
    expect(await screen.findByText('研究论文 · 协作历史')).toBeTruthy();
    expect(screen.getAllByText('已根据当前成果完成修改。').length).toBeGreaterThanOrEqual(2);
  });

  it('sends the active Word block only and never fabricates an AI version for an answer-only turn', async () => {
    const metis = installMetis();
    metis.chatOutcomeAssistant.mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '仅提供审阅建议。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u2', role: 'user', content: '审阅当前段落', sources: [], createdAt: 4 },
      assistantMessage: { id: 'message-a2', role: 'assistant', content: '仅提供审阅建议。', sources: [], createdAt: 5 },
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    fireEvent.click(await screen.findByText('原始段落。'));
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '审阅当前段落' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '审阅当前段落', selection: { type: 'word_block', blockId: 'p-1' } }));
    expect(await screen.findByText('仅提供审阅建议。')).toBeTruthy();
    expect(screen.getByText(/没有生成可安全应用的结构化修改/u)).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    expect(screen.getByText('原始段落。')).toBeTruthy();
  });

  it('shows the current project, outcome, version, selection, and only the persisted source records after assistant history refresh', async () => {
    const metis = installMetis();
    const outcomeVersionSource = { kind: 'outcome_version' as const, id: 'out-1', version: 1, label: '研究论文 v1' };
    const selectionSource = { kind: 'selection' as const, id: 'p-1', label: 'Word 段落 p-1' };
    const projectContextSource = { kind: 'project_metis' as const, id: 'project-1', label: '项目研究约束' };
    const userMessage = { id: 'source-user-1', role: 'user' as const, content: '结合当前资料审阅段落', sources: [outcomeVersionSource, selectionSource], createdAt: 2 };
    const assistantMessage = { id: 'source-assistant-1', role: 'assistant' as const, content: '已基于实际来源给出审阅。', sources: [outcomeVersionSource, selectionSource, projectContextSource], createdAt: 3 };
    metis.listScopedConversation.mockResolvedValueOnce([]).mockResolvedValueOnce([userMessage, assistantMessage]);
    metis.chatOutcomeAssistant.mockResolvedValue({ status: 'completed', model: 'test-model', answer: assistantMessage.content, sources: assistantMessage.sources, diagnostics: [], userMessage, assistantMessage });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await waitFor(() => expect(metis.listScopedConversation).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText('原始段落。'));
    expect(await screen.findByText('项目：实证研究项目')).toBeTruthy();
    expect(screen.getByText('成果：研究论文')).toBeTruthy();
    expect(screen.getByText('版本：v1')).toBeTruthy();
    expect(screen.getByText('Word 段落 p-1')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: userMessage.content } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('项目研究约束')).toBeTruthy();
    expect(screen.getAllByText('类型：成果版本（outcome_version） · v1').length).toBeGreaterThan(0);
    expect(screen.getByText('类型：项目 METIS（project_metis）')).toBeTruthy();
    await waitFor(() => expect(metis.listScopedConversation).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/已检索/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看成果协作历史' }));
    expect(await screen.findByText('研究论文 · 协作历史')).toBeTruthy();
    expect(screen.getAllByText('项目研究约束').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('类型：项目 METIS（project_metis）').length).toBeGreaterThanOrEqual(2);
  });

  it('opens a persisted outcome-version source and locates artifact sources through durable bridges while keeping non-locatable kinds non-clickable', async () => {
    const metis = installMetis();
    const referencedOutcome = { ...outcome, id: 'out-peer', title: '项目实验结果', currentVersion: 2 };
    const referencedVersion = { ...version, outcomeId: 'out-peer', version: 2, content: { ...word, blocks: [{ ...word.blocks[0], text: '实验结论。' }] }, note: '更新实验结论', parentVersion: 1, createdAt: 2 };
    const messages = [{ id: 'source-open-1', role: 'assistant' as const, content: '请查看项目实验结果。', sources: [
      { kind: 'outcome_version' as const, id: 'out-peer', version: 2, label: '项目实验结果 v2' },
      { kind: 'artifact' as const, id: 'artifact-1', version: 1, label: '原始实验产物' },
    ], createdAt: 2 }];
    metis.listScopedConversation.mockResolvedValue(messages);
    metis.getOutcome.mockImplementation(async ({ outcomeId, version: requestedVersion }: { outcomeId: string; version?: number }) => {
      if (outcomeId === 'out-peer' && requestedVersion === 2) return { outcome: referencedOutcome, version: referencedVersion };
      return { outcome, version };
    });
    metis.listOutcomeVersions.mockImplementation(async ({ outcomeId }: { outcomeId: string }) => outcomeId === 'out-peer' ? [referencedVersion] : [version]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    const sourceButton = await screen.findByRole('button', { name: '打开来源成果 项目实验结果 v2' });
    // OUT-11: artifact sources are now locatable through the real resolver.
    expect(await screen.findByRole('button', { name: '定位来源 原始实验产物' })).toBeTruthy();
    fireEvent.click(sourceButton);
    await waitFor(() => expect(metis.getOutcome).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-peer', version: 2 }));
    expect(await screen.findByText('实验结论。')).toBeTruthy();
    expect(screen.getByText('成果：项目实验结果')).toBeTruthy();
  });

  it('states when a persisted assistant record has no extra sources in both the sidebar and history', async () => {
    const metis = installMetis();
    const noSourceMessages = [
      { id: 'no-source-user', role: 'user' as const, content: '请审阅。', sources: [], createdAt: 2 },
      { id: 'no-source-assistant', role: 'assistant' as const, content: '没有额外资料可用。', sources: [], createdAt: 3 },
    ];
    metis.listScopedConversation.mockResolvedValue(noSourceMessages);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    expect((await screen.findAllByText('无额外资料')).length).toBe(2);
    expect(screen.queryByText(/已检索/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看成果协作历史' }));
    expect((await screen.findAllByText('无额外资料')).length).toBe(4);
  });

  it('persists a PPT Grid edit only after save and scopes the assistant to its selected element', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    const savedPpt = { ...ppt, pages: [{ ...ppt.pages[0], humanModified: true, elements: [{ id: 'text-saved', type: 'text' as const, x: 3, y: 3, width: 10, height: 3, locked: false, props: { text: '文本' } }] }] };
    metis.saveOutcome.mockResolvedValue({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: savedPpt, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } });
    metis.chatOutcomeAssistant.mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '已分析该页。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u3', role: 'user', content: '审阅当前页', sources: [], createdAt: 4 },
      assistantMessage: { id: 'message-a3', role: 'assistant', content: '已分析该页。', sources: [], createdAt: 5 },
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    expect(await screen.findByText('16:9 · 32 × 18 Grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    expect(await screen.findByText('已选中')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', outcomeId: 'out-ppt', baseVersion: 1, content: expect.objectContaining({ type: 'ppt' }), note: '保存 PPT Grid 布局', actor: 'human' })));
    const savedElement = container.querySelector<HTMLElement>('.ppt-element');
    if (!savedElement) throw new Error('保存后的 PPT 元素未渲染');
    fireEvent.click(savedElement);
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '审阅当前页' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-ppt', instruction: '审阅当前页', selection: { type: 'ppt_element', pageId: 'slide-1', elementId: 'text-saved' } }));
  });

  it('edits a PPT text object directly on the canvas and keeps the edit local until save', async () => {
    const metis = installMetis();
    const textElement = { id: 'text-direct', type: 'text' as const, x: 3, y: 3, width: 10, height: 3, locked: false, props: { text: '原始文本' } };
    const initialPpt = { ...ppt, pages: [{ ...ppt.pages[0], elements: [textElement] }] };
    const initialVersion = { ...pptVersion, content: initialPpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: initialVersion });
    metis.listOutcomeVersions.mockResolvedValue([initialVersion]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof initialPpt }) => ({
      outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 },
      version: { ...initialVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 },
    }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    const element = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.ppt-element');
      if (!node) throw new Error('PPT 文本对象未渲染');
      return node;
    });
    expect(element.getAttribute('contenteditable')).toBe('true');
    element.textContent = '已直接编辑文本';
    fireEvent.input(element);
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    expect(element.textContent).toBe('已直接编辑文本');
    const saveButtons = screen.getAllByRole('button', { name: '保存版本' });
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ pages: [expect.objectContaining({ elements: [expect.objectContaining({ props: expect.objectContaining({ text: '已直接编辑文本' }) })] })] }),
    })));
  });

  it('keeps the assistant selection in sync when a PPT element is created from the Ribbon', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    metis.chatOutcomeAssistant.mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '已分析该对象。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u-ribbon', role: 'user', content: '审阅新增对象', sources: [], createdAt: 4 },
      assistantMessage: { id: 'message-a-ribbon', role: 'assistant', content: '已分析该对象。', sources: [], createdAt: 5 },
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('.ppt-element.selected')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '审阅新增对象' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', outcomeId: 'out-ppt', instruction: '审阅新增对象', selection: { type: 'ppt_element', pageId: 'slide-1', elementId: expect.any(String) },
    })));
  });

  it('creates the first PPT element from the Ribbon when the saved deck has no pages', async () => {
    const metis = installMetis();
    const emptyPpt = { ...ppt, pages: [] };
    const emptyVersion = { ...pptVersion, content: emptyPpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: emptyVersion });
    metis.listOutcomeVersions.mockResolvedValue([emptyVersion]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    expect(container.querySelectorAll('.ppt-element')).toHaveLength(1);
  });

  it('does not persist an untouched empty-deck fallback page when a new slide is added', async () => {
    const metis = installMetis();
    const emptyPpt = { ...ppt, pages: [] };
    const emptyVersion = { ...pptVersion, content: emptyPpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: emptyVersion });
    metis.listOutcomeVersions.mockResolvedValue([emptyVersion]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '新建幻灯片' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ pages: [expect.objectContaining({ id: 'slide-2' })] }),
    })));
  });

  it('filters the empty-deck fallback when saving from the page header', async () => {
    const metis = installMetis();
    const emptyPpt = { ...ppt, pages: [] };
    const emptyVersion = { ...pptVersion, content: emptyPpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: emptyVersion });
    metis.listOutcomeVersions.mockResolvedValue([emptyVersion]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '新建幻灯片' }));
    fireEvent.click(screen.getAllByRole('button', { name: '保存版本' })[0]!);
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ pages: [expect.objectContaining({ id: 'slide-2' })] }),
    })));
  });

  it('keeps the latest PPT assistant selection when a save resolves after the user changes selection', async () => {
    const metis = installMetis();
    const originalElement = { id: 'text-original', type: 'text' as const, x: 3, y: 3, width: 10, height: 3, locked: false, props: { text: '原始对象' } };
    const initialPpt = { ...ppt, pages: [{ ...ppt.pages[0], elements: [originalElement] }] };
    const initialVersion = { ...pptVersion, content: initialPpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: initialVersion });
    metis.listOutcomeVersions.mockResolvedValue([initialVersion]);
    metis.chatOutcomeAssistant.mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '已分析最新选区。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u-race', role: 'user', content: '检查最新选区', sources: [], createdAt: 4 },
      assistantMessage: { id: 'message-a-race', role: 'assistant', content: '已分析最新选区。', sources: [], createdAt: 5 },
    });
    let resolveSave: ((value: unknown) => void) | undefined;
    const pendingSave = new Promise<unknown>((resolve) => { resolveSave = resolve; });
    metis.saveOutcome.mockImplementation((request: unknown) => {
      const savedRequest = request as { content: typeof initialPpt };
      return pendingSave.then(() => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...initialVersion, version: 2, content: savedRequest.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    const elements = container.querySelectorAll<HTMLElement>('.ppt-element');
    expect(elements).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    fireEvent.click(elements[0]!);
    resolveSave?.(undefined);
    await screen.findByText('v2 · 草稿');
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '检查最新选区' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', outcomeId: 'out-ppt', instruction: '检查最新选区', selection: { type: 'ppt_element', pageId: 'slide-1', elementId: 'text-original' },
    })));
  });

  it('clears a Word text-range assistant selection when the saved content no longer contains that range', async () => {
    const metis = installMetis();
    const shortenedWord = { ...word, blocks: [{ ...word.blocks[0], text: '新' }] };
    const shortenedVersion = { ...version, version: 2, content: shortenedWord, note: '保存后文本变化', parentVersion: 1, createdAt: 2 };
    metis.saveOutcome.mockResolvedValue({ outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: shortenedVersion });
    metis.chatOutcomeAssistant.mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '已检查。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u-word-range', role: 'user', content: '检查', sources: [], createdAt: 4 },
      assistantMessage: { id: 'message-a-word-range', role: 'assistant', content: '已检查。', sources: [], createdAt: 5 },
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    selectWordText(container, 0, 2);
    fireEvent.click(screen.getByTitle('加粗'));
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '检查' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '检查' }));
  });

  it('persists all supported PPT element types and the selected 4:3 Grid in one real outcome save request', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '4:3' }));
    expect(await screen.findByText('4:3 · 24 × 18 Grid')).toBeTruthy();
    const picker = screen.getByLabelText('添加 PPT 元素');
    for (const type of ['text', 'rect', 'roundRect', 'ellipse', 'triangle', 'line', 'arrow', 'table', 'chart', 'image']) fireEvent.change(picker, { target: { value: type } });
    await waitFor(() => expect(container.querySelectorAll('.ppt-element')).toHaveLength(10));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const request = metis.saveOutcome.mock.calls[0][0] as { content: { ratio: string; pages: Array<{ elements: Array<{ type: string }> }> } };
    expect(request.content.ratio).toBe('4:3');
    expect(request.content.pages[0].elements.map((element) => element.type)).toEqual(['text', 'rect', 'roundRect', 'ellipse', 'triangle', 'line', 'arrow', 'table', 'chart', 'image']);
  });

  it('writes drag, resize, copy, layer, lock and delete actions back to the one PPT document', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    const stage = container.querySelector<HTMLElement>('.ppt-stage');
    const element = container.querySelector<HTMLElement>('.ppt-element');
    if (!stage || !element) throw new Error('PPT 舞台或元素未渲染');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 320, height: 180, top: 0, right: 320, bottom: 180, left: 0, toJSON: () => ({}) } as DOMRect);
    fireEvent.pointerDown(element, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 80, clientY: 50 });
    fireEvent.pointerUp(element, { pointerId: 1, clientX: 80, clientY: 50 });
    const resizeHandle = container.querySelector<HTMLElement>('.ppt-element__resize');
    if (!resizeHandle) throw new Error('PPT 缩放手柄未渲染');
    fireEvent.pointerDown(resizeHandle, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(element, { pointerId: 2, clientX: 50, clientY: 20 });
    fireEvent.pointerUp(element, { pointerId: 2, clientX: 50, clientY: 20 });
    const duplicate = container.querySelector<HTMLElement>('.ppt-properties__actions button');
    if (!duplicate) throw new Error('PPT 复制按钮未渲染');
    fireEvent.click(duplicate);
    await waitFor(() => expect(container.querySelectorAll('.ppt-element')).toHaveLength(2));
    expect(container.querySelectorAll('.ppt-element')[1].className).toContain('selected');
    expect(await screen.findByRole('button', { name: '置于顶层' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    fireEvent.click(screen.getByRole('button', { name: '置于底层' }));
    fireEvent.click(screen.getByRole('button', { name: '锁定' }));
    expect(screen.getByRole('button', { name: '向右移动 1 Grid' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '解除锁定' }));
    await screen.findByRole('button', { name: '锁定' });
    const original = container.querySelectorAll<HTMLElement>('.ppt-element')[0];
    fireEvent.click(original);
    expect(original.className).toContain('selected');
    fireEvent.click(screen.getByRole('button', { name: '删除元素' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const request = metis.saveOutcome.mock.calls[0][0] as { content: { pages: Array<{ elements: Array<{ x: number; y: number; width: number; height: number }> }> } };
    expect(request.content.pages[0].elements).toHaveLength(1);
    expect(request.content.pages[0].elements[0]).toMatchObject({ x: 9, y: 6, width: 15, height: 5 });
  });

  it('runs the real PPT generation bridge only after saving the selected template and skill, then opens its committed version', async () => {
    const metis = installMetis();
    const template = { id: 'template-1', name: '学院答辩模板', definition: { theme: { primary: '#124d72' } }, createdAt: 1, updatedAt: 1 };
    const savedTemplate = { ...template, id: 'template-2', name: '我的模板' };
    const skill = { id: 'skill-1', name: '证据型答辩', narrative: 'argument_evidence', contentDensity: 'balanced', audience: '评审专家', instructions: '先呈现问题和证据。' };
    const generatedPpt = { ...ppt, templateId: 'template-2', generationSkillId: 'skill-1', pages: [{ ...ppt.pages[0], title: 'AI 生成封面', humanModified: false, elements: [{ id: 'generated-title', type: 'text' as const, x: 3, y: 3, width: 18, height: 3, locked: false, props: { text: '证据型研究汇报' } }] }] };
    const generatedVersion = { ...pptVersion, version: 3, content: generatedPpt, note: '生成答辩结构', createdBy: 'ai' as const, parentVersion: 2, createdAt: 3 };
    const generatedOutcome = { ...pptOutcome, currentVersion: 3, updatedAt: 3 };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.listPptTemplates.mockResolvedValue([template]);
    metis.listPptGenerationSkills.mockResolvedValue([skill]);
    metis.savePptTemplate.mockResolvedValue(savedTemplate);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    metis.executeOutcomePptGeneration.mockResolvedValue({ status: 'completed', model: 'test-model', answer: '已生成答辩结构。', sources: [], diagnostics: [], userMessage: { id: 'ppt-user-1', role: 'user', content: '生成答辩结构', sources: [], createdAt: 2 }, assistantMessage: { id: 'ppt-assistant-1', role: 'assistant', content: '已生成答辩结构。', sources: [], createdAt: 3 }, applied: { outcome: generatedOutcome, version: generatedVersion, patch: { replacePages: [{ pageId: 'slide-1', title: 'AI 生成封面', elements: generatedPpt.pages[0].elements }], appendPages: [], note: '生成答辩结构' }, skill, template: savedTemplate } });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByRole('option', { name: '学院答辩模板' });
    fireEvent.change(screen.getByLabelText('选择 PPT 模板'), { target: { value: 'template-1' } });
    fireEvent.change(screen.getByLabelText('选择 PPT 生成技能'), { target: { value: 'skill-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存为模板' }));
    fireEvent.change(await screen.findByLabelText('模板名称'), { target: { value: '我的模板' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
    await waitFor(() => expect(metis.savePptTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: '我的模板' })));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const request = metis.saveOutcome.mock.calls[0][0] as { content: { templateId: string | null; generationSkillId: string | null } };
    expect(request.content).toMatchObject({ templateId: 'template-2', generationSkillId: 'skill-1' });
    fireEvent.change(screen.getByLabelText('PPT 生成指令'), { target: { value: '生成答辩结构' } });
    fireEvent.click(screen.getByRole('button', { name: '运行生成' }));
    await waitFor(() => expect(metis.executeOutcomePptGeneration).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-ppt', baseVersion: 2, generationSkillId: 'skill-1', templateId: 'template-2', instruction: '生成答辩结构' }));
    expect(await screen.findByText('AI 生成封面')).toBeTruthy();
    expect(screen.getByText(/已生成并保存为新版本/u)).toBeTruthy();
  });

  it('keeps template selection as an association until an explicit apply, then writes its ratio, theme, and pages only on save', async () => {
    const metis = installMetis();
    const templateDocument = { type: 'ppt' as const, ratio: '4:3' as const, theme: { primary: '#124d72', accent: '#d47c26', surface: '#f7f4ee', text: '#17243a' }, templateId: null, generationSkillId: null, pages: [{ id: 'template-cover', title: '模板封面', pageType: 'cover', humanModified: false, status: 'complete' as const, elements: [{ id: 'template-title', type: 'text' as const, x: 2, y: 2, width: 16, height: 3, locked: false, props: { text: '模板标题' } }] }] };
    const template = { id: 'template-apply', name: '正式答辩模板', definition: { ratio: templateDocument.ratio, theme: templateDocument.theme, pages: templateDocument.pages }, createdAt: 1, updatedAt: 1 };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.listPptTemplates.mockResolvedValue([template]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByRole('option', { name: '正式答辩模板' });
    const stageBeforeAssociation = container.querySelector<HTMLElement>('.ppt-stage');
    if (!stageBeforeAssociation) throw new Error('PPT 画布未渲染');
    fireEvent.change(screen.getByLabelText('选择 PPT 模板'), { target: { value: 'template-apply' } });
    expect(screen.getByText('封面')).toBeTruthy();
    expect(screen.getByText('16:9 · 32 × 18 Grid')).toBeTruthy();
    expect(stageBeforeAssociation.style.getPropertyValue('--ppt-primary')).toBe('#236c91');
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用模板内容' }));
    expect(await screen.findByText(/请先保存为新版本，再应用模板内容/u)).toBeTruthy();
    expect(screen.queryByText('模板封面')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const associationRequest = metis.saveOutcome.mock.calls[0][0] as { content: { templateId: string; ratio: string; pages: Array<{ title: string }> } };
    expect(associationRequest.content).toMatchObject({ templateId: 'template-apply', ratio: '16:9', pages: [{ title: '封面' }] });
    await screen.findByRole('option', { name: '正式答辩模板' });
    fireEvent.click(screen.getByRole('button', { name: '应用模板内容' }));
    expect(await screen.findByText('模板封面')).toBeTruthy();
    expect(screen.getByText('4:3 · 24 × 18 Grid')).toBeTruthy();
    const stageAfterApply = container.querySelector<HTMLElement>('.ppt-stage');
    if (!stageAfterApply) throw new Error('应用后的 PPT 画布未渲染');
    expect(stageAfterApply.style.getPropertyValue('--ppt-primary')).toBe('#124d72');
    expect(metis.saveOutcome).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(2));
    const appliedRequest = metis.saveOutcome.mock.calls[1][0] as { content: { templateId: string; ratio: string; theme: Record<string, unknown>; pages: Array<{ title: string; elements: Array<{ id: string }> }> } };
    expect(appliedRequest.content).toMatchObject({ templateId: 'template-apply', ratio: '4:3', theme: templateDocument.theme, pages: [{ title: '模板封面', elements: [{ id: 'template-title' }] }] });
  });

  it('shows a deterministic notice for missing or malformed applied template content without changing the presentation', async () => {
    const metis = installMetis();
    const malformedTemplate = { id: 'template-bad', name: '损坏布局模板', definition: { ratio: '16:9', pages: [{ id: 'bad-page', title: '缺少元素' }] }, createdAt: 1, updatedAt: 1 };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.listPptTemplates.mockResolvedValue([malformedTemplate]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByRole('option', { name: '损坏布局模板' });
    fireEvent.change(screen.getByLabelText('选择 PPT 模板'), { target: { value: 'template-bad' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    await screen.findByRole('option', { name: '损坏布局模板' });
    fireEvent.click(screen.getByRole('button', { name: '应用模板内容' }));
    expect(await screen.findByText(/模板「损坏布局模板」的比例、主题或页面布局数据无效，当前成果没有被修改/u)).toBeTruthy();
    expect(screen.getByText('封面')).toBeTruthy();
    expect(metis.saveOutcome).toHaveBeenCalledTimes(1);
  });

  it('creates a generation skill from an empty real list, selects it, and enables execution after the association is saved', async () => {
    const metis = installMetis();
    const skill = { id: 'skill-new', name: '评审答辩', narrative: 'comparison' as const, contentDensity: 'dense' as const, audience: '基金评审', instructions: '先做比较，再给出结论。' };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.listPptGenerationSkills.mockResolvedValue([]);
    metis.savePptGenerationSkill.mockResolvedValue(skill);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByLabelText('选择 PPT 生成技能');
    expect(screen.queryByRole('option', { name: '评审答辩' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建技能' }));
    fireEvent.change(screen.getByLabelText('生成技能名称'), { target: { value: '评审答辩' } });
    fireEvent.change(screen.getByLabelText('生成技能叙事'), { target: { value: 'comparison' } });
    fireEvent.change(screen.getByLabelText('生成技能信息密度'), { target: { value: 'dense' } });
    fireEvent.change(screen.getByLabelText('生成技能受众'), { target: { value: '基金评审' } });
    fireEvent.change(screen.getByLabelText('生成技能说明'), { target: { value: '先做比较，再给出结论。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }));
    await waitFor(() => {
      expect(metis.savePptGenerationSkill).toHaveBeenCalledWith(expect.objectContaining({ name: '评审答辩', narrative: 'comparison', contentDensity: 'dense', audience: '基金评审', instructions: '先做比较，再给出结论。' }));
      expect((screen.getByLabelText('选择 PPT 生成技能') as HTMLSelectElement).value).toBe('skill-new');
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('PPT 生成指令'), { target: { value: '生成比较页' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '运行生成' })).toHaveProperty('disabled', false));
  });

  it('shows visible failure feedback when template or generation-skill IPC rejects', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.savePptTemplate.mockRejectedValueOnce(new Error('ipc rejected'));
    metis.savePptGenerationSkill.mockRejectedValueOnce(new Error('ipc rejected'));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByRole('button', { name: '保存为模板' });
    fireEvent.click(screen.getByRole('button', { name: '保存为模板' }));
    fireEvent.change(await screen.findByLabelText('模板名称'), { target: { value: '失败模板' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
    expect(await screen.findByText('模板保存请求未完成，当前成果内容没有被改变。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新建技能' }));
    fireEvent.change(screen.getByLabelText('生成技能名称'), { target: { value: '失败技能' } });
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }));
    expect(await screen.findByText('生成技能保存请求未完成，当前成果内容没有被改变。')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '新建 PPT 生成技能' })).toBeTruthy();
  });

  it('disables PPT generation while a selected skill is still an unsaved local draft', async () => {
    const metis = installMetis();
    const skill = { id: 'skill-1', name: '证据型答辩', narrative: 'argument_evidence', contentDensity: 'balanced', audience: '', instructions: '' };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.listPptGenerationSkills.mockResolvedValue([skill]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByRole('option', { name: '证据型答辩' });
    fireEvent.change(screen.getByLabelText('选择 PPT 生成技能'), { target: { value: 'skill-1' } });
    fireEvent.change(screen.getByLabelText('PPT 生成指令'), { target: { value: '生成新页面' } });
    expect(screen.getByRole('button', { name: '运行生成' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/当前有未保存编辑；保存为新版本后才能运行/u)).toBeTruthy();
    expect(metis.executeOutcomePptGeneration).not.toHaveBeenCalled();
  });

  it('shows real generation error and cancellation feedback without changing the open PPT version', async () => {
    const metis = installMetis();
    const skill = { id: 'skill-1', name: '证据型答辩', narrative: 'argument_evidence', contentDensity: 'balanced', audience: '', instructions: '' };
    const readyPpt = { ...ppt, generationSkillId: 'skill-1' };
    const readyVersion = { ...pptVersion, content: readyPpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: readyVersion });
    metis.listOutcomeVersions.mockResolvedValue([readyVersion]);
    metis.listPptGenerationSkills.mockResolvedValue([skill]);
    metis.executeOutcomePptGeneration.mockResolvedValueOnce({ status: 'error', code: 'generation_provider_unavailable', message: '请先配置生成模型。', answer: '', sources: [], diagnostics: [] }).mockResolvedValueOnce({ status: 'cancelled', code: 'agent_cancelled', message: '用户取消了生成。', answer: '', sources: [], diagnostics: [] });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByLabelText('PPT 生成指令');
    fireEvent.change(screen.getByLabelText('PPT 生成指令'), { target: { value: '生成研究概览' } });
    fireEvent.click(screen.getByRole('button', { name: '运行生成' }));
    expect(await screen.findByText('请先配置生成模型。')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '运行生成' }));
    expect(await screen.findByText('用户取消了生成。')).toBeTruthy();
    expect(screen.getByText('封面')).toBeTruthy();
  });

  it('keeps PPT theme and element property edits local until save, then persists the exact document props', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof ppt }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    fireEvent.click(await screen.findByRole('button', { name: '文本' }));
    fireEvent.change(screen.getByLabelText('填充色'), { target: { value: '#124d72' } });
    fireEvent.change(screen.getByLabelText('边框颜色'), { target: { value: '#8a4b18' } });
    fireEvent.change(screen.getByLabelText('边框宽度'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('文字颜色'), { target: { value: '#ffffff' } });
    fireEvent.change(screen.getByLabelText('PPT 字号'), { target: { value: '26' } });
    fireEvent.change(screen.getByLabelText('PPT 字体'), { target: { value: 'Noto Sans SC' } });
    fireEvent.change(screen.getByLabelText('主题主色'), { target: { value: '#0b3652' } });
    fireEvent.change(screen.getByLabelText('主题强调'), { target: { value: '#d47c26' } });
    expect(screen.getByText(/渐变、多选分组和复杂矢量编辑暂不支持；图片媒体仅接受当前 codec 可验证的 PNG\/JPEG 与安全 SVG/u)).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const request = metis.saveOutcome.mock.calls[0][0] as { content: { theme: Record<string, string>; pages: Array<{ elements: Array<{ props: Record<string, unknown> }> }> } };
    expect(request.content.theme).toMatchObject({ primary: '#0b3652', accent: '#d47c26' });
    expect(request.content.pages[0].elements[0]?.props).toMatchObject({ fillColor: '#124d72', borderColor: '#8a4b18', borderWidth: 3, textColor: '#ffffff', fontSize: 26, fontFamily: 'Noto Sans SC' });
  });

  it('uses the restored immutable version returned by the bridge without relying on a stale re-read', async () => {
    const metis = installMetis();
    metis.getOutcome.mockResolvedValue({ outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: updatedVersion });
    metis.listOutcomes.mockResolvedValue([{ ...outcome, currentVersion: 2, updatedAt: 2 }]);
    metis.listOutcomeVersions.mockResolvedValue([updatedVersion, version]);
    metis.restoreOutcome.mockResolvedValue({ outcome: restoredOutcome, version: restoredVersion });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    expect(await screen.findByText('AI 已修改的段落。')).toBeTruthy();
    fireEvent.click(screen.getByTitle('恢复 v1'));
    await waitFor(() => expect(metis.restoreOutcome).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', version: 1, note: '恢复到 v1' }));
    expect(await screen.findByText('原始段落。')).toBeTruthy();
    expect(screen.getByText('v3 · 草稿')).toBeTruthy();
  });

  it('blocks an assistant request while the current Word draft is not saved, preserving the local edit', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    const editable = container.querySelector<HTMLElement>('[data-block="p-1"]');
    if (!editable) throw new Error('Word 编辑块未渲染');
    editable.textContent = '尚未保存的人工草稿。';
    fireEvent.input(editable);
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '请直接改写' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(/当前成果有未保存的编辑/u)).toBeTruthy();
    expect(metis.chatOutcomeAssistant).not.toHaveBeenCalled();
    expect(screen.getByText('尚未保存的人工草稿。')).toBeTruthy();
  });

  it('does not open DOCX import or export while a Word draft is unsaved', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    const editable = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-block="p-1"]');
      if (!node) throw new Error('Word 编辑块未渲染');
      return node;
    });
    editable.textContent = '需要保留的 DOCX 草稿。';
    fireEvent.input(editable);
    fireEvent.click(screen.getByRole('button', { name: '导入 Word DOCX' }));
    expect(await screen.findByText(/请先保存版本，再导入 DOCX/u)).toBeTruthy();
    expect(metis.importOutcomeWordDocx).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '导出 DOCX' }));
    expect(await screen.findByText(/请先保存版本，再导出 DOCX/u)).toBeTruthy();
    expect(metis.exportOutcomeWordDocx).not.toHaveBeenCalled();
    expect(screen.getByText('需要保留的 DOCX 草稿。')).toBeTruthy();
  });

  it('normalizes a numbered or bullet Word caret to block.text coordinates before sending AI context', async () => {
    const metis = installMetis();
    const listedWord = { ...word, blocks: [{ ...word.blocks[0], style: { list: 'bullet' } }] };
    const listedVersion = { ...version, version: 2, content: listedWord, note: '保存列表', parentVersion: 1, createdAt: 2 };
    const listedOutcome = { ...outcome, currentVersion: 2, updatedAt: 2 };
    metis.saveOutcome.mockResolvedValue({ outcome: listedOutcome, version: listedVersion });
    metis.listOutcomes.mockResolvedValue([listedOutcome]);
    metis.listOutcomeVersions.mockResolvedValue([listedVersion, version]);
    metis.chatOutcomeAssistant.mockResolvedValue({
      status: 'completed', model: 'test-model', answer: '已检查列表项。', sources: [], diagnostics: [],
      userMessage: { id: 'message-u4', role: 'user', content: '检查列表项', sources: [], createdAt: 3 },
      assistantMessage: { id: 'message-a4', role: 'assistant', content: '已检查列表项。', sources: [], createdAt: 4 },
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    fireEvent.click(screen.getByRole('button', { name: '• 列表' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalled());
    await screen.findByText('v2 · 草稿');
    const editable = container.querySelector<HTMLElement>('[data-block="p-1"]');
    if (!editable?.firstChild) throw new Error('列表 Word 编辑块未渲染');
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    fireEvent.keyUp(editable);
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '检查列表项' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '检查列表项', selection: { type: 'word_block', blockId: 'p-1', start: word.blocks[0].text.length, end: word.blocks[0].text.length } }));
  });

  it('splits a Word paragraph at the caret when Enter is pressed', async () => {
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    const editable = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-block="p-1"]');
      if (!node?.firstChild) throw new Error('Word 编辑块未渲染');
      return node;
    });
    const text = editable.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyDown(editable, { key: 'Enter' });
    await waitFor(() => expect(container.querySelectorAll('[data-block]').length).toBe(2));
    expect(container.querySelector('[data-block="p-1"]')?.textContent).toBe('原始');
    expect(container.querySelector('[data-block="paragraph-2"]')?.textContent).toBe('段落。');
  });

  it('applies Word toolbar formatting and a table through the same saveable document, with reversible history', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    fireEvent.change(screen.getByLabelText('字体'), { target: { value: '宋体' } });
    fireEvent.change(screen.getByLabelText('字号'), { target: { value: '13' } });
    fireEvent.click(screen.getByTitle('加粗'));
    fireEvent.click(screen.getByTitle('插入表格'));
    expect(container.querySelectorAll('.word-page table')).toHaveLength(1);
    fireEvent.click(screen.getByTitle('撤销'));
    expect(container.querySelectorAll('.word-page table')).toHaveLength(0);
    fireEvent.click(screen.getByTitle('重做'));
    expect(container.querySelectorAll('.word-page table')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, actor: 'human',
      content: expect.objectContaining({ blocks: expect.arrayContaining([expect.objectContaining({ id: 'p-1', style: expect.objectContaining({ fontFamily: '宋体', fontSizePt: 13, bold: true }) }), expect.objectContaining({ kind: 'table' })]) }),
    })));
  });

  it('shows a save failure while retaining the unsaved document in the editor', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    const editable = container.querySelector<HTMLElement>('[data-block="p-1"]');
    if (!editable) throw new Error('Word 编辑块未渲染');
    editable.textContent = '保存失败后仍保留的草稿。';
    fireEvent.input(editable);
    const saveButtons = screen.getAllByRole('button', { name: '保存版本' });
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(await screen.findByText(/保存未完成/u)).toBeTruthy();
    expect(metis.saveOutcome).toHaveBeenCalledTimes(1);
    expect(screen.getByText('保存失败后仍保留的草稿。')).toBeTruthy();
  });

  it('shows a restore failure without replacing the version currently open in the editor', async () => {
    const metis = installMetis();
    metis.getOutcome.mockResolvedValue({ outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: updatedVersion });
    metis.listOutcomes.mockResolvedValue([{ ...outcome, currentVersion: 2, updatedAt: 2 }]);
    metis.listOutcomeVersions.mockResolvedValue([updatedVersion, version]);
    metis.restoreOutcome.mockResolvedValue(null);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('AI 已修改的段落。');
    fireEvent.click(screen.getByTitle('恢复 v1'));
    expect(await screen.findByText(/恢复未完成/u)).toBeTruthy();
    expect(screen.getByText('AI 已修改的段落。')).toBeTruthy();
  });

  it('imports a DOCX into the current Word as an immutable import-owned version', async () => {
    const metis = installMetis();
    const importedWord = { ...word, blocks: [{ ...word.blocks[0], text: '从外部 DOCX 导入的段落。', style: { fontFamily: '宋体', fontSizePt: 12 } }] };
    const importVersion = { ...version, version: 2, content: importedWord, note: '导入 external.docx', createdBy: 'import' as const, parentVersion: 1, createdAt: 2 };
    metis.importOutcomeWordDocx.mockResolvedValue({ ok: true, fileName: 'external.docx', importToken: 'docx-import-token', document: importedWord, preview: { images: [] }, warnings: [] });
    metis.commitOutcomeWordDocxImportMedia.mockResolvedValue({ ok: true, outcomeId: 'out-1', document: importedWord });
    metis.saveOutcome.mockResolvedValue({ outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: importVersion });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    fireEvent.click(screen.getByRole('button', { name: '导入 Word DOCX' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, content: importedWord, note: '导入 external.docx', actor: 'import' })));
    expect(await screen.findByText(/已导入 external\.docx 并保存为新版本/u)).toBeTruthy();
    expect(screen.getByText('从外部 DOCX 导入的段落。')).toBeTruthy();
  });

  it('creates an import-owned Word outcome when no current Word is open and exports only a saved version', async () => {
    const metis = installMetis();
    const importedWord = { ...word, blocks: [{ ...word.blocks[0], text: '新导入文档。' }] };
    const importedOutcome = { ...outcome, id: 'out-import', title: 'new-report', currentVersion: 1 };
    const importedVersion = { ...version, outcomeId: 'out-import', content: importedWord, note: '导入 new-report.docx', createdBy: 'import' as const };
    metis.importOutcomeWordDocx.mockResolvedValue({ ok: true, fileName: 'new-report.docx', importToken: 'docx-import-token-new', document: importedWord, preview: { images: [] }, warnings: [{ code: 'unsupported_drawing', message: '图片未保真' }, { code: 'unsupported_table_layout', message: '表格布局已降级' }, { code: 'unsupported_revision', message: '批注未导入' }] });
    metis.commitOutcomeWordDocxImportMedia.mockResolvedValue({ ok: true, outcomeId: 'out-import', document: importedWord });
    metis.createOutcome.mockResolvedValue({ outcome: importedOutcome, version: importedVersion });
    metis.getOutcome.mockResolvedValue({ outcome: importedOutcome, version: importedVersion });
    metis.listOutcomeVersions.mockResolvedValue([importedVersion]);
    metis.exportOutcomeWordDocx.mockResolvedValue({ ok: true, fileName: 'new-report.docx', warnings: [] });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '导入 Word DOCX' }));
    await waitFor(() => expect(metis.createOutcome).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', title: 'new-report', kind: 'word', content: importedWord, note: '导入 new-report.docx', actor: 'import' })));
    expect(await screen.findByText(/已导入 new-report\.docx 并创建成果 v1/u)).toBeTruthy();
    expect(screen.getByText(/图片未保真/u)).toBeTruthy();
    expect(screen.getByText(/表格布局已降级/u)).toBeTruthy();
    expect(screen.getByText(/批注未导入/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出 DOCX' }));
    await waitFor(() => expect(metis.exportOutcomeWordDocx).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-import', version: 1 }));
    expect(await screen.findByText(/已导出 new-report\.docx/u)).toBeTruthy();
  });

  it('hydrates imported Word furniture and page settings into the METIS preview before editing and export', async () => {
    const metis = installMetis();
    const importedWord = {
      ...word,
      page: { paper: 'Letter', width: 12240, height: 15840, marginTop: 72, marginRight: 90, marginBottom: 108, marginLeft: 126, pageNumber: true },
      header: '导入页眉', footer: '导入页脚',
      blocks: [{ ...word.blocks[0], text: '可编辑导入正文。', style: { fontFamily: '仿宋', fontSize: 15, align: 'center', lineSpacing: 2 } }],
    };
    const importedOutcome = { ...outcome, id: 'out-import-settings', title: 'settings-report', currentVersion: 1 };
    const importedVersion = { ...version, outcomeId: importedOutcome.id, content: importedWord, note: '导入 settings-report.docx', createdBy: 'import' as const };
    metis.importOutcomeWordDocx.mockResolvedValue({ ok: true, fileName: 'settings-report.docx', importToken: 'docx-import-token-settings', document: importedWord, preview: { images: [] }, warnings: [] });
    metis.commitOutcomeWordDocxImportMedia.mockResolvedValue({ ok: true, outcomeId: importedOutcome.id, document: importedWord });
    metis.createOutcome.mockResolvedValue({ outcome: importedOutcome, version: importedVersion });
    metis.getOutcome.mockResolvedValue({ outcome: importedOutcome, version: importedVersion });
    metis.listOutcomeVersions.mockResolvedValue([importedVersion]);
    metis.exportOutcomeWordDocx.mockResolvedValue({ ok: true, fileName: 'settings-report.docx', warnings: [] });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '导入 Word DOCX' }));
    expect(await screen.findByText('导入页眉')).toBeTruthy();
    expect(screen.getByText('导入页脚')).toBeTruthy();
    expect(screen.getByLabelText('页码')).toBeTruthy();
    const page = container.querySelector<HTMLElement>('.word-page');
    if (!page) throw new Error('Word 页面预览未渲染');
    expect(page.style.getPropertyValue('--word-page-width')).toBe('816px');
    expect(page.style.getPropertyValue('--word-page-margin-left')).toBe('168px');
    fireEvent.click(screen.getByRole('button', { name: '排版' }));
    expect((screen.getByLabelText('正文字体') as HTMLInputElement).value).toBe('仿宋');
    expect((screen.getByLabelText('左边距') as HTMLInputElement).value).toBe('4.45');
    fireEvent.click(screen.getByRole('button', { name: '返回编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 DOCX' }));
    await waitFor(() => expect(metis.exportOutcomeWordDocx).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: importedOutcome.id, version: 1 }));
  });

  it('imports a PPTX into the current presentation as an immutable import-owned version and shows conversion warnings', async () => {
    const metis = installMetis();
    const importedPpt = { ...ppt, pages: [{ ...ppt.pages[0], title: '导入后的封面' }] };
    const importVersion = { ...pptVersion, version: 2, content: importedPpt, note: '导入 external-deck.pptx', createdBy: 'import' as const, parentVersion: 1, createdAt: 2 };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.importOutcomePptx.mockResolvedValue({ ok: true, fileName: 'external-deck.pptx', importToken: 'pptx-import-token', document: importedPpt, warnings: [{ code: 'unsupported_animation', message: '动画未导入' }, { code: 'unsupported_notes', message: '备注未导入' }, { code: 'unsupported_theme', message: '主题已降级' }] });
    metis.commitOutcomePptxImportMedia.mockResolvedValue({ ok: true, outcomeId: 'out-ppt', document: importedPpt });
    metis.saveOutcome.mockResolvedValue({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: importVersion });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '导入 PPTX' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', outcomeId: 'out-ppt', baseVersion: 1, content: importedPpt, note: '导入 external-deck.pptx', actor: 'import' })));
    expect(await screen.findByText(/已导入 external-deck\.pptx 并保存为新版本/u)).toBeTruthy();
    expect(screen.getByText(/动画未导入/u)).toBeTruthy();
    expect(screen.getByText(/备注未导入/u)).toBeTruthy();
    expect(screen.getByText(/主题已降级/u)).toBeTruthy();
    expect(screen.getByText('导入后的封面')).toBeTruthy();
  });

  it('creates an import-owned PPT outcome when no presentation is open and exports the displayed immutable version', async () => {
    const metis = installMetis();
    const importedPpt = { ...ppt, pages: [{ ...ppt.pages[0], title: '项目汇报封面' }] };
    const importedOutcome = { ...pptOutcome, id: 'out-ppt-import', title: 'project-report', currentVersion: 1 };
    const importedVersion = { ...pptVersion, outcomeId: 'out-ppt-import', content: importedPpt, note: '导入 project-report.pptx', createdBy: 'import' as const };
    metis.importOutcomePptx.mockResolvedValue({ ok: true, fileName: 'project-report.pptx', importToken: 'pptx-import-token', document: importedPpt, warnings: [{ code: 'unsupported_master', message: '母版布局已降级' }] });
    metis.commitOutcomePptxImportMedia.mockResolvedValue({ ok: true, outcomeId: 'out-ppt-import', document: importedPpt });
    metis.createOutcome.mockResolvedValue({ outcome: importedOutcome, version: importedVersion });
    metis.getOutcome.mockResolvedValue({ outcome: importedOutcome, version: importedVersion });
    metis.listOutcomeVersions.mockResolvedValue([importedVersion]);
    metis.exportOutcomePptx.mockResolvedValue({ ok: true, fileName: 'project-report.pptx', warnings: [{ code: 'unsupported_theme', message: '主题效果按基础样式导出' }] });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '导入 PPTX' }));
    await waitFor(() => expect(metis.createOutcome).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', title: 'project-report', kind: 'ppt', content: importedPpt, note: '导入 project-report.pptx', actor: 'import' })));
    expect(await screen.findByText(/已导入 project-report\.pptx 并创建成果 v1/u)).toBeTruthy();
    expect(screen.getByText(/母版布局已降级/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出 PPTX' }));
    await waitFor(() => expect(metis.exportOutcomePptx).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-ppt-import', version: 1 }));
    expect(await screen.findByText(/已导出 project-report\.pptx/u)).toBeTruthy();
    expect(screen.getByText(/主题效果按基础样式导出/u)).toBeTruthy();
  });

  it('blocks PPTX import and export while a PPT draft is unsaved, preserving its grid draft', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    expect(await screen.findByText('已选中')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导入 PPTX' }));
    expect(await screen.findByText(/请先保存版本，再导入 PPTX/u)).toBeTruthy();
    expect(metis.importOutcomePptx).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '导出 PPTX' }));
    expect(await screen.findByText(/请先保存版本，再导出 PPTX/u)).toBeTruthy();
    expect(metis.exportOutcomePptx).not.toHaveBeenCalled();
    expect(screen.getByText('已选中')).toBeTruthy();
  });

  it('shows real PPTX cancellation and bridge-error feedback without pretending the operation succeeded', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.importOutcomePptx.mockResolvedValue({ ok: false, code: 'cancelled', message: '已取消 PPTX 导入。', warnings: [] });
    metis.exportOutcomePptx.mockResolvedValue({ ok: false, code: 'pptx_write_failed', message: 'PPTX 写入失败。', warnings: [] });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: '导入 PPTX' }));
    expect(await screen.findByText('已取消 PPTX 导入。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出 PPTX' }));
    expect(await screen.findByText('PPTX 写入失败。')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    expect(metis.createOutcome).not.toHaveBeenCalled();
  });

  it('prevents repeated PPTX import or export clicks from duplicating bridge work or import versions', async () => {
    const metis = installMetis();
    const importedPpt = { ...ppt, pages: [{ ...ppt.pages[0], title: '单次导入封面' }] };
    const importVersion = { ...pptVersion, version: 2, content: importedPpt, note: '导入 once.pptx', createdBy: 'import' as const, parentVersion: 1, createdAt: 2 };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    metis.importOutcomePptx.mockResolvedValue({ ok: true, fileName: 'once.pptx', importToken: 'pptx-import-token', document: importedPpt, warnings: [] });
    metis.commitOutcomePptxImportMedia.mockResolvedValue({ ok: true, outcomeId: 'out-ppt', document: importedPpt });
    metis.saveOutcome.mockResolvedValue({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: importVersion });
    let finishExport: ((value: { ok: false; code: string; message: string; warnings: never[] }) => void) | undefined;
    metis.exportOutcomePptx.mockImplementation(() => new Promise((resolve) => { finishExport = resolve; }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    const importButton = screen.getByRole('button', { name: '导入 PPTX' });
    fireEvent.click(importButton); fireEvent.click(importButton);
    await waitFor(() => expect(metis.importOutcomePptx).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(metis.commitOutcomePptxImportMedia).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const exportButton = screen.getByRole('button', { name: '导出 PPTX' });
    fireEvent.click(exportButton); fireEvent.click(exportButton);
    expect(metis.exportOutcomePptx).toHaveBeenCalledTimes(1);
    expect(exportButton.disabled).toBe(true);
    finishExport?.({ ok: false, code: 'cancelled', message: '已取消 PPTX 导出。', warnings: [] });
    expect(await screen.findByText('已取消 PPTX 导出。')).toBeTruthy();
  });

  it('shows a keyboard-dismissible local AI popover only for a real Word text range', async () => {
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    selectWordText(container, 0, 2);
    expect(await screen.findByRole('dialog', { name: '所选文本 AI 操作' })).toBeTruthy();
    expect(screen.getAllByText('已选 2 个字符').length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '所选文本 AI 操作' })).toBeNull());
  });

  it('uses the current block range for a local AI request and refreshes only the bridge-committed version', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    selectWordText(container, 0, 2);
    fireEvent.click(await screen.findByRole('button', { name: '改写' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '请在不改变含义的前提下改写所选文本，使其更清晰、准确。', selection: { type: 'word_block', blockId: 'p-1', start: 0, end: 2 } }));
    expect(await screen.findByText('AI 已修改的段落。')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    await waitFor(() => expect(metis.listScopedConversation).toHaveBeenCalledTimes(2));
  });

  it('disables local AI while a Word draft is unsaved and keeps that draft in the editor', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    const editable = container.querySelector<HTMLElement>('[data-block="p-1"]');
    if (!editable) throw new Error('Word 编辑块未渲染');
    editable.textContent = '未保存的局部草稿。';
    fireEvent.input(editable);
    selectWordText(container, 0, 2);
    expect(await screen.findByText(/当前草稿未保存。请先保存版本，再使用局部 AI/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: '改写' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('button', { name: '发送' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(metis.chatOutcomeAssistant).not.toHaveBeenCalled();
    expect(screen.getByText('未保存的局部草稿。')).toBeTruthy();
  });

  it('shows answer-only, error, and cancellation results from local AI without fabricating an edit', async () => {
    const metis = installMetis();
    metis.chatOutcomeAssistant.mockResolvedValueOnce({
      status: 'completed', model: 'test-model', answer: '建议保留这两个关键词。', sources: [], diagnostics: [],
      userMessage: { id: 'message-local-u1', role: 'user', content: '压缩', sources: [], createdAt: 2 },
      assistantMessage: { id: 'message-local-a1', role: 'assistant', content: '建议保留这两个关键词。', sources: [], createdAt: 3 },
    }).mockResolvedValueOnce({ status: 'error', code: 'agent_error', message: '局部模型暂不可用。', answer: '', sources: [], diagnostics: [] }).mockResolvedValueOnce({ status: 'cancelled', code: 'agent_cancelled', message: '局部协同已取消。', answer: '', sources: [], diagnostics: [] });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    selectWordText(container, 0, 2);
    fireEvent.click(await screen.findByRole('button', { name: '压缩' }));
    expect(await screen.findByText('建议保留这两个关键词。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '扩写' }));
    expect(await screen.findByText('局部模型暂不可用。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '格式' }));
    expect(await screen.findByText('局部协同已取消。')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    expect(screen.getByText('原始段落。')).toBeTruthy();
  });

  it('opens local AI for a Word table cell selection and sends the real cell coordinates', async () => {
    const metis = installMetis();
    const tableWord = { type: 'word' as const, blocks: [
      { id: 'p-1', kind: 'paragraph' as const, text: '申报表正文。' },
      { id: 't-1', kind: 'table' as const, rows: [['项目名称', '博士后基金'], ['负责人', '张三']] },
    ], page: { paper: 'A4' }, header: '', footer: '' };
    const tableVersion = { ...version, content: tableWord };
    metis.getOutcome.mockResolvedValue({ outcome, version: tableVersion });
    metis.listOutcomeVersions.mockResolvedValue([tableVersion]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await waitFor(() => expect(container.querySelectorAll('.word-page:not(.word-page--measure) td').length).toBeGreaterThan(0));
    const cell = Array.from(container.querySelectorAll<HTMLElement>('.word-page:not(.word-page--measure) td')).find((item) => item.textContent === '博士后基金');
    const textNode = cell?.firstChild;
    if (!cell || !textNode) throw new Error('表格单元格未渲染');
    const range = document.createRange();
    range.setStart(textNode, 0); range.setEnd(textNode, 4);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    fireEvent.keyUp(cell);
    expect(await screen.findByRole('dialog', { name: '所选文本 AI 操作' })).toBeTruthy();
    expect(screen.getAllByText('已选 4 个字符').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: '改写' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '请在不改变含义的前提下改写所选文本，使其更清晰、准确。', selection: { type: 'word_table_cell', blockId: 't-1', row: 0, column: 1, start: 0, end: 4 } }));
  });

  it('clears a Word table-cell assistant selection after a save when rows may have moved', async () => {
    const metis = installMetis();
    const tableWord = { type: 'word' as const, blocks: [
      { id: 'p-1', kind: 'paragraph' as const, text: '申报表正文。' },
      { id: 't-1', kind: 'table' as const, rows: [['项目名称', '相同'], ['负责人', '保留']] },
    ], page: { paper: 'A4' }, header: '', footer: '' };
    const movedTableWord = { ...tableWord, blocks: [
      tableWord.blocks[0],
      { ...tableWord.blocks[1], rows: [['新增行', '相同'], ['项目名称', '相同'], ['负责人', '保留']] },
    ] };
    const tableVersion = { ...version, content: tableWord };
    const movedVersion = { ...version, version: 2, content: movedTableWord, note: '保存后表格行变化', parentVersion: 1, createdAt: 2 };
    metis.getOutcome.mockResolvedValue({ outcome, version: tableVersion });
    metis.listOutcomeVersions.mockResolvedValue([tableVersion]);
    metis.saveOutcome.mockResolvedValue({ outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: movedVersion });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await waitFor(() => expect(container.querySelectorAll('.word-page:not(.word-page--measure) td').length).toBeGreaterThan(0));
    const cell = Array.from(container.querySelectorAll<HTMLElement>('.word-page:not(.word-page--measure) td')).find((item) => item.textContent === '相同');
    const textNode = cell?.firstChild;
    if (!cell || !textNode) throw new Error('表格单元格未渲染');
    const range = document.createRange();
    range.setStart(textNode, 0); range.setEnd(textNode, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    fireEvent.keyUp(cell);
    expect(await screen.findByRole('dialog', { name: '所选文本 AI 操作' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('例如：根据项目中的实验结果重写当前段落'), { target: { value: '检查表格' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(metis.chatOutcomeAssistant).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', instruction: '检查表格' }));
  });

  it('moves an outcome into the trash and restores it from the trash dialog', async () => {
    const metis = installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    const deletedAt = Date.now();
    metis.listOutcomes.mockResolvedValue([]);
    metis.listOutcomeTrash.mockResolvedValue([{ outcome, deletedAt, expiresAt: deletedAt + 7 * 24 * 60 * 60 * 1000 }]);
    // 刘总反馈：单项「···」菜单已简化为行内直接回收站按钮。
    fireEvent.click(screen.getByRole('button', { name: '将「研究论文」移入回收站' }));
    await waitFor(() => expect(metis.archiveOutcome).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1' }));
    expect(await screen.findByText(/已移入回收站/u)).toBeTruthy();
    expect(screen.queryByText('原始段落。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开成果回收站' }));
    const dialog = await screen.findByRole('dialog', { name: '成果回收站' });
    expect(within(dialog).getByText('研究论文')).toBeTruthy();
    expect(within(dialog).getByText(/剩余 7 天/u)).toBeTruthy();
    metis.listOutcomeTrash.mockResolvedValue([]);
    metis.listOutcomes.mockResolvedValue([outcome]);
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(metis.restoreOutcomeFromTrash).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1' }));
    expect(await within(dialog).findByText('回收站是空的。')).toBeTruthy();
  });

  it('requires a second confirmation click before permanently deleting a trashed outcome', async () => {
    const metis = installMetis();
    const deletedAt = Date.now();
    metis.listOutcomeTrash.mockResolvedValue([{ outcome, deletedAt, expiresAt: deletedAt + 7 * 24 * 60 * 60 * 1000 }]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '打开成果回收站' }));
    const dialog = await screen.findByRole('dialog', { name: '成果回收站' });
    expect(within(dialog).getByText('研究论文')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }));
    expect(metis.deleteOutcomePermanent).not.toHaveBeenCalled();
    expect(within(dialog).getByText('不可恢复')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认彻底删除' }));
    await waitFor(() => expect(metis.deleteOutcomePermanent).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1' }));
  });

  it('uses only persisted image media from the real bridge, previews it through readOutcomeMedia, and saves it as a human version on demand', async () => {
    const metis = installMetis();
    const generatedMedia = { id: 'media-generated', mediaType: 'image/png' as const, displayName: 'AI-generated-cover.png', byteLength: 2048 };
    metis.listOutcomes.mockResolvedValue([imageOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: imageOutcome, version: imageVersion });
    metis.listOutcomeVersions.mockResolvedValue([imageVersion]);
    metis.generateOutcomeImage.mockResolvedValue({ ok: true, media: generatedMedia, mimeType: 'image/png' });
    metis.readOutcomeMedia.mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');
    metis.saveOutcome.mockImplementation(async (request: { content: typeof imageDocument }) => ({ outcome: { ...imageOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...imageVersion, version: 2, content: request.content, note: '保存图片成果', createdBy: 'human' as const, parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('项目封面图'));
    fireEvent.change(await screen.findByLabelText('图片生成提示词'), { target: { value: '克制的蓝色研究封面信息图' } });
    fireEvent.change(screen.getByLabelText('图片生成质量'), { target: { value: 'high' } });
    const generate = screen.getByRole('button', { name: '生成图片' });
    fireEvent.click(generate); fireEvent.click(generate);
    await waitFor(() => expect(metis.generateOutcomeImage).toHaveBeenCalledTimes(1));
    expect(metis.generateOutcomeImage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', outcomeId: 'out-image', prompt: '克制的蓝色研究封面信息图', quality: 'high', visualContext: expect.stringContaining('成果类型：图片') }));
    expect(await screen.findByText(/已收到并引用真实持久化图片/u)).toBeTruthy();
    expect(await screen.findByAltText('AI-generated-cover.png')).toBeTruthy();
    expect(metis.readOutcomeMedia).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-image', mediaId: 'media-generated' });
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    const saveButtons = screen.getAllByRole('button', { name: '保存版本' });
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', outcomeId: 'out-image', actor: 'human', content: { ...imageDocument, media: generatedMedia } })));
  });

  it('exports a persisted safe SVG through the dedicated bridge and surfaces the result', async () => {
    const metis = installMetis();
    const svgMedia = { id: 'media-svg', mediaType: 'image/svg+xml' as const, displayName: 'figure.svg', byteLength: 512 };
    const svgDocument = { ...imageDocument, media: svgMedia };
    const svgOutcome = { ...imageOutcome, title: '安全插图' };
    const svgVersion = { ...imageVersion, content: svgDocument };
    metis.listOutcomes.mockResolvedValue([svgOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: svgOutcome, version: svgVersion });
    metis.listOutcomeVersions.mockResolvedValue([svgVersion]);
    metis.readOutcomeMedia.mockResolvedValue('data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>').toString('base64'));
    metis.exportOutcomeMediaSvg.mockResolvedValue({ ok: true, fileName: 'figure.svg' });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('安全插图'));
    fireEvent.click(await screen.findByRole('button', { name: '导出 SVG' }));
    await waitFor(() => expect(metis.exportOutcomeMediaSvg).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-image', mediaId: 'media-svg' }));
    expect(await screen.findByText(/已导出 figure.svg/u)).toBeTruthy();
  });

  it('renders the Word managed image preview as a real <img> fed by the readOutcomeMedia data URL', async () => {
    const metis = installMetis();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=';
    const wordWithImage = { ...word, blocks: [{ id: 'img-1', kind: 'image' as const, imageRef: 'om-word-figure', mediaType: 'image/png' as const, displayName: 'word-figure.png' }] };
    const wordWithImageVersion = { ...version, content: wordWithImage };
    metis.getOutcome.mockResolvedValue({ outcome, version: wordWithImageVersion });
    metis.listOutcomeVersions.mockResolvedValue([wordWithImageVersion]);
    metis.readOutcomeMedia.mockResolvedValue(dataUrl);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    const image = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('.word-image-block img');
      if (!node) throw new Error('Word 托管图片未渲染');
      return node;
    });
    expect(image.getAttribute('src')).toBe(dataUrl);
    expect(image.getAttribute('alt')).toBe('word-figure.png');
    expect(metis.readOutcomeMedia).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', mediaId: 'om-word-figure' });
    expect(container.querySelector('.word-image-block__placeholder')).toBeNull();
  });

  it('renders the PPT managed image preview as a real <img> fed by the readOutcomeMedia data URL', async () => {
    const metis = installMetis();
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
    const pptWithManagedImage = { ...ppt, pages: [{ ...ppt.pages[0], elements: [{ id: 'image-managed', type: 'image' as const, x: 4, y: 3, width: 12, height: 7, locked: false, props: { mediaId: 'ppt-media-managed', mediaType: 'image/jpeg', displayName: 'deck-figure.jpg' } }] }] };
    const pptWithManagedImageVersion = { ...pptVersion, content: pptWithManagedImage };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptWithManagedImageVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptWithManagedImageVersion]);
    metis.readOutcomeMedia.mockResolvedValue(dataUrl);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    const image = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('img.ppt-element__managed-image');
      if (!node) throw new Error('PPT 托管图片未渲染');
      return node;
    });
    expect(image.getAttribute('src')).toBe(dataUrl);
    expect(image.getAttribute('alt')).toBe('deck-figure.jpg');
    expect(metis.readOutcomeMedia).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-ppt', mediaId: 'ppt-media-managed' });
    expect(screen.queryByText('deck-figure.jpg（预览加载中）')).toBeNull();
  });

  it('keeps a DOCX-imported Word image on its save-time placeholder instead of reading uncommitted media', async () => {
    const metis = installMetis();
    const pendingImportWord = { ...word, blocks: [{ id: 'img-import-1', kind: 'image' as const, imageRef: 'docx-import-image-1', mediaType: 'image/png' as const, displayName: 'imported-figure.png' }] };
    const pendingImportVersion = { ...version, version: 2, content: pendingImportWord, note: '导入 external.docx', createdBy: 'import' as const, parentVersion: 1, createdAt: 2 };
    metis.listOutcomes.mockResolvedValue([{ ...outcome, currentVersion: 2, updatedAt: 2 }]);
    metis.getOutcome.mockResolvedValue({ outcome: { ...outcome, currentVersion: 2, updatedAt: 2 }, version: pendingImportVersion });
    metis.listOutcomeVersions.mockResolvedValue([pendingImportVersion, version]);
    metis.readOutcomeMedia.mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    expect(await screen.findByText('imported-figure.png（导入预览；保存时提交媒体）')).toBeTruthy();
    expect(screen.getByText('imported-figure.png · image/png')).toBeTruthy();
    expect(container.querySelector('.word-image-block img')).toBeNull();
    expect(metis.readOutcomeMedia).not.toHaveBeenCalled();
  });

  it('shows the real image-generation configuration failure and does not fabricate an image result', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([imageOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: imageOutcome, version: imageVersion });
    metis.listOutcomeVersions.mockResolvedValue([imageVersion]);
    metis.generateOutcomeImage.mockResolvedValue({ ok: false, code: 'image_generation_unconfigured' });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('项目封面图'));
    fireEvent.change(await screen.findByLabelText('图片生成提示词'), { target: { value: '研究封面' } });
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    expect(await screen.findByText(/尚未在设置中完成 Provider、模型或密钥配置/u)).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a provider error without replacing the existing image draft or creating a version', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([imageOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: imageOutcome, version: imageVersion });
    metis.listOutcomeVersions.mockResolvedValue([imageVersion]);
    metis.generateOutcomeImage.mockResolvedValue({ ok: false, code: 'image_generation_provider_failed' });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('项目封面图'));
    fireEvent.change(await screen.findByLabelText('图片生成提示词'), { target: { value: '研究封面' } });
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    expect(await screen.findByText(/图片生成服务没有完成请求/u)).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('generates only for a selected PPT image placeholder, sends visual context, and saves the returned media reference only when the user saves', async () => {
    const metis = installMetis();
    const pptWithImage = { ...ppt, theme: { primary: '#124d72', accent: '#d47c26' }, pages: [{ ...ppt.pages[0], elements: [{ id: 'image-placeholder', type: 'image' as const, x: 6, y: 4, width: 12, height: 7, locked: false, props: { text: '图片占位' } }] }] };
    const pptWithImageVersion = { ...pptVersion, content: pptWithImage };
    const generatedMedia = { id: 'ppt-media-1', mediaType: 'image/jpeg' as const, displayName: 'AI-generated-ppt.jpg', byteLength: 4096 };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptWithImageVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptWithImageVersion]);
    metis.generateOutcomeImage.mockResolvedValue({ ok: true, media: generatedMedia, mimeType: 'image/jpeg' });
    metis.readOutcomeMedia.mockResolvedValue('data:image/jpeg;base64,/9j/');
    metis.saveOutcome.mockImplementation(async (request: { content: typeof pptWithImage }) => ({ outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...pptWithImageVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', createdBy: 'human' as const, parentVersion: 1, createdAt: 2 } }));
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    fireEvent.click(await screen.findByRole('button', { name: '选择图片占位' }));
    fireEvent.change(await screen.findByLabelText('PPT 图片生成提示词'), { target: { value: '研究方法关系图' } });
    fireEvent.change(screen.getByLabelText('PPT 图片生成质量'), { target: { value: 'hd' } });
    fireEvent.click(screen.getByRole('button', { name: '生成并关联图片' }));
    await waitFor(() => expect(metis.generateOutcomeImage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', outcomeId: 'out-ppt', prompt: '研究方法关系图', quality: 'hd', visualContext: expect.stringContaining('"ratio":"16:9"') })));
    const imageRequest = metis.generateOutcomeImage.mock.calls[0][0] as { visualContext: string };
    expect(imageRequest.visualContext).toContain('"width":12');
    expect(imageRequest.visualContext).toContain('"height":7');
    expect(imageRequest.visualContext).toContain('"primary":"#124d72"');
    expect(await screen.findByText(/已将真实持久化图片/u)).toBeTruthy();
    expect(await screen.findByAltText('AI-generated-ppt.jpg')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const request = metis.saveOutcome.mock.calls[0][0] as { content: { pages: Array<{ elements: Array<{ props: Record<string, unknown> }> }> } };
    expect(request.content.pages[0].elements[0]?.props).toMatchObject({ mediaId: 'ppt-media-1', mediaType: 'image/jpeg', displayName: 'AI-generated-ppt.jpg' });
  });

  it('edits supported image transforms as a dirty draft, saves them in one PptDocument, and rehydrates them after reopening', async () => {
    const metis = installMetis();
    const imageProps = { mediaId: 'ppt-media-1', mediaType: 'image/jpeg', displayName: 'research-image.jpg', text: '图片占位', rotationDeg: 12, flipH: false, flipV: false, crop: { left: 0.02, top: 0.03, right: 0.04, bottom: 0.05 }, opacity: 0.8, mask: 'roundRect' };
    const imagePpt = { ...ppt, pages: [{ ...ppt.pages[0], elements: [{ id: 'image-transform', type: 'image' as const, x: 4, y: 3, width: 14, height: 8, locked: false, props: imageProps }] }] };
    let persisted = imagePpt;
    const imagePptVersion = { ...pptVersion, content: imagePpt };
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockImplementation(async () => ({ outcome: { ...pptOutcome, currentVersion: persisted === imagePpt ? 1 : 2 }, version: { ...pptVersion, version: persisted === imagePpt ? 1 : 2, content: persisted } }));
    metis.listOutcomeVersions.mockImplementation(async () => [{ ...pptVersion, version: persisted === imagePpt ? 1 : 2, content: persisted }]);
    metis.saveOutcome.mockImplementation(async (request: { content: typeof imagePpt }) => {
      persisted = request.content;
      return { outcome: { ...pptOutcome, currentVersion: 2, updatedAt: 2 }, version: { ...imagePptVersion, version: 2, content: request.content, note: '保存 PPT Grid 布局', parentVersion: 1, createdAt: 2 } };
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    fireEvent.click(await screen.findByRole('button', { name: '选择图片占位' }));
    fireEvent.change(screen.getByLabelText('图片旋转角度'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('图片透明度'), { target: { value: '65' } });
    fireEvent.change(screen.getByLabelText('图片蒙版'), { target: { value: 'ellipse' } });
    fireEvent.click(screen.getByLabelText('水平翻转'));
    fireEvent.click(screen.getByLabelText('垂直翻转'));
    fireEvent.change(screen.getByLabelText('图片裁切左'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('图片裁切上'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('图片裁切右'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('图片裁切下'), { target: { value: '5' } });
    expect(screen.getByText('图片属性已写入当前 PPT 草稿；点击“保存”创建新版本。')).toBeTruthy();
    expect(metis.saveOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(metis.saveOutcome).toHaveBeenCalledTimes(1));
    const savedElement = persisted.pages[0].elements[0];
    expect(savedElement?.props).toMatchObject({ rotationDeg: 45, opacity: 0.65, flipH: true, flipV: true, mask: 'ellipse', crop: { left: 0.1, top: 0.2, right: 0.15, bottom: 0.05 } });
    fireEvent.click(screen.getByText('研究汇报'));
    fireEvent.click(await screen.findByRole('button', { name: '选择图片占位' }));
    await waitFor(() => expect((screen.getByLabelText('图片旋转角度') as HTMLInputElement).value).toBe('45'));
    expect((screen.getByLabelText('图片透明度') as HTMLInputElement).value).toBe('65');
    expect((screen.getByLabelText('图片蒙版') as HTMLSelectElement).value).toBe('ellipse');
    expect((screen.getByLabelText('图片裁切左') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('图片裁切上') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('图片裁切右') as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText('图片裁切下') as HTMLInputElement).value).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: '锁定' }));
    expect((screen.getByLabelText('图片旋转角度') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('图片蒙版') as HTMLSelectElement).disabled).toBe(true);
  });

  it('requires a selected image placeholder for PPT generation and keeps the controls disabled when the PPT is dirty', async () => {
    const metis = installMetis();
    metis.listOutcomes.mockResolvedValue([pptOutcome]);
    metis.getOutcome.mockResolvedValue({ outcome: pptOutcome, version: pptVersion });
    metis.listOutcomeVersions.mockResolvedValue([pptVersion]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究汇报'));
    await screen.findByText('16:9 · 32 × 18 Grid');
    fireEvent.click(screen.getByRole('button', { name: 'AI 图片' }));
    expect(await screen.findByText(/请先选择一个图片占位元素/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('添加 PPT 元素'), { target: { value: 'image' } });
    await screen.findByRole('button', { name: '选择图片占位' });
    fireEvent.click(screen.getByRole('button', { name: '选择图片占位' }));
    fireEvent.change(screen.getByLabelText('PPT 图片生成提示词'), { target: { value: '不会提交' } });
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    fireEvent.click(screen.getByRole('button', { name: '选择图片占位' }));
    expect(await screen.findByText(/当前 PPT 有未保存编辑/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: '生成并关联图片' }) as HTMLButtonElement).disabled).toBe(true);
    expect(metis.generateOutcomeImage).not.toHaveBeenCalled();
  });

  it('renames an outcome category through the accessible prompt dialog instead of window.prompt', async () => {
    const metis = installMetis();
    metis.listOutcomeCategories.mockResolvedValue([{ id: 'cat-1', name: '旧分类名' }]);
    metis.renameOutcomeCategory.mockImplementation(async ({ name }: { name: string }) => {
      metis.listOutcomeCategories.mockResolvedValue([{ id: 'cat-1', name }]);
      return true;
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重命名旧分类名' }));
    const input = await screen.findByLabelText('分类名称');
    expect((input as HTMLInputElement).value).toBe('旧分类名');
    fireEvent.change(input, { target: { value: '新分类名' } });
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    await waitFor(() => expect(metis.renameOutcomeCategory).toHaveBeenCalledWith({ categoryId: 'cat-1', name: '新分类名' }));
    expect(await screen.findByText('新分类名')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '重命名分类' })).toBeNull();
  });

  it('creates an outcome category through the accessible prompt dialog', async () => {
    const metis = installMetis();
    metis.createOutcomeCategory.mockImplementation(async ({ name }: { name: string }) => {
      metis.listOutcomeCategories.mockResolvedValue([{ id: 'cat-new', name }]);
      return { id: 'cat-new', name };
    });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '新建分类' }));
    fireEvent.change(await screen.findByLabelText('分类名称'), { target: { value: '实验数据组' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(metis.createOutcomeCategory).toHaveBeenCalledWith({ name: '实验数据组' }));
    expect(await screen.findByText('实验数据组')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '新建分类' })).toBeNull();
  });

  it('deletes an outcome category after confirmation so its outcomes fall back to uncategorized', async () => {
    const metis = installMetis();
    metis.listOutcomeCategories.mockResolvedValue([{ id: 'cat-1', name: '实验数据' }]);
    metis.deleteOutcomeCategory.mockImplementation(async () => { metis.listOutcomeCategories.mockResolvedValue([]); return true; });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除分类实验数据' }));
    await waitFor(() => expect(metis.deleteOutcomeCategory).toHaveBeenCalledWith({ categoryId: 'cat-1' }));
    await waitFor(() => expect(screen.queryByText('实验数据')).toBeNull());
    confirmSpy.mockRestore();
  });

  it('does not delete an outcome category when the confirmation is cancelled', async () => {
    const metis = installMetis();
    metis.listOutcomeCategories.mockResolvedValue([{ id: 'cat-1', name: '实验数据' }]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByRole('button', { name: '删除分类实验数据' }));
    expect(metis.deleteOutcomeCategory).not.toHaveBeenCalled();
    expect(await screen.findByText('实验数据')).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it('moves an outcome into a category via drag and drop with a highlighted drop target', async () => {
    const metis = installMetis();
    metis.listOutcomeCategories.mockResolvedValue([{ id: 'cat-1', name: '论文集' }]);
    metis.moveOutcome.mockResolvedValue({ ...outcome, categoryId: 'cat-1' });
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    const row = await screen.findByTitle('拖动到分类以整理成果');
    const section = (await screen.findByText('论文集')).closest('section');
    expect(section).toBeTruthy();
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 'out-1'), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(row, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-metis-outcome', 'out-1');
    fireEvent.dragOver(section as HTMLElement, { dataTransfer });
    expect((section as HTMLElement).className).toContain('drop-target');
    fireEvent.drop(section as HTMLElement, { dataTransfer });
    await waitFor(() => expect(metis.moveOutcome).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1', categoryId: 'cat-1' }));
    expect((section as HTMLElement).className).not.toContain('drop-target');
  });

  it('auto-dismisses the operation notice after eight seconds so it cannot cover the toolbar indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
      const { container } = render(<OutcomesPage />);
      const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
      await flush(5);
      fireEvent.click(screen.getByText('研究论文'));
      await flush(5);
      const editable = container.querySelector<HTMLElement>('[data-block="p-1"]');
      if (!editable) throw new Error('Word 编辑块未渲染');
      editable.textContent = '通知自动消失草稿。';
      fireEvent.input(editable);
      fireEvent.click(screen.getByRole('button', { name: '导出 DOCX' }));
      expect(screen.getByText(/请先保存版本，再导出 DOCX/u)).toBeTruthy();
      await flush(7990);
      expect(screen.getByText(/请先保存版本，再导出 DOCX/u)).toBeTruthy();
      await flush(20);
      expect(screen.queryByText(/请先保存版本，再导出 DOCX/u)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the local AI popover inside the viewport and closes it on scroll', async () => {
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    const { container } = render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 220 });
    const rectStub = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 24, y: 520, width: 310, height: 40, top: 520, left: 24, right: 334, bottom: 560, toJSON: () => ({}) } as DOMRect);
    try {
      selectWordText(container, 0, 2);
      const popover = await screen.findByRole('dialog', { name: '所选文本 AI 操作' });
      await waitFor(() => expect(Number.parseFloat(popover.style.top)).not.toBeNaN());
      const top = Number.parseFloat(popover.style.top);
      expect(top).toBeLessThanOrEqual(220 - 40 - 12);
      expect(top).toBeGreaterThan(0);
      fireEvent.scroll(window);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '所选文本 AI 操作' })).toBeNull());
    } finally {
      rectStub.mockRestore();
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    }
  });

  it('manages outcome conversations: lists units, starts a new conversation, deletes, and browses read-only history', async () => {
    const metis = installMetis() as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const units = [
      { id: 'conv-current', title: '', messageCount: 0, createdAt: 8, updatedAt: 9 },
      { id: 'conv-older', title: '上一轮协作', messageCount: 2, createdAt: 1, updatedAt: 4 },
    ];
    metis.outcomesConversationUnits = vi.fn().mockImplementation(async () => [...units]);
    metis.outcomesConversationCreate = vi.fn().mockResolvedValue({ id: 'conv-fresh', title: '', createdAt: 20 });
    metis.outcomesConversationDelete = vi.fn().mockImplementation(async ({ conversationId }: { conversationId: string }) => {
      const index = units.findIndex((unit) => unit.id === conversationId);
      if (index < 0) return false;
      units.splice(index, 1);
      return true;
    });
    metis.outcomesConversationById = vi.fn().mockResolvedValue([
      { id: 'om1', role: 'user', content: '早前的问题。', sources: [], createdAt: 2 },
      { id: 'oa1', role: 'assistant', content: '早前的回答。', sources: [], createdAt: 3 },
    ]);
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    await waitFor(() => expect(metis.outcomesConversationUnits).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1' }));

    fireEvent.click(screen.getByRole('button', { name: '查看成果协作历史' }));
    expect(await screen.findByText('研究论文 · 协作历史')).toBeTruthy();
    expect(screen.getByText('上一轮协作')).toBeTruthy();

    // 新对话：调用真实创建桥，本地清空，等待下一条消息进入新会话。
    fireEvent.click(screen.getByRole('button', { name: /新对话/u }));
    await waitFor(() => expect(metis.outcomesConversationCreate).toHaveBeenCalledWith({ projectId: 'project-1', outcomeId: 'out-1' }));
    expect(await screen.findByText('可以直接说：')).toBeTruthy();

    // 只读浏览旧会话：按 byId 精确读取，不改变当前持久化目标。
    fireEvent.click(screen.getByRole('button', { name: '查看对话 上一轮协作' }));
    await waitFor(() => expect(metis.outcomesConversationById).toHaveBeenCalledWith({ projectId: 'project-1', conversationId: 'conv-older' }));
    expect(await screen.findByText(/正在查看历史对话「上一轮协作」（只读）。/u)).toBeTruthy();
    expect(screen.getByText('早前的问题。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回当前对话' }));
    expect(screen.queryByText('早前的问题。')).toBeNull();

    // 删除旧会话：调用真实删除桥并刷新单元列表。
    fireEvent.click(screen.getByRole('button', { name: '删除对话 上一轮协作' }));
    await waitFor(() => expect(metis.outcomesConversationDelete).toHaveBeenCalledWith({ projectId: 'project-1', conversationId: 'conv-older' }));
    // 删除后列表真实刷新（至少经历挂载、新建后与删除后的重载）。
    expect(metis.outcomesConversationUnits.mock.calls.length).toBeGreaterThanOrEqual(3);
    await waitFor(() => expect(screen.queryByText('上一轮协作')).toBeNull());
  });

  it('keeps the single-history dialog unchanged when conversation management bridges are unavailable', async () => {
    installMetis();
    const { default: OutcomesPage } = await import('../../src/pages/OutcomesPage');
    render(<OutcomesPage />);
    fireEvent.click(await screen.findByText('研究论文'));
    await screen.findByText('原始段落。');
    fireEvent.click(screen.getByRole('button', { name: '查看成果协作历史' }));
    expect(await screen.findByText('研究论文 · 协作历史')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /新对话/u })).toBeNull();
    expect(screen.getByRole('button', { name: '返回成果助手继续协作' })).toBeTruthy();
  });
});
