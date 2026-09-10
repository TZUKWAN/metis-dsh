/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedPersonalizationDefinition, PersonalizationDefinition, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

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
    triggerPhrases: ['写一篇实证论文'],
    capability: 'research',
    deliverable: {
      type: 'empirical_paper', language: 'zh', globalLength: '12000 字', secondarySections: { min: 2, max: 4 },
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      globalInstructions: '全文学术化表达，术语前后一致，各章形成连续论证。',
      sections: [{
        id: 'chapter-1', title: '研究设计', kind: 'chapter', status: 'required',
        purpose: '交代研究设计整体思路。', instructions: '先说明研究策略，再展开数据与测量。', requirements: ['说明研究策略'], lengthTarget: '3000字',
        children: [{
          id: 'section-1', title: '研究问题', kind: 'section', status: 'required',
          purpose: '提出核心研究问题。', instructions: '以一个主问题带子问题的形式陈述。', requirements: ['陈述核心问题'], lengthTarget: '500字',
        }],
      }],
    },
    ...overrides,
  } as ScenarioDefinition;
}

function definition(kind: 'skill' | 'mcp', id: string, name: string): PersonalizationDefinition {
  return {
    contractVersion: 1, id, kind, name, description: '', enabled: true, tags: [], revision: 1,
    provenance: { origin: 'user', author: 'test', version: '1.0.0', license: null, sourceUrl: null, sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null, locallyModified: true, createdAt: 1, updatedAt: 1 },
    ...(kind === 'skill'
      ? { sourceMode: 'markdown', markdown: '# Skill', systemPrompt: '', toolIds: [], mcpIds: [], maxTurns: 10, inputSchema: null, outputSchema: null, packageEntry: null }
      : { sourceMode: 'generated', transport: 'stdio', command: 'node', args: [], environment: {}, sourceUrl: null, exposedTools: [], workingDirectoryToken: null }),
  } as PersonalizationDefinition;
}

