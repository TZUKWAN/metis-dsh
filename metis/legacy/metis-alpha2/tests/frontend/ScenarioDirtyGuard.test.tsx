/**
 * 场景未保存守卫的 App 级回归测试（2026-08-24 刘总反馈：
 * 「不保存并离开 / 保存并离开」点击后弹窗不消失、导航不执行）。
 * 根因是被拦截的导航动作从未暂存（pendingLeaveRef 恒为 null），
 * 这里用真实渲染覆盖三个分支，防止回归。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen, within } from '@testing-library/react';
import App from '../../src/App';
import { useMetisStore } from '../../src/store';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';
import { resetScenarioWorkbenchDraftStoreForTests } from '../../src/personalization/ScenarioWorkbench';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions';

const builtin = buildBuiltinPersonalizationDefinitions();

function dirtyableScenario(): Extract<PersonalizationDefinition, { kind: 'scenario' }> {
  const source = builtin.find((item): item is Extract<PersonalizationDefinition, { kind: 'scenario' }> => item.kind === 'scenario')!;
  return {
    ...structuredClone(source),
    id: 'user:scenarios/dirty-guard-target',
    name: 'Dirty guard scenario',
    revision: 1,
    provenance: {
      ...source.provenance,
      origin: 'user',
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: source.id,
      locallyModified: true,
    },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    deliverable: {
      type: 'survey_report',
      typeLabel: '调研报告',
      sections: [{ id: 'final-report', title: 'Final report', kind: 'chapter', status: 'required' }],
    },
    workflow: [{
      id: 'compose-report',
      name: 'Compose report',
      description: 'Produce the report.',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 12,
      prompt: 'Write the report.',
      completionCriteria: ['The report is complete.'],
    }],
  };
}

let definitions: PersonalizationDefinition[];
let savePersonalization: ReturnType<typeof vi.fn>;

function setMockMetis() {
  definitions = [dirtyableScenario()];
  savePersonalization = vi.fn().mockImplementation((request: { definition: PersonalizationDefinition }) => {
    const index = definitions.findIndex((item) => item.id === request.definition.id);
    if (index >= 0) definitions[index] = request.definition;
    else definitions.push(request.definition);
    return Promise.resolve({ ok: true, code: 'saved', definition: request.definition });
  });
  (window as Window).metis = {
    listHITLRules: vi.fn().mockResolvedValue([]),
    toggleHITLRule: vi.fn().mockResolvedValue({ success: true }),
    getPendingApprovals: vi.fn().mockResolvedValue([]),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    onApprovalRequired: vi.fn().mockReturnValue(() => {}),
    listPersonalization: vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions: [...definitions] })),
    listPersonalizationTrash: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
    savePersonalization,
    forkPersonalization: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    archivePersonalization: vi.fn().mockResolvedValue({ ok: true, code: 'deleted', id: 'user:x' }),
    deletePersonalization: vi.fn().mockResolvedValue({ ok: true, code: 'deleted', id: 'user:x' }),
    restorePersonalizationFromTrash: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    applyPersonalizationExtension: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    selectFileCapability: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    exportPersonalizationBundle: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    importPersonalizationBundle: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    listPersonalizationSecrets: vi.fn().mockResolvedValue({ ok: true, contractVersion: 1, operationId: 'op', revision: 0, secrets: [] }),
    setPersonalizationSecret: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    removePersonalizationSecret: vi.fn().mockResolvedValue({ ok: false, code: 'unused' }),
    fundingTemplate: vi.fn().mockResolvedValue({ ok: true, contractVersion: 1, operationId: 'op', action: 'list', ownerId: 'local-user', projectId: 'p', templates: [] }),
    activatePersonalizationMcp: vi.fn(),
    getWorkspaceAgents: vi.fn().mockResolvedValue({ exists: false, content: '', version: 0, contentHash: '', projectId: 'p' }),
    setWorkspaceAgents: vi.fn().mockResolvedValue({ success: true, code: 'saved', version: 1, contentHash: 'h' }),
    compileScenarioHarness: vi.fn().mockResolvedValue({ ok: false, code: 'not_configured' }),
  } as unknown as MetisAPI;
}

async function openDirtyScenario() {
  fireEvent.click(await screen.findByTestId('personalization-trigger'));
  const library = await screen.findByTestId('sw-scenario-library');
  fireEvent.click(await within(library).findByRole('button', { name: 'Dirty guard scenario' }));
  await waitFor(() => {
    expect((screen.getByTestId('sw-config-name') as HTMLInputElement).value).toBe('Dirty guard scenario');
  });
  // 改一下场景名称，制造未保存的草稿差异。
  fireEvent.change(screen.getByTestId('sw-config-name'), { target: { value: 'Dirty guard scenario (edited)' } });
}

async function attemptLeaveToProjects() {
  const nav = screen.getByRole('navigation', { name: 'Metis' });
  fireEvent.click(within(nav).getAllByRole('button').find((button) => button.getAttribute('data-nav-id') === 'projects')!);
  await screen.findByTestId('sw-unsaved-dialog');
}

describe('App scenario dirty guard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // 跨页草稿缓存是模块级状态（jsdom 单次加载），用例间必须清空，
    // 否则前序用例「留在本页」的草稿会污染后续用例的打开状态。
    resetScenarioWorkbenchDraftStoreForTests();
    useMetisStore.setState({ papers: [], paperFilter: { query: '' }, notes: [], selectedNote: null, experiments: [], collections: [], selectedCollection: null, workflowRuns: [], locale: 'zh', theme: 'light', isHydrated: true });
    researchWorkspaceStore.setState({ activeProjectId: null });
    setMockMetis();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    (window as Window).metis = undefined;
  });

  it('留在本页 closes the dialog and keeps the workbench open', async () => {
    render(<App />);
    await screen.findByTestId('chat-page');
    await openDirtyScenario();
    await attemptLeaveToProjects();

    fireEvent.click(screen.getByRole('button', { name: '留在本页' }));
    await waitFor(() => expect(screen.queryByTestId('sw-unsaved-dialog')).toBeNull());
    expect(screen.queryByTestId('sw-scenario-library')).not.toBeNull();
    expect(savePersonalization).not.toHaveBeenCalled();
  });

  it('不保存并离开 closes the dialog and actually navigates away', async () => {
    render(<App />);
    await screen.findByTestId('chat-page');
    await openDirtyScenario();
    await attemptLeaveToProjects();

    fireEvent.click(screen.getByTestId('sw-unsaved-discard'));
    await waitFor(() => expect(screen.queryByTestId('sw-unsaved-dialog')).toBeNull());
    // 导航必须真实发生：场景工作台卸载、科研项目页出现。
    await waitFor(() => expect(screen.queryByTestId('sw-scenario-library')).toBeNull());
    expect(await screen.findByTestId('projects-page')).toBeDefined();
    expect(savePersonalization).not.toHaveBeenCalled();
  });

  it('保存并离开 persists the draft and then navigates away', async () => {
    render(<App />);
    await screen.findByTestId('chat-page');
    await openDirtyScenario();
    await attemptLeaveToProjects();

    fireEvent.click(screen.getByTestId('sw-unsaved-save'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('sw-unsaved-dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('sw-scenario-library')).toBeNull());
    expect(await screen.findByTestId('projects-page')).toBeDefined();
    // 保存的内容必须包含刚才的编辑。
    const saved = savePersonalization.mock.calls.at(-1)?.[0] as { definition: PersonalizationDefinition };
    expect(saved.definition.name).toBe('Dirty guard scenario (edited)');
  });
});
