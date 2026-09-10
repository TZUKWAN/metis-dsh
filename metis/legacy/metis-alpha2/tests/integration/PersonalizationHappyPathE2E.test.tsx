/** @vitest-environment jsdom */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import {
  PersonalizationExtensionService,
  type PersonalizationExtensionServiceDependencies,
} from '../../electron/PersonalizationExtensionService.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import type { PersonalizationExtensionIpcRequest } from '../../engine/runtime/PersonalizationExtensionContract.js';
import App from '../../src/App.js';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import { useMetisStore } from '../../src/store.js';

const MANIFEST_SECRET = Buffer.from('happy-path-manifest-secret-at-least-32-bytes');
const EVIDENCE_SECRET = Buffer.from('happy-path-evidence-secret-at-least-32-bytes');
const CUSTOM_SCENARIO_ID = 'user:scenarios/my-scenarios';
const CUSTOM_SKILL_ID = 'user:skills/my-skills';
const roots: string[] = [];
const databases: Database.Database[] = [];

interface RuntimeStack {
  database: Database.Database;
  repository: PersonalizationRepository;
  runtime: PersonalizationRuntimeService;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-personalization-happy-path-'));
  roots.push(root);
  return root;
}

function openRuntime(databasePath: string): RuntimeStack {
  const database = new Database(databasePath);
  databases.push(database);
  const repository = new PersonalizationRepository(database, MANIFEST_SECRET);
  return {
    database,
    repository,
    runtime: new PersonalizationRuntimeService(repository, MANIFEST_SECRET),
  };
}

function closeDatabase(database: Database.Database): void {
  const index = databases.indexOf(database);
  if (index >= 0) databases.splice(index, 1);
  database.close();
}

function inertExtensionDependencies(): Pick<
  PersonalizationExtensionServiceDependencies,
  'mcp' | 'mcpBuilder' | 'mcpCompensator'
> {
  return {
    mcp: {
      installFromUrl: async () => { throw new Error('MCP is outside this happy-path test'); },
      staticValidate: () => { throw new Error('MCP is outside this happy-path test'); },
      getLaunchDescriptor: () => null,
    },
    mcpBuilder: {
      build: async () => { throw new Error('MCP is outside this happy-path test'); },
    },
    mcpCompensator: { rollbackInstallation: () => false },
  };
}

function completedResponse(answer: string) {
  return {
    version: 1 as const,
    turnId: `happy-path-${Date.now()}`,
    status: 'completed' as const,
    answer,
    diagnostics: [],
    citations: [],
    events: [],
  };
}

