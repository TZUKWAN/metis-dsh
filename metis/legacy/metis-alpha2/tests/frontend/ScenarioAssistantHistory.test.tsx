/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalizationDefinition, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/research-paper',
    kind: 'scenario',
    name: '实证论文',
    description: '',
    enabled: true,
    tags: [],
    revision: 3,
    provenance: { origin: 'user', author: 'test', version: '1.0.0', license: null, sourceUrl: null, sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null, locallyModified: true, createdAt: 1, updatedAt: 1 },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [{
      id: 'outline', name: '设计提纲', description: '', goal: '', prompt: '根据资料设计提纲。', inputs: [], outputs: [],
      completionCriteria: ['提纲覆盖全部交付章节。'], condition: null, skillIds: [], mcpIds: [], toolIds: [], dependsOn: [], maxTurns: 12,
    }],
    fullAccess: { mode: 'full_access', perActionConfirmation: false, liveSteering: true, silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 4_000 },
    output: { format: 'markdown', schema: null, plan: { primaryDeliverable: '实证论文', supportingArtifacts: [], qualityCriteria: [] }, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: [],
    capability: 'research',
    deliverable: {
      type: 'empirical_paper', language: 'zh', globalLength: '', secondarySections: { min: 2, max: 4 },
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      sections: [],
    },
    ...overrides,
  } as ScenarioDefinition;
}

type UnitsRow = { id: string; title: string; messageCount: number; createdAt: number; updatedAt: number };
type MessageRow = { id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number };

interface BridgeMock {
  compileScenarioHarness: ReturnType<typeof vi.fn>;
  scenarioConversationUnits: ReturnType<typeof vi.fn>;
  scenarioConversationCreate: ReturnType<typeof vi.fn>;
  scenarioConversationDelete: ReturnType<typeof vi.fn>;
  scenarioConversationMessages: ReturnType<typeof vi.fn>;
}

function installMetis(options: {
  units?: UnitsRow[];
  messagesByConversation?: Record<string, MessageRow[]>;
  createResult?: { id: string; title: string; createdAt: number } | null;
} = {}): BridgeMock {
  const messagesByConversation = options.messagesByConversation ?? {};
  let units = options.units ?? [];
  const metis: BridgeMock = {
    compileScenarioHarness: vi.fn().mockResolvedValue({ ok: false, code: 'not_used' }),
    scenarioConversationUnits: vi.fn().mockImplementation(async () => units),
    scenarioConversationCreate: vi.fn().mockImplementation(async (request: { title?: string }) => {
      const created = options.createResult === undefined
        ? { id: `conv-created-${Date.now()}`, title: request.title ?? '', createdAt: Date.now() }
        : options.createResult;
      if (!created) return null;
      units = [{ id: created.id, title: created.title, messageCount: 0, createdAt: created.createdAt, updatedAt: created.createdAt }, ...units];
      return created;
    }),
    scenarioConversationDelete: vi.fn().mockImplementation(async (request: { conversationId: string }) => {
      const before = units.length;
      units = units.filter((unit) => unit.id !== request.conversationId);
      return units.length < before;
    }),
    scenarioConversationMessages: vi.fn().mockImplementation(async (request: { conversationId: string }) => messagesByConversation[request.conversationId] ?? []),
  };
  window.metis = metis as unknown as typeof window.metis;
  return metis;
}

async function renderWorkbench(overrides: Partial<Parameters<typeof import('../../src/personalization/ScenarioWorkbench.js').default>[0]> = {}) {
  const current = overrides.definitions
    ? (overrides.definitions.find((item) => item.kind === 'scenario') as ScenarioDefinition)
    : scenario();
  const props = {
    zh: true,
    definitions: [current] as PersonalizationDefinition[],
    selectedId: current.id,
    onSelect: vi.fn(),
    // 2026-08-23 自动保存：编译成功后会调用保存，mock 需返回持久化成功。
    save: vi.fn().mockImplementation(async (definition: PersonalizationDefinition) => ({
      ok: true, code: 'saved', definition: { ...definition, revision: definition.revision + 1 },
    })),
    createScenario: vi.fn(),
    onActivateScenario: vi.fn(),
    onDeleteScenario: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    projectId: 'project-1',
    ...overrides,
  };
  const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
  render(<ScenarioWorkbench {...props} />);
  await waitFor(() => expect(screen.getByTestId('sw-configuration-assistant')).toBeTruthy());
  return { current, props };
}