function harness(overrides: Partial<Parameters<typeof import('../../src/personalization/ScenarioWorkbench.js').default>[0]> = {}) {
  const current = scenario();
  const save = vi.fn().mockImplementation(async (raw: PersonalizationDefinition) => ({
    ok: true,
    definition: { ...raw, revision: raw.revision + 1 },
  }));
  const props = {
    zh: true,
    definitions: [current] as PersonalizationDefinition[],
    selectedId: current.id,
    onSelect: vi.fn(),
    save,
    createScenario: vi.fn(),
    onActivateScenario: vi.fn(),
    onDeleteScenario: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { current, props, save };
}

async function renderWorkbench(props: ReturnType<typeof harness>['props']) {
  const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
  return render(<ScenarioWorkbench {...props} />);
}

describe('ScenarioWorkbench focused authoring', () => {
  beforeEach(async () => {
    window.metis = undefined;
    const mod = await import('../../src/personalization/ScenarioWorkbench.js');
    mod.resetScenarioWorkbenchDraftStoreForTests();
  });

  it('renders exactly the four requested authoring sections and no advanced runtime controls', async () => {
    const { props } = harness();
    await renderWorkbench(props);

    for (const id of ['sw-page-basics', 'sw-page-structure', 'sw-page-capability', 'sw-page-rules']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.queryByTestId('sw-page-adapt')).toBeNull();
    expect(screen.queryByText('Hook')).toBeNull();
    expect(screen.queryByText('Checkpoint')).toBeNull();
    expect(screen.queryByText('失败策略')).toBeNull();
    expect(screen.getByTestId('sw-configuration-assistant')).toBeTruthy();
    expect(screen.queryByTestId('sw-ai-generate-structure')).toBeNull();
    expect(screen.queryByTestId('sw-ai-design-workflow')).toBeNull();
    expect(screen.queryByTestId('sw-ai-optimize-metis')).toBeNull();
  });

  it('edits the basic and deliverable constraints, then saves a real output plan', async () => {
    const { props, save } = harness();
    await renderWorkbench(props);
    fireEvent.change(screen.getByTestId('sw-config-name'), { target: { value: '政策报告' } });
    fireEvent.change(screen.getByTestId('sw-config-length'), { target: { value: '8000 字' } });
    fireEvent.change(screen.getByTestId('sw-chapter-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.name).toBe('政策报告');
    expect(saved.deliverable?.globalLength).toBe('8000 字');
    expect(saved.deliverable?.sections?.filter((item) => item.kind === 'chapter')).toHaveLength(2);
    expect(saved.output.plan?.primaryDeliverable).toBe('实证论文');
  });

  it('keeps list, category management, definition, and assistant on one page and persists the selected scene category', async () => {
    const { props, save } = harness();
    await renderWorkbench(props);
    expect(screen.getByTestId('sw-scenario-library')).toBeTruthy();
    expect(screen.getByTestId('sw-focused-editor')).toBeTruthy();
    expect(screen.getByTestId('sw-configuration-assistant')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('当前场景分类'), { target: { value: '论文写作' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.tags).toContain('category:论文写作');
  });

  it('deletes a scenario directly from the left scene list', async () => {
    const onDeleteScenario = vi.fn().mockResolvedValue({ ok: true });
    const { current, props } = harness({ onDeleteScenario });
    await renderWorkbench(props);
    fireEvent.click(screen.getByLabelText(`删除场景 ${current.name}`));
    await waitFor(() => expect(onDeleteScenario).toHaveBeenCalledWith(current.id));
  });

  it('shows a recoverable seven-day trash and restores the archived scene from the same three-column page', async () => {
    const onRestoreScenario = vi.fn().mockResolvedValue({ ok: true, message: '已恢复到场景列表。' });
    const current = scenario();
    const { props } = harness({
      definitions: [],
      selectedId: null,
      archivedScenarios: [{
        definition: current,
        archivedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }] satisfies ArchivedPersonalizationDefinition[],
      onRestoreScenario,
    });
    await renderWorkbench(props);
    fireEvent.click(screen.getByTestId('sw-trash-toggle'));
    expect(screen.getByTestId('sw-trash-panel')).toBeTruthy();
    expect(screen.getByText(/剩余 7 天后永久删除/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `恢复场景 ${current.name}` }));
    await waitFor(() => expect(onRestoreScenario).toHaveBeenCalledWith(current.id));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(current.id));
  });

  it('creates nested steps and persists a single continuous execution order', async () => {
    const { props, save } = harness();
    await renderWorkbench(props);
    fireEvent.click(screen.getByTestId('sw-add-substep-outline'));
    const prompts = screen.getAllByTestId('sw-step-prompt');
    const criteria = screen.getAllByTestId('sw-step-criteria');
    fireEvent.change(prompts[1]!, { target: { value: '基于提纲形成研究设计。' } });
    fireEvent.change(criteria[1]!, { target: { value: '研究设计可直接写入交付物。' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.workflow).toHaveLength(2);
    expect(saved.workflow[0]?.dependsOn).toEqual([]);
    expect(saved.workflow[1]?.dependsOn).toEqual(['outline']);
    expect(saved.workflow[1]?.parentStepId).toBe('outline');
  });

  it('uses prompt and completion criteria as a real start gate, then saves before activation', async () => {
    const incomplete = scenario({ workflow: [{ ...scenario().workflow[0]!, prompt: '', completionCriteria: [] }] });
    const onActivateScenario = vi.fn();
    const { props, save } = harness({ definitions: [incomplete], selectedId: incomplete.id, onActivateScenario });
    await renderWorkbench(props);
    fireEvent.click(screen.getByTestId('sw-use'));
    expect(onActivateScenario).not.toHaveBeenCalled();
    expect(screen.getByText(/尚不能启动/u)).toBeTruthy();

    fireEvent.change(screen.getByTestId('sw-step-prompt'), { target: { value: '完成研究提纲。' } });
    fireEvent.change(screen.getByTestId('sw-step-criteria'), { target: { value: '提纲覆盖全部章节。' } });
    fireEvent.click(screen.getByTestId('sw-use'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onActivateScenario).toHaveBeenCalledWith(incomplete.id));
  });

  it('uses the single conversation assistant to call the real compiler bridge, apply its returned Scenario draft, and undo it', async () => {
    const { current, props } = harness();
    const compiled = scenario({ name: 'AI 实证论文', workflowPrompt: '每一步接收前一步成果并通过标准后再继续。' });
    const compileScenarioHarness = vi.fn().mockResolvedValue({ ok: true, scenario: compiled, summary: '已生成连续 Workflow。' });
    window.metis = { compileScenarioHarness } as unknown as typeof window.metis;
    await renderWorkbench(props);
    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '请设计完整的连续 Workflow。' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    await waitFor(() => expect(compileScenarioHarness).toHaveBeenCalledWith(expect.objectContaining({
      current: expect.objectContaining({ id: current.id }),
      materialIds: [],
    })));
    expect(await screen.findByDisplayValue(compiled.workflowPrompt!)).toBeTruthy();
    expect(screen.getAllByText('已生成连续 Workflow。').length).toBeGreaterThan(0);
    expect(screen.getByTestId('sw-assistant-undo')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByTestId('sw-assistant-undo'));
    expect(screen.getByTestId('sw-config-name')).toHaveProperty('value', current.name);
  });

  it('does not report an AI compilation as saved when the trusted main-process commit fails', async () => {
    const { props, save } = harness();
    const compiled = scenario({ name: '仅内存草稿' });
    const compileScenarioHarness = vi.fn().mockResolvedValue({
      ok: false,
      code: 'revision_conflict',
      message: '场景内容已生成，但未能安全保存（revision_conflict）。当前草稿仍在页面中，请重试保存。',
      scenario: compiled,
    });
    window.metis = { compileScenarioHarness } as unknown as typeof window.metis;
    await renderWorkbench(props);
    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '生成一个场景。' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    expect((await screen.findAllByText(/未能安全保存/u)).length).toBeGreaterThan(0);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryAllByText(/已自动保存/u)).toHaveLength(0);
  });

  it('retains generated content as an unsaved draft when trusted autosave fails, then preserves it for safe save-as-new on conflict', async () => {
    const { props, save } = harness();
    const compiled = scenario({
      name: 'AI 实证论文（待保存）',
      workflowPrompt: '按连续工作流逐步完成实证研究。',
    });
    const compileScenarioHarness = vi.fn().mockResolvedValue({
      ok: false,
      code: 'revision_conflict',
      message: '场景内容已生成，但未能安全保存（revision_conflict）。当前草稿仍在页面中，请重试保存。',
      scenario: compiled,
    });
    window.metis = { compileScenarioHarness } as unknown as typeof window.metis;
    await renderWorkbench(props);
    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '根据材料完善连续 Workflow。' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    expect(await screen.findByDisplayValue(compiled.workflowPrompt!)).toBeTruthy();
    expect(screen.getAllByText(/已保留为未保存草稿/u).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('已自动保存。')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();

    expect(screen.getByText('保存')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('sw-save-as-new'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.name).toBe(`${compiled.name} 副本`);
    expect(saved.id).toMatch(/^user:scenarios\//u);
    expect(save.mock.calls[0]![1]).toBe(0);
  });

  it('locks every focused-editor mutation control while compilation is in flight', async () => {
    const { props } = harness();
    let resolveCompile: ((value: unknown) => void) | undefined;
    const compileScenarioHarness = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCompile = resolve;
    }));
    window.metis = { compileScenarioHarness } as unknown as typeof window.metis;
    await renderWorkbench(props);
    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: '生成连续 Workflow。' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    await waitFor(() => expect(compileScenarioHarness).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('sw-config-name')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sw-workflow-prompt')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sw-step-prompt')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sw-workflow-add')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sw-assistant-upload')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: props.definitions[0]!.name })).toHaveProperty('disabled', true);

    resolveCompile?.({ ok: false, code: 'generation_failed' });
    await waitFor(() => expect(screen.getByTestId('sw-config-name')).toHaveProperty('disabled', false));
  });

  it('exposes local, URL, and online discovery per step and opens the real local MCP importer', async () => {
    const { props } = harness();
    await renderWorkbench(props);
    for (const id of ['sw-step-import-package-outline', 'sw-step-url-skill-outline', 'sw-step-search-skill-outline', 'sw-step-import-mcp-outline', 'sw-step-url-mcp-outline', 'sw-step-search-mcp-outline']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('sw-step-import-mcp-outline'));
    expect(await screen.findByText('选择本地 MCP 包文件夹')).toBeTruthy();
    expect(screen.getByText(/manifest\.json/u)).toBeTruthy();
  });

  it('binds installed Skill and MCP only to the selected step and rolls them up for resolution', async () => {
    const current = scenario();
    const skill = definition('skill', 'user:skills/outline', '提纲 Skill');
    const mcp = definition('mcp', 'user:mcp/citations', '引文 MCP');
    const { props, save } = harness({ definitions: [current, skill, mcp], selectedId: current.id });
    await renderWorkbench(props);
    fireEvent.change(screen.getByTestId('sw-step-pick-skill-outline'), { target: { value: 'user:skills/outline' } });
    fireEvent.change(screen.getByTestId('sw-step-pick-mcp-outline'), { target: { value: 'user:mcp/citations' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0] as ScenarioDefinition;
    expect(saved.workflow[0]?.skillIds).toEqual(['user:skills/outline']);
    expect(saved.workflow[0]?.mcpIds).toEqual(['user:mcp/citations']);
    expect(saved.skillIds).toEqual(['user:skills/outline']);
    expect(saved.mcpIds).toEqual(['user:mcp/citations']);
  });

  it('keeps the zero-selection state actionable without creating a placeholder scenario', async () => {
    const { current, props } = harness({ selectedId: null });
    await renderWorkbench(props);
    expect(screen.getByTestId('sw-empty')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: current.name }));
    expect(props.onSelect).toHaveBeenCalledWith(current.id);
    fireEvent.click(screen.getByTestId('sw-new-scenario'));
    expect(props.createScenario).toHaveBeenCalledTimes(1);
  });
});
