/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { ArchivedPersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useMetisStore } from '../../src/store.js';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import PersonalizationCenter from '../../src/personalization/PersonalizationCenter.js';

const builtin = buildBuiltinPersonalizationDefinitions();
const PENDING_MCP_INSTALLATION = `mcp_${'c'.repeat(32)}`;

function editableUserDefinition<T extends PersonalizationDefinition>(
  source: T,
  id: string,
  name: string,
): T {
  return {
    ...structuredClone(source),
    id,
    name,
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
  } as T;
}

function pendingUrlMcp(): Extract<PersonalizationDefinition, { kind: 'mcp' }> {
  return {
    contractVersion: 1,
    id: 'url:mcp/center-activation',
    kind: 'mcp',
    name: 'Pending URL MCP',
    description: 'Installed and awaiting a controlled list-only probe.',
    enabled: false,
    tags: ['url', 'pending-probe'],
    revision: 1,
    provenance: {
      origin: 'url',
      author: 'External MCP package',
      version: '1.0.0',
      license: null,
      sourceUrl: 'https://packages.example.org/mcp/manifest.json',
      sourceRevision: PENDING_MCP_INSTALLATION,
      installedDigest: 'c'.repeat(64),
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 10,
      updatedAt: 10,
    },
    sourceMode: 'url',
    transport: 'stdio',
    command: 'metis-managed-mcp',
    args: [PENDING_MCP_INSTALLATION],
    environment: {},
    sourceUrl: 'https://packages.example.org/mcp/manifest.json',
    exposedTools: [],
    workingDirectoryToken: PENDING_MCP_INSTALLATION,
  };
}
let definitions: PersonalizationDefinition[];
let archivedScenarios: ArchivedPersonalizationDefinition[];
let listPersonalization: ReturnType<typeof vi.fn>;
let listPersonalizationTrash: ReturnType<typeof vi.fn>;
let savePersonalization: ReturnType<typeof vi.fn>;
let forkPersonalization: ReturnType<typeof vi.fn>;
let archivePersonalization: ReturnType<typeof vi.fn>;
let deletePersonalization: ReturnType<typeof vi.fn>;
let restorePersonalizationFromTrash: ReturnType<typeof vi.fn>;
let applyPersonalizationExtension: ReturnType<typeof vi.fn>;
let selectFileCapability: ReturnType<typeof vi.fn>;
let exportPersonalizationBundle: ReturnType<typeof vi.fn>;
let importPersonalizationBundle: ReturnType<typeof vi.fn>;
let listPersonalizationSecrets: ReturnType<typeof vi.fn>;
let setPersonalizationSecret: ReturnType<typeof vi.fn>;
let removePersonalizationSecret: ReturnType<typeof vi.fn>;
let fundingTemplate: ReturnType<typeof vi.fn>;
let activatePersonalizationMcp: ReturnType<typeof vi.fn>;
let getWorkspaceAgents: ReturnType<typeof vi.fn>;
let setWorkspaceAgents: ReturnType<typeof vi.fn>;
let compileScenarioHarness: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useMetisStore.setState({ locale: 'en' });
  researchWorkspaceStore.setState({ activeProjectId: null });
  definitions = structuredClone(builtin);
  archivedScenarios = [];
  listPersonalization = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions: [...definitions] }));
  listPersonalizationTrash = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions: [...archivedScenarios] }));
  savePersonalization = vi.fn().mockImplementation((request: { definition: PersonalizationDefinition }) => {
    const existing = definitions.findIndex((item) => item.id === request.definition.id);
    if (existing >= 0) definitions[existing] = request.definition;
    else definitions.push(request.definition);
    return Promise.resolve({ ok: true, code: 'saved', definition: request.definition });
  });
  forkPersonalization = vi.fn().mockImplementation((request: { sourceId: string; targetId: string }) => {
    const source = definitions.find((item) => item.id === request.sourceId)!;
    const copy = {
      ...structuredClone(source),
      id: request.targetId,
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', locallyModified: true, parentId: source.id },
    } as PersonalizationDefinition;
    definitions.push(copy);
    return Promise.resolve({ ok: true, code: 'saved', definition: copy });
  });
  archivePersonalization = vi.fn().mockResolvedValue({ ok: true, code: 'deleted', id: 'user:x' });
  deletePersonalization = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, code: 'deleted', id: 'user:x' }));
  restorePersonalizationFromTrash = vi.fn().mockImplementation((request: { id: string }) => {
    const index = archivedScenarios.findIndex((item) => item.definition.id === request.id);
    const item = index >= 0 ? archivedScenarios[index] : undefined;
    if (!item) return Promise.resolve({ ok: false, code: 'not_found' });
    archivedScenarios.splice(index, 1);
    definitions.push(item.definition);
    return Promise.resolve({ ok: true, code: 'restored', definition: item.definition });
  });
  applyPersonalizationExtension = vi.fn().mockImplementation((request: {
    id: string; name?: string; description?: string; markdown?: string; inputSchema?: unknown; outputSchema?: unknown;
  }) => {
    // 与 savePersonalization 等价的合并语义：技能保存走签名扩展通道，返回 revision+1 的完整定义。
    const index = definitions.findIndex((item) => item.id === request.id);
    const base = index >= 0 ? structuredClone(definitions[index]!) : undefined;
    if (!base || base.kind !== 'skill') return Promise.resolve({ ok: false, code: 'not_found' });
    const definition = {
      ...base,
      name: request.name ?? base.name,
      description: request.description ?? base.description,
      markdown: request.markdown ?? base.markdown,
      inputSchema: request.inputSchema !== undefined ? request.inputSchema : base.inputSchema,
      outputSchema: request.outputSchema !== undefined ? request.outputSchema : base.outputSchema,
      revision: base.revision + 1,
    } as PersonalizationDefinition;
    definitions[index] = definition;
    return Promise.resolve({ ok: true, code: 'saved', definition });
  });
  selectFileCapability = vi.fn().mockResolvedValue({
    success: true,
    capability: {
      capabilityId: 'fc_personalizationskillpackage_123456789012345678',
      kind: 'file',
      mime: 'application/zip',
      displayName: 'review-skill.zip',
      operations: ['file'],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  });
  exportPersonalizationBundle = vi.fn().mockResolvedValue({
    ok: true,
    operationId: '11111111-1111-4111-8111-111111111111',
    action: 'exported',
    bundleDigest: 'a'.repeat(64),
    definitionCount: 2,
  });
  importPersonalizationBundle = vi.fn().mockResolvedValue({
    ok: true,
    operationId: '22222222-2222-4222-8222-222222222222',
    action: 'imported',
    bundleDigest: 'b'.repeat(64),
    definitionCount: 2,
  });
  listPersonalizationSecrets = vi.fn().mockResolvedValue({
    ok: true,
    contractVersion: 1,
    operationId: '33333333-3333-4333-8333-333333333333',
    revision: 0,
    secrets: [],
  });
  setPersonalizationSecret = vi.fn().mockResolvedValue({
    ok: true,
    contractVersion: 1,
    operationId: '44444444-4444-4444-8444-444444444444',
    revision: 1,
    secret: { name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 },
  });
  removePersonalizationSecret = vi.fn().mockResolvedValue({
    ok: true,
    contractVersion: 1,
    operationId: '55555555-5555-4555-8555-555555555555',
    revision: 2,
    removed: true,
    name: 'ZOTERO_API_KEY',
  });
  fundingTemplate = vi.fn().mockImplementation((request: { action: string; operationId: string; projectId: string }) => Promise.resolve({
    ok: true,
    contractVersion: 1,
    operationId: request.operationId,
    action: request.action,
    ownerId: 'local-user',
    projectId: request.projectId,
    templates: [],
  }));
  activatePersonalizationMcp = vi.fn();
  getWorkspaceAgents = vi.fn().mockImplementation((projectId: string) => Promise.resolve({
    exists: true,
    content: `# ${projectId} Metis.md\n`,
    version: 2,
    contentHash: 'project-rules-digest',
    projectId,
  }));
  compileScenarioHarness = vi.fn().mockResolvedValue({ ok: false, code: 'not_configured' });
  setWorkspaceAgents = vi.fn().mockResolvedValue({
    success: true,
    code: 'saved',
    version: 3,
    contentHash: 'saved-project-rules-digest',
  });
  Object.defineProperty(window, 'metis', {
    configurable: true,
    writable: true,
    value: {
      listPersonalization,
      listPersonalizationTrash,
      savePersonalization,
      forkPersonalization,
      archivePersonalization,
      deletePersonalization,
      restorePersonalizationFromTrash,
      applyPersonalizationExtension,
      selectFileCapability,
      exportPersonalizationBundle,
      importPersonalizationBundle,
      listPersonalizationSecrets,
      setPersonalizationSecret,
      removePersonalizationSecret,
      fundingTemplate,
      activatePersonalizationMcp,
      getWorkspaceAgents,
      setWorkspaceAgents,
      compileScenarioHarness,
      capabilityVaultSources: vi.fn().mockResolvedValue({ ok: true, sources: [] }),
      capabilityVaultStats: vi.fn().mockResolvedValue({ ok: true, stats: { total: 0, skills: 0, mcps: 0, installed: 0, sources: 0 } }),
      capabilityVaultImportSource: vi.fn().mockResolvedValue({ ok: false, imported: 0, excluded: 0 }),
      capabilityVaultList: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
      capabilityVaultGetDetail: vi.fn().mockResolvedValue({ ok: false }),
      capabilityVaultInstall: vi.fn().mockResolvedValue({ ok: false, code: 'install_failed' }),
      capabilityVaultUninstall: vi.fn().mockResolvedValue({ ok: false }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

async function selectScenarioInWorkbench(name: string | RegExp) {
  // 一级工作台固定为「场景列表 + 定义 + 配置助手」；选择只发生在左侧列表。
  const library = await screen.findByTestId('sw-scenario-library');
  fireEvent.click(within(library).getByRole('button', { name }));
  // Selection synchronizes through the workbench draft effect.  Wait for the
  // actual editor value so following interactions cannot target the old draft.
  await waitFor(() => {
    const value = (screen.getByTestId('sw-config-name') as HTMLInputElement).value;
    expect(typeof name === 'string' ? value === name : name.test(value)).toBe(true);
  });
}

function runnableScenario(id: string, name: string): Extract<PersonalizationDefinition, { kind: 'scenario' }> {
  const source = builtin.find((item): item is Extract<PersonalizationDefinition, { kind: 'scenario' }> => item.kind === 'scenario')!;
  return {
    ...editableUserDefinition(source, id, name),
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    workflowPrompt: 'Pass each completed artifact to the next step and continue only when the criterion is met.',
    deliverable: {
      type: 'survey_report',
      typeLabel: 'Research report',
      globalInstructions: 'Academic register throughout; keep terminology consistent and arguments continuous.',
      sections: [{
        id: 'final-report', title: 'Final report', kind: 'chapter', status: 'required',
        purpose: 'Deliver the full research report.', instructions: 'Organize by research question with evidence-linked sections.', requirements: ['Answer the research question'], lengthTarget: '8000 words',
      }],
    },
    workflow: [{
      id: 'compose-report',
      name: 'Compose report',
      description: 'Produce the requested report from the accumulated artifacts.',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 12,
      prompt: 'Write the report from the preceding context and artifact handoff.',
      completionCriteria: ['The final report is complete and traceable.'],
    }],
  };
}

describe('PersonalizationCenter', () => {
  it('场景中心不再提供 Metis.md 标签页入口（底层项目 Metis.md 功能保留）', async () => {
    researchWorkspaceStore.setState({ activeProjectId: 'project-background' });
    render(<PersonalizationCenter />);

    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByTestId('scenario-workbench')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Metis\.md/u })).toBeNull();
    expect(getWorkspaceAgents).not.toHaveBeenCalled();
  });

  it('starts with an empty user library even when legacy factory definitions are returned', async () => {
    render(<PersonalizationCenter />);
    expect(await screen.findByTestId('sw-empty')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Start with a scenario' })).toBeDefined();
    expect(screen.queryByText('General research')).toBeNull();
    expect(screen.queryByText('Academic monograph')).toBeNull();
    expect(screen.getByRole('button', { name: /Scenarios/u }).textContent).toContain('0');
    expect(screen.getByTestId('scenario-workbench')).toBeDefined();
    expect(screen.getByTestId('sw-scenario-library')).toBeDefined();
    expect(listPersonalization).toHaveBeenCalledWith({ contractVersion: 1, includeDisabled: true });
  });

  it('loads the persisted scene trash and restores an archived scenario through the real bridge request', async () => {
    const source = builtin.find((definition) => definition.kind === 'scenario')!;
    const archived = editableUserDefinition(source, 'user:scenarios/recoverable-trash', 'Recoverable scenario');
    archivedScenarios = [{
      definition: archived,
      archivedAt: 1_785_394_400_000,
      expiresAt: 1_786_000_000_000,
    }];

    render(<PersonalizationCenter />);
    const library = await screen.findByTestId('sw-scenario-library');
    fireEvent.click(within(library).getByTestId('sw-trash-toggle'));
    expect(await screen.findByTestId('sw-trash-panel')).toBeDefined();
    fireEvent.click(within(library).getByRole('button', { name: 'Restore scenario Recoverable scenario' }));

    await waitFor(() => expect(restorePersonalizationFromTrash).toHaveBeenCalledWith({
      contractVersion: 1,
      id: archived.id,
      expectedRevision: archived.revision,
    }));
    await waitFor(() => expect(listPersonalizationTrash).toHaveBeenCalledWith({ contractVersion: 1 }));
    expect(await screen.findByDisplayValue('Recoverable scenario')).toBeDefined();
  });

  it('shows archived skills in the library trash and restores them through the real bridge request', async () => {
    const source = builtin.find((definition) => definition.kind === 'skill')!;
    const archivedSkill = editableUserDefinition(source, 'user:skills/recoverable-trash', 'Recoverable skill');
    archivedScenarios = [{
      definition: archivedSkill,
      archivedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
    }];

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByTestId('personalization-library-trash-toggle'));
    expect(await screen.findByTestId('personalization-trash-item-0')).toBeDefined();
    const trashCard = screen.getByTestId('personalization-trash-item-0').closest('article') as HTMLElement;
    fireEvent.click(within(trashCard).getByRole('button', { name: /Restore/ }));

    await waitFor(() => expect(restorePersonalizationFromTrash).toHaveBeenCalledWith({
      contractVersion: 1,
      id: archivedSkill.id,
      expectedRevision: archivedSkill.revision,
    }));
    await waitFor(() => expect(restorePersonalizationFromTrash.mock.calls[0]?.[0]).toMatchObject({ id: archivedSkill.id }));
  });

  it('purges an archived skill from the library trash only after the two-step confirmation', async () => {
    const source = builtin.find((definition) => definition.kind === 'skill')!;
    const archivedSkill = editableUserDefinition(source, 'user:skills/purgeable-trash', 'Purgeable skill');
    archivedScenarios = [{
      definition: archivedSkill,
      archivedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
    }];

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByTestId('personalization-library-trash-toggle'));
    const trashCard = (await screen.findByTestId('personalization-trash-item-0')).closest('article') as HTMLElement;
    fireEvent.click(within(trashCard).getByRole('button', { name: /Purge/ }));
    expect(deletePersonalization).not.toHaveBeenCalled();
    fireEvent.click(within(trashCard).getByRole('button', { name: 'Confirm purge' }));

    await waitFor(() => expect(deletePersonalization).toHaveBeenCalledWith({
      contractVersion: 1,
      id: archivedSkill.id,
      expectedRevision: archivedSkill.revision,
    }));
  });

  it('creates a strict Markdown skill for a beginner', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalled());
    const request = savePersonalization.mock.calls[0]![0] as { expectedRevision: number; definition: PersonalizationDefinition };
    expect(request.expectedRevision).toBe(0);
    expect(request.definition.kind).toBe('skill');
    expect(request.definition.id).toMatch(/^user:skills\//u);
    if (request.definition.kind === 'skill') expect(request.definition.sourceMode).toBe('markdown');
  });

  it('does not expose factory-copy actions in the zero-preset product', async () => {
    render(<PersonalizationCenter />);
    await screen.findByTestId('sw-empty');
    expect(screen.queryByRole('button', { name: 'Create editable copy' })).toBeNull();
    expect(forkPersonalization).not.toHaveBeenCalled();
  });

  it('preserves independent drafts across card switches, category switches, and remounts', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const first = editableUserDefinition(source, 'user:skills/draft-one', 'Draft one agent');
    const second = editableUserDefinition(source, 'user:skills/draft-two', 'Draft two agent');
    definitions.push(first, second);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.name })));

    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'First retained draft' },
    });
    expect(await screen.findByText('Draft preserved automatically')).toBeDefined();
    expect(within(document.querySelector(`[data-definition-id="${first.id}"]`)!.closest('.personalization-card') as HTMLElement).getByText('Draft preserved')).toBeDefined();

    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: second.name })));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Second retained draft' },
    });
    expect(await screen.findByText('Draft preserved automatically')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Scenarios/ }));
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('First retained draft')).toBeDefined();
    expect(screen.getByText('Preserved draft restored')).toBeDefined();

    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('Second retained draft')).toBeDefined();

    view.unmount();
    expect([...Array(window.localStorage.length)].map((_item, index) => window.localStorage.key(index)))
      .toContain(`metis:personalization-draft:v1:${first.id}`);
    window.sessionStorage.clear();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('First retained draft')).toBeDefined();
    expect(screen.getByText('Preserved draft restored')).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.name })));
  });

  it('restores a valid in-progress draft even when a required field is temporarily blank', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const custom = editableUserDefinition(source, 'user:skills/in-progress-blank-name', 'Blank-name draft');
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: '' } });
    expect(name).toHaveProperty('value', '');
    view.unmount();

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveProperty('value', '');
    expect(screen.getByText('Preserved draft restored')).toBeDefined();
  });

  it('debounces durable draft writes and flushes the latest value across rapid navigation and unmount', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const first = editableUserDefinition(source, 'user:skills/debounce-one', 'Debounce one');
    const second = editableUserDefinition(source, 'user:skills/debounce-two', 'Debounce two');
    definitions.push(first, second);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.name })));

    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'd' } });
    fireEvent.change(description, { target: { value: 'de' } });
    fireEvent.change(description, { target: { value: 'debounced latest' } });
    expect(setItem).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(199); });
    expect(setItem).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${first.id}`)!).draft.description)
      .toBe('debounced latest');

    setItem.mockClear();
    fireEvent.change(description, { target: { value: 'flushed on card switch' } });
    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${first.id}`)!).draft.description)
      .toBe('flushed on card switch');

    setItem.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'flushed on category switch' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Scenarios/ }));
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${second.id}`)!).draft.description)
      .toBe('flushed on category switch');

    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    setItem.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'flushed on center unmount' },
    });
    view.unmount();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem(`metis:personalization-draft:v1:${first.id}`)!).draft.description)
      .toBe('flushed on center unmount');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('rebases edits made while an earlier save is pending instead of clearing the newer draft', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const custom = editableUserDefinition(source, 'user:skills/pending-save', 'Pending save skill');
    definitions.push(custom);
    let resolveSave: ((result: {
      ok: true;
      code: 'saved';
      definition: PersonalizationDefinition;
    }) => void) | undefined;
    // 技能保存走签名扩展通道（applyPersonalizationExtension），而非直接 savePersonalization。
    applyPersonalizationExtension.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const description = await screen.findByRole('textbox', { name: 'Description' });
    vi.useFakeTimers();
    fireEvent.change(description, { target: { value: 'Submitted revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1);
    fireEvent.change(description, { target: { value: 'Edited while save was pending' } });
    expect(screen.getByText('Draft preserved automatically')).toBeDefined();

    const savedDefinition = {
      ...structuredClone(custom),
      description: 'Submitted revision',
      revision: custom.revision + 1,
    } as PersonalizationDefinition;
    definitions = definitions.map((definition) => definition.id === custom.id ? savedDefinition : definition);
    await act(async () => {
      resolveSave?.({ ok: true, code: 'saved', definition: savedDefinition });
      await Promise.resolve();
    });
    vi.useRealTimers();

    expect(await screen.findByDisplayValue('Edited while save was pending')).toBeDefined();
    expect(await screen.findByText('Preserved draft restored')).toBeDefined();
    const raw = window.localStorage.getItem(`metis:personalization-draft:v1:${custom.id}`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { baseRevision: number; draft: PersonalizationDefinition };
    expect(stored.baseRevision).toBe(savedDefinition.revision);
    expect(stored.draft.revision).toBe(savedDefinition.revision + 1);
    expect(stored.draft.description).toBe('Edited while save was pending');
  });

  it('rebases edits made after save succeeds but before the saved revision reloads', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const custom = editableUserDefinition(source, 'user:skills/post-save-edit', 'Post-save edit agent');
    definitions.push(custom);
    let resolveReload: ((value: { ok: true; definitions: PersonalizationDefinition[] }) => void) | undefined;
    listPersonalization
      .mockImplementationOnce(() => Promise.resolve({ ok: true, definitions: [...definitions] }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReload = resolve; }));

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const description = await screen.findByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'Saved revision content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(2));

    fireEvent.change(description, { target: { value: 'Newer edit during reload' } });
    expect(description).toHaveProperty('value', 'Newer edit during reload');
    expect(await screen.findByText('Draft preserved automatically')).toBeDefined();
    await act(async () => {
      resolveReload?.({ ok: true, definitions: [...definitions] });
      await Promise.resolve();
    });

    expect(await screen.findByDisplayValue('Newer edit during reload')).toBeDefined();
    expect(screen.getByText('Preserved draft restored')).toBeDefined();
    const raw = window.localStorage.getItem(`metis:personalization-draft:v1:${custom.id}`);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { baseRevision: number; draft: PersonalizationDefinition };
    expect(stored.baseRevision).toBe(2);
    expect(stored.draft.revision).toBe(3);
    expect(stored.draft.description).toBe('Newer edit during reload');
  });

  it('clears a retained draft after save and focuses the remounted revision heading', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const custom = editableUserDefinition(source, 'user:skills/saved-draft', 'Saved draft agent');
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Persisted by the save service' },
    });
    await screen.findByText('Draft preserved automatically');
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: custom.name })));
    expect(screen.queryByText('Draft preserved')).toBeNull();
    expect(screen.queryByText('Preserved draft restored')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveProperty('value', 'Persisted by the save service');

    view.unmount();
    expect(window.localStorage.getItem(`metis:personalization-draft:v1:${custom.id}`)).toBeNull();
    expect(window.sessionStorage.getItem(`metis:personalization-draft:v1:${custom.id}`)).toBeNull();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('Persisted by the save service')).toBeDefined();
    expect(screen.queryByText('Preserved draft restored')).toBeNull();
  });

  it('moves focus to the new definition heading after creation', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    await screen.findByText('No custom definitions yet.');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const heading = await screen.findByRole('heading', { name: 'My Skills' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('scrolls a selected editor into view only when the layout is stacked', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const first = editableUserDefinition(source, 'user:skills/narrow-scroll', 'Narrow scroll agent');
    const second = editableUserDefinition(source, 'user:skills/desktop-focus', 'Desktop focus agent');
    definitions.push(first, second);
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    let narrow = true;
    const scrollIntoView = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: narrow })),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${first.id}"]`) as HTMLButtonElement);
    const narrowHeading = await screen.findByRole('heading', { name: first.name });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' }));
    expect(scrollIntoView.mock.instances[0]).toBe(narrowHeading);

    view.unmount();
    narrow = false;
    scrollIntoView.mockClear();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(document.querySelector(`[data-definition-id="${second.id}"]`) as HTMLButtonElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: second.name })));
    expect(scrollIntoView).not.toHaveBeenCalled();

    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  it('uses natural localized labels for the workbench and editable enum fields', async () => {
    useMetisStore.setState({ locale: 'zh' });
    const scenarioSource = builtin.find((item) => item.kind === 'scenario')!;
    const skillSource = builtin.find((item) => item.kind === 'skill')!;
    const scenario = editableUserDefinition(scenarioSource, 'user:scenarios/localized-labels', '本地化场景');
    const skill = editableUserDefinition(skillSource, 'user:skills/localized-labels', '本地化技能');
    definitions.push(scenario, skill);

    render(<PersonalizationCenter />);
    expect(await screen.findByTestId('scenario-workbench')).toBeDefined();
    await selectScenarioInWorkbench('本地化场景');
    expect(await screen.findByTestId('sw-page-basics')).toBeDefined();
    expect(screen.getByTestId('sw-page-structure')).toBeDefined();
    expect(screen.getByTestId('sw-page-capability')).toBeDefined();
    expect(screen.getByTestId('sw-page-rules')).toBeDefined();
    expect((screen.getByTestId('sw-config-name') as HTMLInputElement).value).toBe('本地化场景');

    // UX: 工作台只展示四段作者区，不暴露旧能力/产物格式与运行时配置。
    expect(screen.queryByRole('combobox', { name: '场景能力' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '记忆范围' })).toBeNull();
    expect(screen.queryByTestId('sw-full-access')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /技能/u }));
    expect(await screen.findByText('技能', { selector: '.personalization-eyebrow' })).toBeDefined();
    fireEvent.click(document.querySelector(`[data-definition-id="${skill.id}"]`) as HTMLButtonElement);
    fireEvent.click((await screen.findAllByRole('button', { name: '添加字段' }))[0]!);
    const fieldType = screen.getAllByRole('combobox', { name: '类型' })[0]!;
    expect(within(fieldType).getByRole('option', { name: '文本' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '数值' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '整数' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '是 / 否' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '列表' })).toBeDefined();
    expect(within(fieldType).getByRole('option', { name: '对象' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^MCP/u }));
    expect(await screen.findByText('凭据', { selector: '.personalization-eyebrow' })).toBeDefined();
    fireEvent.change(screen.getByRole('combobox', { name: '模式' }), { target: { value: 'mcp_url' } });
    expect(await screen.findByText('粘贴 MCP 清单的 HTTPS 地址，核验通过后才启用。')).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'MCP 清单 HTTPS 地址' })).toBeDefined();
  });

  it('edits a scenario workflow without exposing permission confirmation settings', async () => {
    const source = builtin.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:scenarios/workflow-editor',
      name: 'Editable workflow',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Editable workflow');
    expect(await screen.findByTestId('sw-page-capability')).toBeDefined();
    expect(screen.queryByTestId('sw-full-access')).toBeNull();
    expect(screen.queryByRole('button', { name: /permission|confirm/iu })).toBeNull();
    const steps = () => screen.getAllByTestId('sw-workflow-step');
    const before = steps().length;
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    expect(steps().length).toBe(before + 1);
    const firstAdded = steps()[before]!;
    const addedId = firstAdded.querySelector<HTMLInputElement>('input[aria-label*="name"]')!.getAttribute('aria-label')!.match(/Step (.+) name/)![1];
    fireEvent.change(firstAdded.querySelector<HTMLInputElement>('input[aria-label*="name"]')!, { target: { value: 'Audit pass' } });
    fireEvent.change(within(firstAdded).getByTestId('sw-step-prompt'), { target: { value: 'Check the prior artifact.' } });
    fireEvent.change(within(firstAdded).getByTestId('sw-step-criteria'), { target: { value: 'Every finding has evidence.' } });
    fireEvent.click(within(firstAdded).getByRole('button', { name: 'Remove step' }));
    expect(steps().length).toBe(before);
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    const secondAdded = steps()[before]!;
    const secondId = secondAdded.querySelector<HTMLInputElement>('input[aria-label*="name"]')!.getAttribute('aria-label')!.match(/Step (.+) name/)![1];
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => {
      const request = savePersonalization.mock.calls.at(-1)?.[0] as { definition: PersonalizationDefinition };
      expect(request.definition.kind).toBe('scenario');
      if (request.definition.kind === 'scenario') {
        const originalIds = request.definition.workflow.slice(0, before).map((step) => step.id);
        expect(request.definition.workflow).toHaveLength(before + 1);
        expect(request.definition.workflow[request.definition.workflow.length - 1]?.name).toBe('New step');
        expect(request.definition.workflow[request.definition.workflow.length - 1]?.dependsOn)
          .toEqual([request.definition.workflow[request.definition.workflow.length - 2]?.id]);
        expect(originalIds.length).toBe(before);
        expect(addedId).toBeTruthy();
        expect(secondId).toBeTruthy();
      }
    });
  });

  it('installs a selected ZIP skill through the main-process extension boundary', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await waitFor(() => expect(selectFileCapability).toHaveBeenCalledWith('personalization-skill-package'));
    expect(await screen.findByText('ZIP: review-skill.zip')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'skill_package',
      expectedRevision: 0,
      expectedId: null,
      sourceCapabilityId: 'fc_personalizationskillpackage_123456789012345678',
    });
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it('discards a consumed package selection after a CAS conflict and requires a fresh selection', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const existing = editableUserDefinition(source, 'user:skills/update-target', 'Update target skill');
    existing.revision = 3;
    definitions.push(existing);
    selectFileCapability
      .mockReset()
      .mockResolvedValueOnce({
        success: true,
        capability: {
          capabilityId: 'fc_firstpackagecapability_123456789012345',
          kind: 'file',
          mime: 'application/zip',
          displayName: 'first-review-skill.zip',
          operations: ['file'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        capability: {
          capabilityId: 'fc_freshpackagecapability_123456789012345',
          kind: 'file',
          mime: 'application/zip',
          displayName: 'fresh-review-skill.zip',
          operations: ['file'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      });
    applyPersonalizationExtension
      .mockImplementationOnce(() => {
        definitions = definitions.map((definition) => definition.id === existing.id
          ? { ...definition, revision: 4 }
          : definition) as PersonalizationDefinition[];
        return Promise.resolve({
          ok: false,
          mode: 'skill_package',
          code: 'definition_rejected',
          detailCode: 'definition_cas_failed',
          compensated: false,
        });
      })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        definition: definitions.find((definition) => definition.id === existing.id)!,
      }));

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    expect(screen.queryByRole('spinbutton', { name: /revision/u })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Installation target' }), {
      target: { value: existing.id },
    });
    expect(screen.getByText(/Updating “Update target skill”/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await screen.findByText('ZIP: first-review-skill.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));

    expect(await screen.findByText(/select the target and skill package again/u)).toBeDefined();
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      mode: 'skill_package',
      expectedRevision: 3,
      expectedId: existing.id,
      sourceCapabilityId: 'fc_firstpackagecapability_123456789012345',
    });
    await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('combobox', { name: 'Installation target' })).toHaveProperty('value', '');
    expect(screen.getByText('Nothing selected')).toBeDefined();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify and install' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Choose a skill ZIP package or folder first')).toBeDefined();

    fireEvent.change(screen.getByRole('combobox', { name: 'Installation target' }), {
      target: { value: existing.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await screen.findByText('ZIP: fresh-review-skill.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(2));
    expect(applyPersonalizationExtension.mock.calls[1]?.[0]).toMatchObject({
      mode: 'skill_package',
      expectedRevision: 4,
      expectedId: existing.id,
      sourceCapabilityId: 'fc_freshpackagecapability_123456789012345',
    });
  });

  it('shows only Skill targets compatible with the selected installation mode', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const packageTarget = editableUserDefinition(source, 'user:skills/package-target', 'Package target');
    const urlTarget = {
      ...editableUserDefinition(source, 'url:skills/url-target', 'URL target'),
      provenance: {
        ...source.provenance,
        origin: 'url',
        sourceUrl: 'https://example.com/url-target.zip',
        sourceRevision: '1.0.0',
        locallyModified: false,
      },
      sourceMode: 'url',
    } as Extract<PersonalizationDefinition, { kind: 'skill' }>;
    definitions.push(packageTarget, urlTarget);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    const target = screen.getByRole('combobox', { name: 'Installation target' });
    expect(within(target).getByRole('option', { name: packageTarget.name })).toBeDefined();
    expect(within(target).queryByRole('option', { name: urlTarget.name })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'skill_url' } });
    expect(within(target).queryByRole('option', { name: packageTarget.name })).toBeNull();
    expect(within(target).getByRole('option', { name: urlTarget.name })).toBeDefined();
  });

  it('resets the installer mode when switching between Skills and MCP', async () => {
    render(<PersonalizationCenter />);

    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveProperty('value', 'skill_package');
    expect(screen.getByRole('button', { name: 'Choose skill ZIP package' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^MCP/u }));
    // 刘总 2026-09：「描述需求由 Metis 构建」移到对话构建弹窗，安装器默认本地包模式。
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveProperty('value', 'mcp_package');
    expect(screen.getByRole('button', { name: 'Choose local MCP package directory' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Choose skill ZIP package' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Skills/u }));
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveProperty('value', 'skill_package');
    expect(screen.getByRole('button', { name: 'Choose skill ZIP package' })).toBeDefined();
  });

  it('saves an edited Markdown skill through the signed extension service', async () => {
    const source = builtin.find((item) => item.kind === 'skill')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/signed-markdown',
      revision: 3,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const editor = await screen.findByRole('textbox', { name: 'Skill Markdown' });
    fireEvent.change(editor, { target: { value: '# Signed skill\n\nUse bounded evidence.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'skill_markdown',
      expectedRevision: 3,
      id: custom.id,
      markdown: '# Signed skill\n\nUse bounded evidence.',
    });
    expect(savePersonalization).not.toHaveBeenCalled();
  });

  it('submits an MCP Builder requirement through the build dialog without exposing raw command or environment fields', async () => {
    applyPersonalizationExtension.mockResolvedValueOnce({
      ok: true,
      definition: { id: 'generated:mcp/my-mcp' },
    });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    await waitFor(() => expect(listPersonalizationSecrets).toHaveBeenCalled());
    // 刘总 2026-09：MCP 构建走对话窗口。
    fireEvent.click(screen.getByTestId('personalization-mcp-builder-open'));
    expect(await screen.findByTestId('personalization-mcp-builder')).toBeDefined();
    fireEvent.change(screen.getByTestId('personalization-mcp-builder-requirement'), {
      target: { value: 'Build a bounded literature metadata lookup tool.' },
    });
    expect(screen.queryByLabelText(/raw command|command arguments|parent environment/iu)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Personalization definition ID' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Generated package ID' })).toBeNull();
    fireEvent.click(screen.getByTestId('personalization-mcp-builder-submit'));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'mcp_requirements',
      definitionId: 'generated:mcp/my-mcp',
      requestedPackageId: 'my-mcp',
      requirement: 'Build a bounded literature metadata lookup tool.',
      expectedRevision: 0,
      runProbe: true,
    });
  });

  it('keeps generated and URL MCP update targets isolated when the installation mode changes', async () => {
    const generated = {
      ...pendingUrlMcp(),
      id: 'generated:mcp/my-mcp',
      name: 'Generated My MCP',
      revision: 2,
      provenance: {
        ...pendingUrlMcp().provenance,
        origin: 'generated',
        sourceUrl: null,
      },
      sourceMode: 'generated',
      sourceUrl: null,
    } as Extract<PersonalizationDefinition, { kind: 'mcp' }>;
    const fromUrl = {
      ...pendingUrlMcp(),
      id: 'url:mcp/my-mcp',
      name: 'URL My MCP',
      revision: 5,
    } as Extract<PersonalizationDefinition, { kind: 'mcp' }>;
    definitions.push(generated, fromUrl);
    applyPersonalizationExtension.mockResolvedValueOnce({
      ok: true,
      definition: fromUrl,
    });

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    const target = screen.getByRole('combobox', { name: 'Installation target' });
    // 默认本地包模式：generated/url 定义都不是候选目标。
    expect(target).toHaveProperty('value', '');
    expect(within(target).queryByRole('option', { name: generated.name })).toBeNull();
    expect(within(target).queryByRole('option', { name: fromUrl.name })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Mode' }), { target: { value: 'mcp_url' } });
    expect(target).toHaveProperty('value', fromUrl.id);
    expect(within(target).queryByRole('option', { name: generated.name })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'MCP manifest HTTPS URL' }), {
      target: { value: 'https://example.com/mcp/manifest.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect(applyPersonalizationExtension.mock.calls[0]?.[0]).toMatchObject({
      mode: 'mcp_url',
      definitionId: fromUrl.id,
      expectedRevision: 5,
    });
  });

  it('wires pending URL MCP activation through an owner-blind request', async () => {
    definitions.push(pendingUrlMcp());
    activatePersonalizationMcp.mockImplementation((request: { operationId: string }) => Promise.resolve({
      ok: false,
      contractVersion: 1,
      operationId: request.operationId,
      code: 'probe_failed',
      compensated: true,
      recoveryPending: false,
    }));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    await waitFor(() => expect(document.querySelector('[data-definition-id="url:mcp/center-activation"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-definition-id="url:mcp/center-activation"]') as HTMLButtonElement);
    const activateButton = document.querySelector('.mcp-activation-panel__action') as HTMLButtonElement;
    expect(activateButton).toBeDefined();
    fireEvent.click(activateButton);
    await waitFor(() => expect(activatePersonalizationMcp).toHaveBeenCalledTimes(1));
    const request = activatePersonalizationMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      contractVersion: 1,
      definitionId: 'url:mcp/center-activation',
      installationId: PENDING_MCP_INSTALLATION,
      expectedRevision: 1,
    });
    expect(Object.keys(request).sort()).toEqual([
      'contractVersion', 'definitionId', 'expectedRevision', 'installationId', 'operationId',
    ]);
    expect(request).not.toHaveProperty('owner');
    expect(request).not.toHaveProperty('evidenceContext');
    expect(request).not.toHaveProperty('sampleCall');
  });

  it('stores MCP credentials through the write-only encrypted vault and clears the input', async () => {
    listPersonalizationSecrets
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: '33333333-3333-4333-8333-333333333333',
        revision: 0,
        secrets: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: '66666666-6666-4666-8666-666666666666',
        revision: 1,
        secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 }],
      });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    const nameInput = screen.getByRole('textbox', { name: 'Environment name' });
    const valueInput = screen.getByLabelText('Credential value') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'zotero_api_key' } });
    fireEvent.change(valueInput, { target: { value: 'write-only-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save encrypted' }));
    await waitFor(() => expect(setPersonalizationSecret).toHaveBeenCalledTimes(1));
    expect(setPersonalizationSecret.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      expectedRevision: 0,
      name: 'ZOTERO_API_KEY',
      value: 'write-only-secret',
    });
    await waitFor(() => expect(valueInput.value).toBe(''));
    expect(await screen.findByText('Value hidden', { exact: false })).toBeDefined();
    expect(document.body.textContent).not.toContain('write-only-secret');
  });

  function enabledMcpWithSecret(): Extract<PersonalizationDefinition, { kind: 'mcp' }> {
    return {
      ...pendingUrlMcp(),
      id: 'url:mcp/with-secret',
      name: 'Secret MCP',
      enabled: true,
      tags: ['url', 'probe-verified'],
      environment: { ZOTERO_API_KEY: { secret: true, value: null } },
      exposedTools: ['search'],
    };
  }

  it('enters per-MCP credentials from the item card and clears the missing marker after save', async () => {
    definitions.push(enabledMcpWithSecret());
    listPersonalizationSecrets
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: '11111111-1111-4111-8111-111111111111',
        revision: 0,
        secrets: [],
      })
      .mockResolvedValue({
        ok: true,
        contractVersion: 1,
        operationId: '22222222-2222-4222-8222-222222222222',
        revision: 1,
        secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 }],
      });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    await waitFor(() => expect(document.querySelector('[data-definition-id="url:mcp/with-secret"]')).not.toBeNull());
    const card = (document.querySelector('[data-definition-id="url:mcp/with-secret"]') as HTMLElement).closest('article') as HTMLElement;
    // 已启用且声明了凭据但凭据库缺失：条目上出现「未配置」标记。
    const marker = await within(card).findByText(/Credentials missing/u);
    expect(marker.textContent).toContain('ZOTERO_API_KEY');
    fireEvent.click(within(card).getByRole('button', { name: 'Credentials' }));
    await waitFor(() => expect(card.querySelector('.mcp-credential-panel')).not.toBeNull());
    const panel = card.querySelector('.mcp-credential-panel') as HTMLElement;
    expect(within(panel).getByText('Not configured')).toBeDefined();
    const input = panel.querySelector('[data-testid$="-input-ZOTERO_API_KEY"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'per-item-secret' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save encrypted' }));
    await waitFor(() => expect(setPersonalizationSecret).toHaveBeenCalledTimes(1));
    expect(setPersonalizationSecret.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      expectedRevision: 0,
      name: 'ZOTERO_API_KEY',
      value: 'per-item-secret',
    });
    await within(panel).findByText('Configured');
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain('per-item-secret');
    await waitFor(() => expect(within(card).queryByText(/Credentials missing/u)).toBeNull());
  });

  it('offers a free-form key/value entry for MCPs that declare no credential requirements', async () => {
    definitions.push(pendingUrlMcp());
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^MCP/u }));
    await waitFor(() => expect(document.querySelector('[data-definition-id="url:mcp/center-activation"]')).not.toBeNull());
    // 未声明凭据需求的条目没有「未配置」标记。
    const card = (document.querySelector('[data-definition-id="url:mcp/center-activation"]') as HTMLElement).closest('article') as HTMLElement;
    expect(within(card).queryByText(/Credentials missing/u)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Credentials' }));
    await waitFor(() => expect(card.querySelector('.mcp-credential-panel')).not.toBeNull());
    const panel = card.querySelector('.mcp-credential-panel') as HTMLElement;
    expect(panel.querySelector('[data-testid$="-free-name"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid$="-free-value"]')).not.toBeNull();
  });

  it('imports and exports a selected dependency graph without credential fields', async () => {
    const source = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:scenarios/export-root',
      name: 'Export root',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Export root');
    fireEvent.click(screen.getByRole('button', { name: 'Export selected configuration' }));
    await waitFor(() => expect(exportPersonalizationBundle).toHaveBeenCalledTimes(1));
    const exportRequest = exportPersonalizationBundle.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(exportRequest).toMatchObject({ contractVersion: 1, rootDefinitionIds: ['user:scenarios/export-root'] });
    expect(Object.keys(exportRequest).sort()).toEqual(['contractVersion', 'operationId', 'rootDefinitionIds']);

    fireEvent.click(screen.getByRole('button', { name: 'Import bundle' }));
    await waitFor(() => expect(importPersonalizationBundle).toHaveBeenCalledTimes(1));
    const importRequest = importPersonalizationBundle.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(importRequest).sort()).toEqual(['contractVersion', 'operationId']);
  });

  it('does not inject a funding preset workflow into a blank scenario library', async () => {
    researchWorkspaceStore.setState({ activeProjectId: 'project-funding' });
    render(<PersonalizationCenter />);
    await screen.findByTestId('sw-empty');
    expect(screen.queryByRole('region', { name: 'Funding application templates' })).toBeNull();
    expect(fundingTemplate).not.toHaveBeenCalled();
  });

  it('creates stable ASCII IDs for Chinese names and keeps repeated creations unique', async () => {
    useMetisStore.setState({ locale: 'zh' });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /技能/u }));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(2));

    const ids = savePersonalization.mock.calls.map(([request]) => (
      request as { definition: PersonalizationDefinition }
    ).definition.id);
    expect(ids).toEqual(['user:skills/custom-skill', 'user:skills/custom-skill-2']);
    expect(ids.every((id) => /^(?:builtin|user|url|generated):[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(id))).toBe(true);
  });

  it('creates a blank custom scenario without silently binding arbitrary definitions', async () => {
    render(<PersonalizationCenter />);
    // 新建场景按钮点击直接创建空白场景（不再有下拉菜单）。
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const request = savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition };
    expect(request.definition.kind).toBe('scenario');
    if (request.definition.kind === 'scenario') {
      expect(request.definition.agentIds).toEqual([]);
      expect(request.definition.skillIds).toEqual([]);
      expect(request.definition.mcpIds).toEqual([]);
      expect(request.definition.rulesIds).toEqual([]);
      expect(request.definition.workflow).toEqual([]);
    }
  });

  it('新建场景：id 被已删除（归档）记录占用时自动换唯一 id 重试，保证创建成功', async () => {
    // 第一次保存：id 被归档记录占用 → revision_conflict；重试换 id 后回落到默认 mock（saved）。
    savePersonalization.mockImplementationOnce(() => Promise.resolve({ ok: false, code: 'revision_conflict', currentRevision: 1 }));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(2));
    const firstId = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition.id;
    const secondId = (savePersonalization.mock.calls[1]![0] as { definition: PersonalizationDefinition }).definition.id;
    // 重试时 id 追加唯一后缀，避开被占用的 id。
    expect(secondId).not.toBe(firstId);
    expect(secondId.startsWith(firstId + '-')).toBe(true);
  });

  it('binds workflow Skills by readable step choices instead of raw IDs（智能体概念已移除）', async () => {
    const builtinSkill = definitions.find((item) => item.kind === 'skill' && item.enabled)!;
    const skill = {
      ...structuredClone(builtinSkill),
      id: 'user:skills/readable-skill',
      name: 'Readable Skill',
      provenance: { ...builtinSkill.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    const source = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:scenarios/readable-picker',
      name: 'Readable picker scenario',
      revision: 1,
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      rulesIds: [],
      workflow: [],
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(skill, custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Readable picker scenario');

    // 绑定以步骤内「从已安装选择」下拉呈现，而不是原始 ID 输入框；智能体勾选池已不存在。
    expect(screen.queryByRole('textbox', { name: 'Skill IDs' })).toBeNull();
    expect(screen.queryByTestId('sw-cap-agent')).toBeNull();
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    expect(screen.getAllByTestId('sw-workflow-step').length).toBe(1);
    const step = screen.getAllByTestId('sw-workflow-step')[0]!;
    fireEvent.change(within(step).getByLabelText('Pick an installed Skill'), { target: { value: skill.id } });

    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const saved = (savePersonalization.mock.calls[0]![0] as { definition: PersonalizationDefinition }).definition;
    expect(saved.kind).toBe('scenario');
    if (saved.kind === 'scenario') {
      expect(saved.skillIds).toEqual([skill.id]);
      expect(saved.workflow.length).toBe(1);
      expect(saved.workflow[0]?.skillIds).toEqual([skill.id]);
    }
  });

  it('builds strict Skill input and output structures through visual fields without raw JSON', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    definitions.push({
      ...structuredClone(source),
      id: 'user:skills/visual-schema',
      name: 'Visual schema skill',
      revision: 1,
      inputSchema: null,
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector('[data-definition-id="user:skills/visual-schema"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-definition-id="user:skills/visual-schema"]') as HTMLButtonElement);
    expect(screen.queryByRole('textbox', { name: /JSON/u })).toBeNull();

    let addButtons = screen.getAllByRole('button', { name: 'Add field' });
    fireEvent.click(addButtons[0]!);
    let names = screen.getAllByRole('textbox', { name: 'Field name' });
    fireEvent.change(names[0]!, { target: { value: 'research_question' } });
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Required' })[0]!);

    addButtons = screen.getAllByRole('button', { name: 'Add field' });
    fireEvent.click(addButtons[1]!);
    names = screen.getAllByRole('textbox', { name: 'Field name' });
    fireEvent.change(names[1]!, { target: { value: 'findings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    const request = applyPersonalizationExtension.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { research_question: { type: 'string' } },
      required: ['research_question'],
    });
    expect(request.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { findings: { type: 'string' } },
      required: [],
    });
  });

  it('preserves an invalid visual field name and blocks saving until the user fixes it', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/invalid-visual-field',
      name: 'Invalid visual field skill',
      revision: 1,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { topic: { type: 'string' } },
        required: [],
      },
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'invalid field name' },
    });

    expect(screen.getByRole('textbox', { name: 'Field name' })).toHaveProperty('value', 'invalid field name');
    expect(screen.getByText('Field names must be unique and start with a letter or underscore.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);
    expect(applyPersonalizationExtension).not.toHaveBeenCalled();

    view.unmount();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('invalid field name')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'research_topic' },
    });
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect((applyPersonalizationExtension.mock.calls[0]![0] as { inputSchema: unknown }).inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { research_topic: { type: 'string' } },
      required: [],
    });
  });

  it('keeps advanced schemas read-only until the user explicitly replaces them', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const advancedSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: { type: 'array', items: { type: 'string' } },
        method: { type: 'string', enum: ['qualitative', 'quantitative'], default: 'qualitative' },
        options: {
          type: 'object',
          additionalProperties: false,
          properties: { includeAppendix: { type: 'boolean' } },
          required: [],
        },
      },
      required: ['sources'],
    };
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/advanced-schema',
      name: 'Advanced schema skill',
      revision: 1,
      inputSchema: advancedSchema,
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);

    const view = render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(screen.getByText('Existing advanced schema preserved')).toBeDefined();
    expect(screen.queryByDisplayValue('sources')).toBeNull();
    let inputEditor = screen.getByRole('group', { name: 'Input fields' });
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Replace with visual fields' }));
    expect(screen.getByText('Visual replacement not applied')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', true);
    inputEditor = screen.getByRole('group', { name: 'Input fields' });
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(inputEditor).getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'replacement_topic' },
    });
    view.unmount();
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    expect(await screen.findByDisplayValue('replacement_topic')).toBeDefined();
    expect(screen.getByText('Visual replacement not applied')).toBeDefined();
    inputEditor = screen.getByRole('group', { name: 'Input fields' });
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Cancel replacement' }));
    expect(screen.getByText('Existing advanced schema preserved')).toBeDefined();
    expect(screen.queryByDisplayValue('replacement_topic')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect((applyPersonalizationExtension.mock.calls[0]![0] as { inputSchema: unknown }).inputSchema)
      .toEqual(advancedSchema);
  });

  it('distinguishes a strict empty-object schema from removing all fields from no schema', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const strictEmptyObject = {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    };
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/empty-schema-semantics',
      name: 'Empty schema semantics skill',
      revision: 1,
      inputSchema: strictEmptyObject,
      outputSchema: null,
      provenance: { ...source.provenance, origin: 'user', parentId: null, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);

    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/u }));
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${custom.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${custom.id}"]`) as HTMLButtonElement);
    const inputEditor = screen.getByRole('group', { name: 'Input fields' });
    const outputEditor = screen.getByRole('group', { name: 'Output fields' });

    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Add field' }));
    fireEvent.click(within(inputEditor).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(outputEditor).getByRole('button', { name: 'Add field' }));
    fireEvent.click(within(outputEditor).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    const request = applyPersonalizationExtension.mock.calls[0]![0] as {
      inputSchema: unknown;
      outputSchema: unknown;
    };
    expect(request.inputSchema).toEqual(strictEmptyObject);
    expect(request.outputSchema).toBeNull();
  });

  it('shows a recoverable load error and retries without remounting the center', async () => {
    listPersonalization
      .mockRejectedValueOnce(new Error('temporary IPC outage'))
      .mockResolvedValueOnce({ ok: true, definitions });
    render(<PersonalizationCenter />);
    expect(await screen.findByText(/Personalization configurations could not be loaded/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('sw-empty')).toBeDefined();
    expect(screen.queryByText('General research')).toBeNull();
    expect(listPersonalization).toHaveBeenCalledTimes(2);
  });

  it('preserves an edited draft and re-enables save after an IPC rejection', async () => {
    const source = definitions.find((item) => item.kind === 'skill')!;
    const custom = {
      ...structuredClone(source),
      id: 'user:skills/retry-save',
      name: 'Retry save agent',
      revision: 1,
      provenance: { ...source.provenance, origin: 'user', parentId: source.id, locallyModified: true },
    } as PersonalizationDefinition;
    definitions.push(custom);
    applyPersonalizationExtension.mockRejectedValueOnce(new Error('main process disconnected'));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    const retryCard = (await screen.findAllByText('Retry save agent')).map((el) => el.closest('[data-definition-id]')).find(Boolean);
    fireEvent.click(retryCard as HTMLButtonElement);
    const description = screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: 'Local draft must survive.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByText(/Save did not complete/u)).toBeDefined();
    expect(description.value).toBe('Local draft must survive.');
    expect(screen.getByRole('button', { name: 'Save new revision' })).toHaveProperty('disabled', false);
  });

  it('recovers the installer UI after a rejected extension request', async () => {
    applyPersonalizationExtension.mockRejectedValueOnce(new Error('installer IPC unavailable'));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await screen.findByText('ZIP: review-skill.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    expect(await screen.findByText(/Installation did not complete/u)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Verify and install' })).toHaveProperty('disabled', false);
  });

  it('hands a user-created scenario to conversation without exposing presets', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    definitions.push(runnableScenario('user:scenarios/my-workflow', 'My workflow'));
    render(<PersonalizationCenter onActivateScenario={activate} />);
    await selectScenarioInWorkbench('My workflow');
    fireEvent.click(screen.getByTestId('sw-use'));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('user:scenarios/my-workflow'));
    expect(screen.queryByText('Academic monograph')).toBeNull();
  });

  it('keeps zero-step scenarios editable but blocks use until a valid workflow exists', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const scenarioSource = definitions.find((item) => item.id === 'builtin:scenarios/general-research')!;
    const emptyScenario = {
      ...editableUserDefinition(scenarioSource, 'user:scenarios/empty-workflow', 'Empty Workflow scenario'),
      agentIds: [],
      workflow: [],
    } as PersonalizationDefinition;
    const withStepScenario = runnableScenario('user:scenarios/with-step', 'With Step scenario');
    definitions.push(emptyScenario, withStepScenario);

    render(<PersonalizationCenter onActivateScenario={activate} />);
    await selectScenarioInWorkbench('Empty Workflow scenario');
    const nameInput = (await screen.findAllByDisplayValue('Empty Workflow scenario'))[0]!;
    expect(nameInput).toBeDefined();
    fireEvent.click(screen.getByTestId('sw-use'));
    expect(await screen.findByText(/Not ready to start: Define at least one deliverable section/u)).toBeDefined();
    expect(activate).not.toHaveBeenCalled();

    await selectScenarioInWorkbench('With Step scenario');
    fireEvent.click(screen.getByTestId('sw-use'));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('user:scenarios/with-step'));
  });

  it('the unified Harness Compiler directly updates an Agent-optional workflow draft', async () => {
    compileScenarioHarness.mockImplementation(({ current }: { current: Extract<PersonalizationDefinition, { kind: 'scenario' }> }) => Promise.resolve({
      ok: true,
      summary: 'Compiled archive research Harness',
      scenario: {
        ...structuredClone(current),
        name: 'AI Archive Scenario',
        triggerPhrases: ['archive'],
        agentIds: [],
        skillIds: [],
        mcpIds: [],
        workflowPrompt: 'Complete each archive-analysis step before handing its evidence to the next step.',
        workflow: [
          { id: 'list-catalogs', name: 'List catalogs', description: 'List archive catalogs.', goal: 'Map the source boundary.', prompt: 'List all relevant archive catalogs.', skillIds: [], toolIds: [], mcpIds: [], dependsOn: [], maxTurns: 8, inputs: [], outputs: [], completionCriteria: ['Catalog list is complete'], condition: null },
          { id: 'extract-evidence', name: 'Extract evidence', description: 'Extract evidence excerpts.', goal: 'Build a traceable evidence set.', prompt: 'Extract evidence and preserve source references.', skillIds: [], toolIds: [], mcpIds: [], dependsOn: ['list-catalogs'], maxTurns: 8, inputs: [], outputs: [], completionCriteria: ['Every claim has a source'], condition: null },
        ],
        deliverable: {
          type: 'survey_report',
          typeLabel: '调研报告',
          structurePolicy: { defaultSections: 3, suggestedMin: 3, suggestedMax: 5 },
          sections: [
            { id: 'title', title: '题目', kind: 'title', status: 'locked' },
            { id: 'c1', title: '1 引言', kind: 'chapter', status: 'required', requirements: ['研究缺口'] },
          ],
        },
        writingRules: ['引用必须真实可查'],
      },
    }));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    fireEvent.change(await screen.findByTestId('sw-assistant-input'), { target: { value: 'Please design the complete continuous Workflow.' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));
    await waitFor(() => expect(compileScenarioHarness).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('sw-config-name') as HTMLInputElement).value).toBe('AI Archive Scenario');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(savePersonalization.mock.calls.length).toBeGreaterThanOrEqual(2));

    const calls = savePersonalization.mock.calls.map(
      (call) => (call[0] as { definition: PersonalizationDefinition }).definition,
    );
    const savedScenarios = calls.filter((definition) => definition.kind === 'scenario');
    const scenario = savedScenarios.at(-1)!;
    expect(scenario.name).toBe('AI Archive Scenario');
    expect(scenario.agentIds).toEqual([]);
    expect(scenario.workflow).toHaveLength(2);
    expect(scenario.workflow[0]!.agentId).toBeUndefined();
    expect(scenario.workflow[1]!.dependsOn).toContain(scenario.workflow[0]!.id);
    // 成果结构与写作规范进入场景定义（场景真正驱动执行的数据基础）。
    expect(scenario.deliverable?.type).toBe('survey_report');
    expect(scenario.deliverable?.sections?.[1]?.requirements).toContain('研究缺口');
    expect(scenario.writingRules).toContain('引用必须真实可查');

    // 生成后保留在当前四段式编辑器中，而非经过旧 diff/apply 面板。
    expect((await screen.findAllByDisplayValue('AI Archive Scenario')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('sw-compiler-diff')).toBeNull();
  });

  it('scenario editor no longer shows capability or artifact format fields', async () => {
    const source = builtin.find((item) => item.kind === 'scenario')!;
    const custom = editableUserDefinition(source, 'user:scenarios/cleanup', 'Cleanup scenario');
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Cleanup scenario');
    expect((await screen.findAllByDisplayValue('Cleanup scenario')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Scenario capability')).toBeNull();
    expect(screen.queryByText('Artifact format')).toBeNull();
  });

  it('workflow steps can be added directly（无智能体前置条件）', async () => {
    const source = builtin.find((item) => item.kind === 'scenario')!;
    const custom = {
      ...editableUserDefinition(source, 'user:scenarios/gating', 'Gating scenario'),
      agentIds: [],
      workflow: [],
    } as PersonalizationDefinition;
    definitions.push(custom);

    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Gating scenario');
    const addStep = await screen.findByTestId('sw-workflow-add');
    expect(addStep).toHaveProperty('disabled', false);
    fireEvent.click(addStep);
    expect(screen.getAllByTestId('sw-workflow-step').length).toBe(1);

    // 智能体概念已移除：无智能体勾选池，步骤独立完成。
    expect(screen.queryByTestId('sw-cap-agent')).toBeNull();
  });

  it('scenario editor persists the complete deliverable constraints and editable hierarchy', async () => {
    const source = builtin.find((item) => item.kind === 'scenario')!;
    const custom = editableUserDefinition(source, 'user:scenarios/deliverable', 'Deliverable scenario');
    definitions.push(custom);
    render(<PersonalizationCenter />);
    await selectScenarioInWorkbench('Deliverable scenario');
    fireEvent.change(await screen.findByTestId('sw-config-length'), { target: { value: '12,000 words' } });
    fireEvent.change(screen.getByTestId('sw-chapter-count'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('sw-secondary-min'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('sw-secondary-max'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => {
      const lastCall = savePersonalization.mock.calls.at(-1)![0] as { definition: PersonalizationDefinition };
      expect(lastCall.definition.kind).toBe('scenario');
      if (lastCall.definition.kind === 'scenario') {
        expect(lastCall.definition.deliverable?.globalLength).toBe('12,000 words');
        expect(lastCall.definition.deliverable?.secondarySections).toEqual({ min: 2, max: 4 });
        expect(lastCall.definition.deliverable?.sections?.filter((section) => section.kind === 'chapter')).toHaveLength(2);
      }
    });
  });

  it('the unified Harness Compiler surfaces a friendly error without modifying the focused draft', async () => {
    compileScenarioHarness.mockResolvedValue({ ok: false, code: 'model_failed', issues: ['parse_failed'] });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    fireEvent.change(await screen.findByTestId('sw-config-name'), { target: { value: 'Unchanged scenario' } });
    fireEvent.change(screen.getByTestId('sw-assistant-input'), { target: { value: 'Please design the complete continuous Workflow.' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));
    expect((await screen.findAllByText(/AI did not return usable scenario content: model_failed/u)).length).toBeGreaterThan(0);
    expect((screen.getByTestId('sw-config-name') as HTMLInputElement).value).toBe('Unchanged scenario');
    expect(screen.queryByTestId('sw-compiler-diff')).toBeNull();
  });

  it('the compiler persists first-class Scenario Metis.md together with the deliverable blueprint', async () => {
    compileScenarioHarness.mockImplementation(({ current }: { current: Extract<PersonalizationDefinition, { kind: 'scenario' }> }) => Promise.resolve({
      ok: true,
      summary: 'Compiled scenario memory and blueprint',
      scenario: {
        ...structuredClone(current),
        name: 'Archive Memory Scenario',
        deliverable: {
          type: 'theory_paper',
          typeLabel: '纯理论论文',
          sections: [
            { id: 'title', title: '题目', kind: 'title', status: 'locked' },
            { id: 'abs', title: '摘要', kind: 'abstract', status: 'required' },
            { id: 'kw', title: '关键词', kind: 'keywords', status: 'required' },
          ],
        },
        scenarioMetis: {
          purpose: '地方档案研究', roleBoundaries: '不越过材料证据边界', researchRules: '只使用地方档案作为证据来源。',
          writingRules: '区分原文与解释', toolRules: '工具结果必须保留来源', qualityGates: '关键结论可追溯',
          failureRecovery: '证据不足时回溯检索', markdown: '## 研究边界\n只使用地方档案作为证据来源。',
          inheritanceOrder: ['global', 'scenario', 'project'],
        },
      },
    }));
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    fireEvent.change(await screen.findByTestId('sw-assistant-input'), { target: { value: 'Please generate the complete Scenario Metis.md from the current requirements.' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));
    await waitFor(() => expect(compileScenarioHarness).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));

    const savedDefinitions = () => savePersonalization.mock.calls.map(
      (call) => (call[0] as { definition: PersonalizationDefinition }).definition,
    );
    await waitFor(() => {
      expect(savedDefinitions().filter((d) => d.kind === 'scenario').at(-1)?.name).toBe('Archive Memory Scenario');
    });
    const savedScenarios = savedDefinitions().filter((d) => d.kind === 'scenario');
    const scenario = savedScenarios.at(-1)!;
    expect(scenario.scenarioMetis?.markdown).toContain('只使用地方档案作为证据来源');
    expect(scenario.scenarioMetis?.inheritanceOrder).toEqual(['global', 'scenario', 'project']);
    expect(scenario.deliverable?.sections?.map((section) => section.title)).toEqual(['题目', '摘要', '关键词']);
  });

  it('exposes exactly four authoring sections and no legacy template parser', async () => {
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));
    expect(await screen.findByTestId('sw-page-basics')).toBeDefined();
    expect(screen.getByTestId('sw-page-structure')).toBeDefined();
    expect(screen.getByTestId('sw-page-capability')).toBeDefined();
    expect(screen.getByTestId('sw-page-rules')).toBeDefined();
    expect(screen.queryByTestId('sw-new-template')).toBeNull();
    expect(screen.queryByTestId('template-parse-panel')).toBeNull();
  });

  it('renders the market browser on the skill and MCP library pages', async () => {
    Object.assign(window.metis, {
      marketSearch: vi.fn().mockResolvedValue({ ok: true, items: [], usingToken: true }),
      marketReadSkillDoc: vi.fn(),
      marketReadMcpDocs: vi.fn(),
    });
    render(<PersonalizationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /^Skills/u }));
    expect(await screen.findByTestId('market-browser-skill')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^MCP/u }));
    expect(await screen.findByTestId('market-browser-mcp')).toBeTruthy();
    // 场景页不渲染市场面板
    fireEvent.click(screen.getByRole('button', { name: /^Scenarios/u }));
    await waitFor(() => expect(screen.queryByTestId('market-browser-skill')).toBeNull());
  });
});