function installRuntimeBridge(
  stack: RuntimeStack,
  options: {
    extension?: PersonalizationExtensionService;
    extensionResponses?: unknown[];
    resolvedTurns?: unknown[];
    saveRequests?: unknown[];
    saveResponses?: unknown[];
  } = {},
): ReturnType<typeof vi.fn> {
  const agentChat = vi.fn(async (...args: unknown[]) => {
    const sessionId = String(args[0]);
    const request = args[3] as { scenarioId?: string; projectId?: string } | undefined;
    const resolved = stack.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId,
      projectId: request?.projectId ?? 'global',
      scenarioId: request?.scenarioId,
    });
    options.resolvedTurns?.push(resolved);
    if (!resolved?.ok) throw new Error('The selected personalization graph did not resolve');
    return completedResponse('Resolved custom scenario conversation.');
  });

  const applyPersonalizationExtension = options.extension
    ? async (request: PersonalizationExtensionIpcRequest) => {
        const { operationId, ...withoutOperationId } = request;
        const response = await options.extension!.apply({
          ...withoutOperationId,
          evidenceContext: {
            sessionId: 'personalization-happy-path',
            projectId: 'global',
            operationId,
            runManifestDigest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
            observedAt: Date.now(),
          },
        });
        options.extensionResponses?.push(response);
        return response;
      }
    : undefined;

  Object.defineProperty(window, 'metis', {
    configurable: true,
    writable: true,
    value: {
      listPersonalization: (request: unknown) => Promise.resolve(stack.runtime.list(request)),
      getPersonalization: (request: unknown) => Promise.resolve(stack.runtime.get(request)),
      savePersonalization: (request: unknown) => {
        options.saveRequests?.push(request);
        const response = stack.runtime.save(request);
        options.saveResponses?.push(response);
        return Promise.resolve(response);
      },
      archivePersonalization: (request: unknown) => Promise.resolve(stack.runtime.archive(request)),
      deletePersonalization: (request: unknown) => Promise.resolve(stack.runtime.deletePermanent(request)),
      listPersonalizationTrash: (request: unknown) => Promise.resolve(stack.runtime.listTrash(request)),
      forkPersonalization: (request: unknown) => Promise.resolve(stack.runtime.fork(request)),
      restorePersonalization: (request: unknown) => Promise.resolve(stack.runtime.restore(request)),
      listPersonalizationVersions: (request: unknown) => Promise.resolve(stack.runtime.versions(request)),
      listSessions: vi.fn().mockResolvedValue([{
        id: 'personalization-happy-path-session',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: 'Personalization happy path' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      agentChat,
      fundingTemplate: vi.fn().mockResolvedValue(null),
      ...(applyPersonalizationExtension ? { applyPersonalizationExtension } : {}),
    } as unknown as MetisAPI,
  });
  return agentChat;
}

function definitionCard(id: string): HTMLElement {
  const selector = document.querySelector(`[data-definition-id="${id}"]`);
  if (!(selector instanceof HTMLElement)) throw new Error(`Definition card is missing: ${id}`);
  const card = selector.closest('article');
  if (!(card instanceof HTMLElement)) throw new Error(`Definition card container is missing: ${id}`);
  return card;
}

beforeEach(() => {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    locale: 'en',
    theme: 'light',
    isHydrated: true,
  });
  researchWorkspaceStore.setState({ activeProjectId: null });
  window.localStorage.clear();
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
  if (typeof Element.prototype.scrollIntoView === 'undefined') Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  researchWorkspaceStore.setState({ activeProjectId: null });
  window.localStorage.clear();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

describe('Personalization persisted UI-to-runtime happy paths', () => {
  it('creates and edits a custom scenario, uses it in chat, and reloads it after a runtime restart', { timeout: 20000 }, async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'personalization.db');
    const initial = openRuntime(databasePath);
    const resolvedTurns: unknown[] = [];
    const saveRequests: unknown[] = [];
    const saveResponses: unknown[] = [];
    const agentChat = installRuntimeBridge(initial, { resolvedTurns, saveRequests, saveResponses });

    const mounted = render(<App />);
    fireEvent.click(await screen.findByTestId('personalization-trigger', {}, { timeout: 5000 }));
    // The scene center deliberately has no redundant hero heading: the fixed
    // three-column workbench itself is the entry surface.
    await screen.findByTestId('scenario-workbench', {}, { timeout: 5000 });

    // 技能库新建 Markdown 技能（智能体概念已移除：执行完全由场景工作流承担）。
    fireEvent.click(screen.getByRole('button', { name: /^Skills/u }));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    const skillEditor = await screen.findByRole('region', { name: 'Definition editor' });
    fireEvent.change(within(skillEditor).getAllByLabelText('Name')[0]!, {
      target: { value: 'Durable custom skill' },
    });
    fireEvent.change(within(skillEditor).getByLabelText('Skill Markdown'), {
      target: { value: '# Durable custom skill\n\nPreserve verifiable evidence for every step.' },
    });
    fireEvent.click(within(skillEditor).getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(initial.repository.get(CUSTOM_SKILL_ID)).toMatchObject({
      kind: 'skill',
      name: 'Durable custom skill',
      revision: 2,
    }));

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scenario categories' })).getByRole('button', { name: /^Scenarios/u }));
    // 场景工作台：新建场景按钮点击直接创建（落库默认场景并选中，不再有下拉菜单）。
    fireEvent.click(await screen.findByTestId('sw-new-scenario'));

    const nameInput = await screen.findByTestId('sw-config-name');
    fireEvent.change(nameInput, { target: { value: 'Durable custom conversation' } });
    fireEvent.change(screen.getByTestId('sw-config-length'), { target: { value: '12000 words' } });
    fireEvent.change(screen.getByTestId('sw-chapter-count'), { target: { value: '1' } });
    // 任务1(2026-09-04):Deliverable 完整性门要求总体成文要求。
    fireEvent.change(screen.getByTestId('sw-config-global-instructions'), {
      target: { value: 'Academic register throughout; keep terminology consistent and arguments continuous.' },
    });
    fireEvent.change(screen.getByTestId('sw-workflow-prompt'), {
      target: { value: 'Pass each verified result into the next step until the deliverable is complete.' },
    });
    fireEvent.change(screen.getByTestId('sw-scenario-metis-markdown'), {
      target: { value: '# Scenario Metis.md\n\nPreserve verifiable evidence for every workflow step.' },
    });
    // 绑定资源只存在于具体步骤；所有可见编辑区均来自四段式场景编辑器。
    fireEvent.click(screen.getByTestId('sw-workflow-add'));
    await screen.findByTestId('sw-workflow-step');
    // 任务1(2026-09-04):蓝图编辑器中展开章节并填写必填内容规范。
    const blueprintToggle = document.querySelector('[data-testid^="blueprint-section-"] .scenario-blueprint__toggle') as HTMLElement;
    fireEvent.click(blueprintToggle);
    const blueprintSectionId = (document.querySelector('[data-testid^="blueprint-section-"]') as HTMLElement).getAttribute('data-testid')!.replace('blueprint-section-', '');
    fireEvent.change(document.querySelector(`[data-testid="blueprint-purpose-${blueprintSectionId}"]`) as HTMLElement, {
      target: { value: 'Produce the requested deliverable.' },
    });
    fireEvent.change(document.querySelector(`[data-testid="blueprint-instructions-${blueprintSectionId}"]`) as HTMLElement, {
      target: { value: 'Organize by research question with evidence-linked sections.' },
    });
    fireEvent.change(document.querySelector(`[data-testid="blueprint-requirements-${blueprintSectionId}"]`) as HTMLElement, {
      target: { value: 'Answer the research question' },
    });
    fireEvent.change(document.querySelector(`[data-testid="blueprint-length-${blueprintSectionId}"]`) as HTMLElement, {
      target: { value: '8000 words' },
    });
    fireEvent.change(screen.getByTestId('sw-step-prompt'), {
      target: { value: 'Produce the requested deliverable from the supplied evidence.' },
    });
    fireEvent.change(screen.getByTestId('sw-step-criteria'), {
      target: { value: 'The deliverable is complete and cites its evidence.' },
    });
    fireEvent.change(screen.getByLabelText('Pick an installed Skill'), { target: { value: CUSTOM_SKILL_ID } });
    expect(screen.getAllByTestId('sw-workflow-step').length).toBe(1);
    fireEvent.click(screen.getByTestId('sw-use'));
    const startupBlocker = screen.queryByText(/Not ready to start:/u)?.textContent ?? null;
    expect(startupBlocker).toBeNull();
    await waitFor(() => expect(saveResponses).toHaveLength(4));
    expect(saveRequests.at(-1)).toMatchObject({
      expectedRevision: 1,
      definition: { id: CUSTOM_SCENARIO_ID, revision: 2, name: 'Durable custom conversation' },
    });
    expect(saveResponses.at(-1)).toMatchObject({ ok: true, code: 'saved' });

    await waitFor(() => expect(initial.repository.get(CUSTOM_SCENARIO_ID)).toMatchObject({
      kind: 'scenario',
      name: 'Durable custom conversation',
      revision: 2,
      skillIds: [CUSTOM_SKILL_ID],
      workflowPrompt: 'Pass each verified result into the next step until the deliverable is complete.',
      scenarioMetis: { markdown: expect.stringContaining('Preserve verifiable evidence') },
      deliverable: { globalLength: '12000 words', globalInstructions: 'Academic register throughout; keep terminology consistent and arguments continuous.' },
    }));
    expect(initial.repository.get(CUSTOM_SCENARIO_ID)?.workflow.length).toBe(1);
    const selector = await screen.findByRole('combobox', { name: 'Active scenario' }, { timeout: 5000 }) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe(CUSTOM_SCENARIO_ID));
    fireEvent.change(screen.getByPlaceholderText('Ask a research question...'), {
      target: { value: '/chat Prove this saved scenario reaches the runtime.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1));
    expect(agentChat).toHaveBeenCalledWith(
      'personalization-happy-path-session',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Prove this saved scenario reaches the runtime.',
        }),
      ]),
      undefined,
      expect.objectContaining({
        mode: 'send',
        scenarioId: CUSTOM_SCENARIO_ID,
        projectId: 'global',
        // Renderer-originated correlation is required so delayed stream
        // chunks and live execution events cannot cross-contaminate turns.
        turnId: expect.stringMatching(/^chat-/u),
      }),
    );
    const resolved = resolvedTurns[0] as ReturnType<PersonalizationRuntimeService['resolveForAgent']>;
    expect(resolved?.ok).toBe(true);
    if (!resolved?.ok) throw new Error('Custom scenario did not resolve in the chat bridge');
    expect(resolved.manifest.scenarioId).toBe(CUSTOM_SCENARIO_ID);
    expect(resolved.manifest.definitionRevisions[CUSTOM_SCENARIO_ID]).toBe(2);
    expect(resolved.manifest.agentIds).toEqual([]);
    expect(resolved.manifest.skillIds).toEqual([CUSTOM_SKILL_ID]);
    expect(resolved.manifest.definitionRevisions[CUSTOM_SKILL_ID]).toBe(2);
    expect(await screen.findByText('Resolved custom scenario conversation.', {}, { timeout: 5000 })).toBeDefined();

    mounted.unmount();
    closeDatabase(initial.database);

    const restarted = openRuntime(databasePath);
    installRuntimeBridge(restarted);
    const restartedApp = render(<App />);
    const restartedSelector = await screen.findByRole('combobox', {
      name: 'Active scenario',
    }) as HTMLSelectElement;
    await waitFor(() => expect(restartedSelector.value).toBe(CUSTOM_SCENARIO_ID));
    expect(restarted.repository.get(CUSTOM_SCENARIO_ID)).toMatchObject({
      name: 'Durable custom conversation',
      revision: 2,
      skillIds: [CUSTOM_SKILL_ID],
      workflowPrompt: 'Pass each verified result into the next step until the deliverable is complete.',
    });
    expect(restarted.repository.get(CUSTOM_SCENARIO_ID)?.workflow.length).toBe(1);
    const restartedResolution = restarted.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'after-runtime-restart',
      projectId: 'global',
      scenarioId: CUSTOM_SCENARIO_ID,
    });
    expect(restartedResolution?.ok).toBe(true);
    fireEvent.click(screen.getByTestId('personalization-trigger'));
    const matches = await screen.findAllByText('Durable custom conversation');
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.getByTestId('sw-empty')).toBeDefined();

    restartedApp.unmount();
    closeDatabase(restarted.database);
  }, 20000);

  it('saves Markdown Skill content through the signed extension service and reloads it after restart', async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'personalization.db');
    const initial = openRuntime(databasePath);
    const evidence = new EvidenceEnvelopeService(EVIDENCE_SECRET);
    const extension = new PersonalizationExtensionService({
      definitions: initial.repository,
      evidence,
      skills: new PersonalizationSkillInstaller(path.join(root, 'skill-store')),
      ...inertExtensionDependencies(),
    });
    const extensionResponses: unknown[] = [];
    installRuntimeBridge(initial, { extension, extensionResponses });

    const mounted = render(<App />);
    fireEvent.click(await screen.findByTestId('personalization-trigger', {}, { timeout: 5000 }));
    await screen.findByTestId('scenario-workbench', {}, { timeout: 5000 });
    fireEvent.click(await screen.findByRole('button', { name: /^Skills/u }));
    await screen.findByRole('button', { name: 'Choose skill ZIP package' });
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    const editor = await screen.findByRole('region', { name: 'Definition editor' });
    fireEvent.change(within(editor).getAllByLabelText('Name')[0]!, {
      target: { value: 'Durable Markdown Skill' },
    });
    fireEvent.change(within(editor).getByLabelText('Description'), {
      target: { value: 'Authored and persisted through the production extension service.' },
    });
    fireEvent.change(within(editor).getByLabelText('Skill Markdown'), {
      target: { value: '# Durable Markdown Skill\n\nMARKDOWN_SKILL_RESTART_SENTINEL' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save new revision' }));

    await waitFor(() => expect(initial.repository.get(CUSTOM_SKILL_ID)).toMatchObject({
      kind: 'skill',
      name: 'Durable Markdown Skill',
      sourceMode: 'markdown',
      revision: 2,
      markdown: '# Durable Markdown Skill\n\nMARKDOWN_SKILL_RESTART_SENTINEL',
      systemPrompt: '# Durable Markdown Skill\n\nMARKDOWN_SKILL_RESTART_SENTINEL',
    }));
    expect(extensionResponses).toHaveLength(1);
    const extensionResponse = extensionResponses[0] as Awaited<ReturnType<PersonalizationExtensionService['apply']>>;
    expect(extensionResponse.ok).toBe(true);
    if (!extensionResponse.ok) throw new Error(`Markdown extension failed: ${extensionResponse.code}`);
    expect(evidence.verify(extensionResponse.evidence)).toBe(true);

    mounted.unmount();
    closeDatabase(initial.database);

    const restarted = openRuntime(databasePath);
    installRuntimeBridge(restarted);
    const restartedCenter = render(<App />);
    fireEvent.click(await screen.findByTestId('personalization-trigger', {}, { timeout: 5000 }));
    await screen.findByTestId('scenario-workbench', {}, { timeout: 5000 });
    fireEvent.click(await screen.findByRole('button', { name: /^Skills/u }));
    await waitFor(() => expect(definitionCard(CUSTOM_SKILL_ID)).toBeDefined());
    expect(within(definitionCard(CUSTOM_SKILL_ID)).getByText('Durable Markdown Skill')).toBeDefined();
    expect(restarted.repository.get(CUSTOM_SKILL_ID)).toMatchObject({
      revision: 2,
      sourceMode: 'markdown',
      systemPrompt: expect.stringContaining('MARKDOWN_SKILL_RESTART_SENTINEL'),
    });

    restartedCenter.unmount();
    closeDatabase(restarted.database);
  });
});