describe('ScenarioConfigurationAssistant durable conversation history', () => {
  beforeEach(() => { window.metis = undefined; });

  it('auto-loads the newest saved conversation for the scenario and shows its persisted turns', async () => {
    installMetis({
      units: [
        { id: 'conv-new', title: '补全工作流', messageCount: 2, createdAt: 20, updatedAt: 30 },
        { id: 'conv-old', title: '第一轮需求', messageCount: 2, createdAt: 1, updatedAt: 10 },
      ],
      messagesByConversation: {
        'conv-new': [
          { id: 'm1', role: 'user', content: '请补全连续 Workflow。', sources: [], createdAt: 31 },
          { id: 'm2', role: 'assistant', content: '已把要求写入 Workflow。', sources: [], createdAt: 32 },
        ],
      },
    });
    await renderWorkbench();

    const toggle = screen.getByTestId('sw-assistant-history-toggle');
    expect(toggle).toHaveProperty('disabled', false);
    expect(screen.getByText('历史记录')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('sw-assistant-drawer')).toBeTruthy());
    // 最近会话自动载入：持久化消息直接可见。
    expect(await screen.findByText('请补全连续 Workflow。')).toBeTruthy();
    expect(screen.getByText('已把要求写入 Workflow。')).toBeTruthy();
    // 列表按最近优先排序，最新一条标注"当前"。
    expect(screen.getByText(/当前 · /u)).toBeTruthy();
    expect(screen.getByText('补全工作流')).toBeTruthy();
    expect(screen.getByText('第一轮需求')).toBeTruthy();
  });

  it('lazily creates a conversation on the first turn and passes the identity to the compiler instead of double-persisting', async () => {
    const metis = installMetis({ createResult: { id: 'conv-lazy', title: '', createdAt: 5 } });
    metis.compileScenarioHarness.mockResolvedValue({ ok: true, scenario: scenario(), summary: '已生成连续 Workflow。' });
    const appendSpy = vi.fn();
    (metis as unknown as Record<string, unknown>).scenarioConversationAppend = appendSpy;
    const { current } = await renderWorkbench();

    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '请设计完整 Workflow。' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    await waitFor(() => expect(metis.compileScenarioHarness).toHaveBeenCalledTimes(1));
    expect(metis.compileScenarioHarness).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      scenarioId: current.id,
      conversationId: 'conv-lazy',
    }));
    // 主进程在成功后负责落库 user+assistant；渲染端不得重复追加。
    await waitFor(() => expect(metis.scenarioConversationMessages).toHaveBeenCalledWith({ projectId: 'project-1', conversationId: 'conv-lazy' }));
    expect(appendSpy).not.toHaveBeenCalled();
    // 2026-08-23 刘总要求：编译成功后自动保存，通知包含摘要与自动保存标记。
    expect(await screen.findByText(/已生成连续 Workflow。；已自动保存。/u)).toBeTruthy();
  });

  it('keeps an unpersisted first instruction visible with an honest failure notice when compilation fails', async () => {
    const metis = installMetis({ createResult: { id: 'conv-fail', title: '', createdAt: 5 } });
    metis.compileScenarioHarness.mockResolvedValue({ ok: false, code: 'generation_failed', message: '模型未返回场景' });
    await renderWorkbench();

    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '这条会失败的要求' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    await waitFor(() => expect(metis.compileScenarioHarness).toHaveBeenCalled());
    // 失败不落库：数据库查询应返回空；本地保留指令并如实显示失败原因。
    expect((await screen.findAllByText(/AI 未生成可用的场景内容/u)).length).toBeGreaterThan(0);
    expect(screen.getByText('这条会失败的要求')).toBeTruthy();
  });

  it('creates a new conversation from the drawer and deletes conversations through the real bridges', async () => {
    const metis = installMetis({
      units: [{ id: 'conv-a', title: '已有对话', messageCount: 1, createdAt: 1, updatedAt: 2 }],
      messagesByConversation: { 'conv-a': [{ id: 'ma1', role: 'assistant', content: '历史回复。', sources: [], createdAt: 2 }] },
    });
    await renderWorkbench();
    await screen.findByText('历史回复。');

    fireEvent.click(screen.getByTestId('sw-assistant-history-toggle'));
    fireEvent.click(screen.getByTestId('sw-assistant-new-conversation'));
    await waitFor(() => expect(metis.scenarioConversationCreate).toHaveBeenCalledWith({ projectId: 'project-1', scenarioId: 'user:scenario/research-paper' }));
    // 新建后回到空会话（仅问候语）。
    await waitFor(() => expect(screen.queryByText('历史回复。')).toBeNull());

    // 载入旧对话。
    fireEvent.click(screen.getByRole('button', { name: '载入对话 已有对话' }));
    await screen.findByText('历史回复。');

    // 删除当前载入的旧对话：调用真实删除桥并清空视图。
    fireEvent.click(screen.getByRole('button', { name: '删除对话 已有对话' }));
    await waitFor(() => expect(metis.scenarioConversationDelete).toHaveBeenCalledWith({ projectId: 'project-1', conversationId: 'conv-a' }));
    await waitFor(() => expect(screen.queryByText('历史回复。')).toBeNull());
  });

  it('falls back to the in-memory assistant without history controls when no project context is available', async () => {
    const compiled = scenario({ name: 'AI 实证论文' });
    const compileScenarioHarness = vi.fn().mockResolvedValue({ ok: true, scenario: compiled, summary: '已更新草稿。' });
    window.metis = { compileScenarioHarness } as unknown as typeof window.metis;
    const { current } = await renderWorkbench({ projectId: null });

    // 入口始终可见且可点（2026-08-24 刘总反馈）：无项目上下文时点击弹出说明抽屉，而不是无响应。
    const toggle = screen.getByTestId('sw-assistant-history-toggle');
    expect(toggle).toHaveProperty('disabled', false);
    expect(screen.getByText('历史记录')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('sw-assistant-drawer')).toBeTruthy());
    expect(screen.getByText(/对话历史按项目保存/u)).toBeTruthy();
    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '无项目上下文的请求' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));
    await waitFor(() => expect(compileScenarioHarness).toHaveBeenCalledWith(expect.not.objectContaining({ projectId: expect.anything() })));
    expect((await screen.findAllByText(/已更新草稿。；已自动保存。/u)).length).toBeGreaterThan(0);
    void current;
  });

  it('keeps the history toggle clickable while a compile run is still in flight', async () => {
    // 2026-08-24 刘总反馈：编译可能持续数分钟，期间「历史记录」必须仍可打开（只读查看）。
    const metis = installMetis({
      units: [{ id: 'conv-a', title: '已有对话', messageCount: 1, createdAt: 1, updatedAt: 2 }],
      messagesByConversation: { 'conv-a': [{ id: 'ma1', role: 'assistant', content: '历史回复。', sources: [], createdAt: 2 }] },
      createResult: { id: 'conv-busy', title: '', createdAt: 5 },
    });
    let resolveCompile: ((value: unknown) => void) | null = null;
    metis.compileScenarioHarness.mockImplementation(() => new Promise((resolve) => { resolveCompile = resolve; }));
    await renderWorkbench();

    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '长时间编译的请求' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));
    await waitFor(() => expect(metis.compileScenarioHarness).toHaveBeenCalled());

    const toggle = screen.getByTestId('sw-assistant-history-toggle');
    expect(toggle).toHaveProperty('disabled', false);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('sw-assistant-drawer')).toBeTruthy());
    expect(screen.getByText('已有对话')).toBeTruthy();

    resolveCompile?.({ ok: true, scenario: scenario(), summary: '完成。' });
  });
});
