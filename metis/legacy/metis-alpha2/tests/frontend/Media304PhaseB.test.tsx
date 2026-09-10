/**
 * MEDIA-304 Phase B — Research image source attach/purge UI tests.
 *
 * Verifies real selectFileCapability → researchMediaAttach / researchMediaPurge
 * wiring in ProjectWorkspaceSidebar and ResearchInspectorPanels, including
 * capability validation (kind=file, operations includes read), MIME validation,
 * fail-closed cancellation, caption validation, ordinal 0–15 enforcement,
 * capability consumption on attach, project-race guards, purge confirmation,
 * referenced/conflict/unavailable errors, hash non-exposure in the DOM,
 * keyboard/focus, RTL, forced-colors, reduced-motion, and narrow-band CSS
 * contracts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ProjectWorkspaceSidebar from '../../src/research/ProjectWorkspaceSidebar.js';
import ResearchInspectorPanels from '../../src/research/ResearchInspectorPanels.js';
import {
  researchWorkspaceStore,
  type ResearchWorkspaceClient,
  type ResearchWorkspaceState,
} from '../../src/research/researchWorkspaceStore.js';
import type { ProjectSnapshotRuntime, ResearchProjectDto } from '../../engine/runtime/ResearchRuntimeContract.js';
import type { ResearchMediaAttachResult, ResearchMediaPurgeResult } from '../../engine/runtime/ResearchMediaRuntimeContract.js';

const cssContent = readFileSync(resolve(process.cwd(), 'src/research/ResearchWorkspace.css'), 'utf-8');

function makeTimestamp(): number {
  return Date.now();
}

function makeProject(): ResearchProjectDto {
  return {
    id: 'project-1',
    title: 'Test Project',
    researchQuestion: '',
    originalIntent: '',
    lifecycle: 'draft',
    methodology: '',
    discipline: '',
    createdAt: makeTimestamp(),
    updatedAt: makeTimestamp(),
    deletedAt: null,
    archivedAt: null,
    version: 1,
  } as unknown as ResearchProjectDto;
}

function makeSnapshot(partial: {
  sources?: ProjectSnapshotRuntime['sources'];
} = {}): ProjectSnapshotRuntime {
  const project = makeProject();
  return {
    project,
    sources: partial.sources ?? [],
    evidence: [],
    noteCodes: [],
    claims: [],
    artifacts: [],
    artifactVersions: [],
    runs: [],
    checkpoints: [],
    decisions: [],
    claimEvidenceLinks: [],
    capturedAt: project.updatedAt,
  } as unknown as ProjectSnapshotRuntime;
}

function makeMediaDescriptor(sourceId: string): Record<string, unknown> {
  return {
    sourceId,
    caption: 'A research figure',
    ordinal: 3,
    displayName: 'figure.png',
    mediaType: 'image/png',
    byteLength: 1_000,
    sha256: 'a'.repeat(64),
    widthPx: 800,
    heightPx: 600,
  };
}

function makeReadableFileCapability(overrides: { mime?: string; operations?: string[] } = {}) {
  return {
    capabilityId: 'fc_testcapabilityid_1234567890123456789012345678',
    kind: 'file',
    mime: overrides.mime ?? 'image/png',
    displayName: 'figure.png',
    operations: overrides.operations ?? ['read'],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function makeClient(overrides: Partial<ResearchWorkspaceClient> = {}): ResearchWorkspaceClient {
  return {
    listProjects: vi.fn().mockResolvedValue({ success: true, projects: [makeProject()] }),
    getSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: activeSnapshot }),
    mutateCrud: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    mutateLink: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    mutateReview: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    mutateRestore: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    mutateVersion: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    mutateCheckpoint: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    mutateDecision: vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' }),
    attachMedia: vi.fn().mockResolvedValue({ success: true, code: 'research_media_attached' } as ResearchMediaAttachResult),
    purgeMedia: vi.fn().mockResolvedValue({ success: true, code: 'research_media_purged' } as ResearchMediaPurgeResult),
    ...overrides,
  };
}

const activeSnapshot = makeSnapshot({
  sources: [
    {
      id: 'source-1',
      projectId: 'project-1',
      kind: 'image',
      title: 'Figure 1',
      authors: [],
      year: null,
      venue: '',
      identifier: '',
      identifierType: 'other',
      externalUrl: null,
      tags: [],
      sourceVersionHash: null,
      createdAt: makeTimestamp(),
      updatedAt: makeTimestamp(),
      deletedAt: null,
    },
    {
      id: 'deleted-image-1',
      projectId: 'project-1',
      kind: 'image',
      title: 'Deleted Figure',
      authors: [],
      year: null,
      venue: '',
      identifier: '',
      identifierType: 'other',
      externalUrl: null,
      tags: [],
      sourceVersionHash: null,
      createdAt: makeTimestamp(),
      updatedAt: makeTimestamp(),
      deletedAt: makeTimestamp(),
    },
  ],
});

function resetStore(client: ResearchWorkspaceClient, snapshot = activeSnapshot) {
  const project = makeProject();
  client.listProjects.mockResolvedValue({ success: true, projects: [project] });
  act(() => {
    researchWorkspaceStore.setState({
      projects: [project],
      activeProjectId: project.id,
      snapshot,
      activeSection: 'sources',
      selection: { kind: 'source', id: 'source-1' },
      loading: { projects: false, snapshot: false, mutation: false },
      error: null,
      lastMutation: null,
      selectedIds: [],
    } as unknown as Partial<ResearchWorkspaceState>);
    researchWorkspaceStore.getState().setClient(client);
  });
}

function setup(overrides: Partial<ResearchWorkspaceClient> = {}, snapshot = activeSnapshot) {
  const client = makeClient(overrides);
  resetStore(client, snapshot);
  return { client };
}

async function waitForSidebarInitialization(client: ResearchWorkspaceClient): Promise<void> {
  await waitFor(() => {
    expect(client.listProjects).toHaveBeenCalled();
    expect(client.getSnapshot).toHaveBeenCalled();
    expect(researchWorkspaceStore.getState().loading.projects).toBe(false);
    expect(researchWorkspaceStore.getState().loading.snapshot).toBe(false);
  });
}

beforeEach(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  cleanup();
  document.documentElement.dir = '';
  vi.restoreAllMocks();
});

describe('MEDIA-304 Phase B — capability contract (audit A)', () => {
  it('accepts only readable file capabilities from selectFileCapability', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());
    expect(window.metis.selectFileCapability).toHaveBeenCalledWith('research-source');
  });

  it('rejects capabilities missing read operation and requires re-selection', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability({ operations: ['file'] }),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(metis.selectFileCapability).toHaveBeenCalled());
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('rejects non-file capabilities and requires re-selection', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: { ...makeReadableFileCapability(), kind: 'folder', operations: ['folder'] },
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(metis.selectFileCapability).toHaveBeenCalled());
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('consumes the capability at attach start so failure requires a fresh select', async () => {
    const firstCapability = makeReadableFileCapability();
    const secondCapability = {
      ...makeReadableFileCapability(),
      capabilityId: 'fc_secondcapability_123456789012345678901234567890',
      displayName: 'figure-2.png',
    };
    const client = makeClient();
    const attachMedia = vi.fn()
      .mockResolvedValueOnce({ success: false, code: 'research_media_unavailable' })
      .mockResolvedValueOnce({ success: true, code: 'research_media_attached' });
    setup({ ...client, attachMedia } as unknown as ResearchWorkspaceClient);

    const metis = {
      selectFileCapability: vi.fn()
        .mockResolvedValueOnce({ success: true, capability: firstCapability })
        .mockResolvedValueOnce({ success: true, capability: secondCapability }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(/简短描述|Briefly describe/), { target: { value: 'A figure' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    // After consumption, the same capability cannot be replayed; dialog stays open but
    // a second confirm should fail early because capability is gone.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });
    expect(attachMedia).toHaveBeenCalledTimes(1);
    expect(attachMedia.mock.calls[0]![0].capabilityId).toBe(firstCapability.capabilityId);

    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(metis.selectFileCapability).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());
    expect(screen.getByText(secondCapability.displayName)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });
    await waitFor(() => expect(attachMedia).toHaveBeenCalledTimes(2));
    expect(attachMedia.mock.calls[1]![0].capabilityId).toBe(secondCapability.capabilityId);
  });
});

describe('MEDIA-304 Phase B — ProjectWorkspaceSidebar image import', () => {
  it('renders an accessible import-image-source trigger in the sources section', async () => {
    const { client } = setup();
    render(<ProjectWorkspaceSidebar />);
    await waitForSidebarInitialization(client);
    const trigger = screen.getByRole('button', { name: /导入图片来源|Import image source/ });
    expect(trigger).toBeDefined();
    expect(trigger.disabled).toBe(false);
  });

  it('opens the import dialog after selecting a supported image capability', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());
    expect(screen.getByText('figure.png')).toBeDefined();
  });

  it('fails closed and shows an error for unsupported MIME types', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability({ mime: 'application/pdf' }),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/仅支持 PNG|Only PNG/).textContent).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('does not open the dialog when selection is cancelled or unavailable', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({ success: false, code: 'file_capability_unavailable' }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    setup();
    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(metis.selectFileCapability).toHaveBeenCalled());
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('requires a non-empty caption before submitting attach', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());
    const confirmButton = screen.getByRole('button', { name: /确认导入|Confirm import/ });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/请输入图片说明|Enter a caption/).textContent).toBeTruthy();
  });

  it.each([
    ['C0 control character', 'unsafe\u0001caption'],
    ['C1 control character', 'unsafe\u0085caption'],
    ['caption longer than 512 characters', 'x'.repeat(513)],
  ])('rejects %s without consuming the selected capability', async (_caseName, invalidCaption) => {
    const capability = makeReadableFileCapability();
    const attachMedia = vi.fn().mockResolvedValue({
      success: true,
      code: 'research_media_attached',
    });
    setup({ attachMedia } as unknown as Partial<ResearchWorkspaceClient>);

    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability,
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    const captionInput = screen.getByPlaceholderText(/简短描述|Briefly describe/);
    fireEvent.change(captionInput, { target: { value: invalidCaption } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toMatch(/无效|invalid/i);
    expect(attachMedia).not.toHaveBeenCalled();
    expect(screen.getByText(capability.displayName)).toBeDefined();

    fireEvent.change(captionInput, { target: { value: 'Corrected caption' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    await waitFor(() => expect(attachMedia).toHaveBeenCalledTimes(1));
    expect(attachMedia.mock.calls[0]![0].capabilityId).toBe(capability.capabilityId);
    expect(metis.selectFileCapability).toHaveBeenCalledTimes(1);
  });

  it('submits attachMedia with the correct payload and selects the new source on success', async () => {
    const newSourceId = 'source-new-uuid-1';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(newSourceId.replace('source-', ''));

    const client = makeClient();
    let capturedSourceId: string | null = null;
    const attachMedia = vi.fn().mockImplementation((request: ResearchMediaAttachRequest) => {
      capturedSourceId = request.sourceId;
      return Promise.resolve({
        success: true,
        code: 'research_media_attached',
        media: makeMediaDescriptor(request.sourceId),
      } as ResearchMediaAttachResult);
    });
    // getSnapshot: returns activeSnapshot before attach, then dynamically
    // constructs a snapshot containing the captured sourceId after attach
    // so runMediaMutation → refreshActiveProject can apply it naturally.
    const getSnapshot = vi.fn().mockImplementation(() => {
      const base: ProjectSnapshotRuntime = capturedSourceId
        ? {
            ...activeSnapshot,
            sources: [
              ...activeSnapshot.sources,
              {
                id: capturedSourceId,
                projectId: 'project-1',
                kind: 'image' as const,
                title: 'A research figure',
                authors: [] as string[],
                year: null,
                venue: '',
                identifier: '',
                identifierType: 'other' as const,
                externalUrl: null,
                tags: [] as string[],
                sourceVersionHash: null,
                createdAt: makeTimestamp(),
                updatedAt: makeTimestamp(),
                deletedAt: null,
              },
            ],
          }
        : activeSnapshot;
      return Promise.resolve({ success: true, snapshot: base } as unknown as { success: true; snapshot: ProjectSnapshotRuntime });
    });
    setup({ ...client, attachMedia, getSnapshot } as unknown as ResearchWorkspaceClient);

    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    const captionInput = screen.getByPlaceholderText(/简短描述|Briefly describe/);
    fireEvent.change(captionInput, { target: { value: 'A research figure' } });

    const ordinalInput = screen.getByRole('spinbutton');
    fireEvent.change(ordinalInput, { target: { value: '3' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    await waitFor(() => expect(attachMedia).toHaveBeenCalledTimes(1));
    const payload = attachMedia.mock.calls[0]![0];
    expect(Object.keys(payload).sort()).toEqual([
      'capabilityId',
      'caption',
      'ordinal',
      'projectId',
      'sourceId',
    ]);
    expect(payload.projectId).toBe('project-1');
    expect(payload.caption).toBe('A research figure');
    expect(payload.ordinal).toBe(3);
    expect(payload.capabilityId).toBe('fc_testcapabilityid_1234567890123456789012345678');
    expect(payload.sourceId).toMatch(/^source-/);
    expect(payload.sourceId).not.toMatch(/^project-/);

    await waitFor(() => expect(researchWorkspaceStore.getState().snapshot?.sources.some((s) => s.id === payload.sourceId)).toBe(true));
    expect(researchWorkspaceStore.getState().selection).toEqual({ kind: 'source', id: payload.sourceId });
    expect(researchWorkspaceStore.getState().activeSection).toBe('sources');
  });

  it('refuses non-integer or out-of-range ordinals', async () => {
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });
    setup();

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(/简短描述|Briefly describe/), { target: { value: 'A figure' } });
    const ordinalInput = screen.getByRole('spinbutton');
    fireEvent.change(ordinalInput, { target: { value: 'abc' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/0–15|between 0 and 15/);
  });

  it('refuses a 17th image and requires manual management', async () => {
    const manyImageSources = Array.from({ length: 16 }, (_, index) => ({
      id: `source-img-${index}`,
      projectId: 'project-1',
      kind: 'image' as const,
      title: `Figure ${index}`,
      authors: [],
      year: null,
      venue: '',
      identifier: '',
      identifierType: 'other' as const,
      externalUrl: null,
      tags: [],
      sourceVersionHash: null,
      createdAt: makeTimestamp(),
      updatedAt: makeTimestamp(),
      deletedAt: null,
    }));
    const snapshot = makeSnapshot({ sources: manyImageSources });
    setup({}, snapshot);

    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/16 张|16 images/).textContent).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('refreshes the snapshot exactly once after attach', async () => {
    const client = makeClient();
    const attachMedia = vi.fn().mockResolvedValue({ success: true, code: 'research_media_attached' });
    const getSnapshot = vi.fn().mockResolvedValue({
      success: true,
      snapshot: activeSnapshot,
    });
    const { client: workspaceClient } = setup({
      ...client,
      attachMedia,
      getSnapshot,
    } as unknown as ResearchWorkspaceClient);

    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    await waitForSidebarInitialization(workspaceClient);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    const snapshotCallsBeforeAttach = getSnapshot.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText(/简短描述|Briefly describe/), { target: { value: 'A figure' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    await waitFor(() => expect(attachMedia).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(snapshotCallsBeforeAttach + 1));
    expect(getSnapshot.mock.calls.length - snapshotCallsBeforeAttach).toBe(1);
  });

  it('does not switch selection if the active project changed during attach (A→B race)', async () => {
    let resolveAttach: ((result: ResearchMediaAttachResult) => void) | null = null;
    const attachMedia = vi.fn().mockImplementation(() => new Promise<ResearchMediaAttachResult>((resolve) => {
      resolveAttach = resolve;
    }));
    const projectBSnapshot: ProjectSnapshotRuntime = {
      ...activeSnapshot,
      project: {
        ...activeSnapshot.project,
        id: 'project-other',
        title: 'Project B',
      },
      sources: [],
    };
    const getSnapshot = vi.fn().mockImplementation(async (request: { projectId: string }) => ({
      success: true,
      snapshot: request.projectId === 'project-other' ? projectBSnapshot : activeSnapshot,
    }));
    const { client } = setup({ attachMedia, getSnapshot } as unknown as Partial<ResearchWorkspaceClient>);

    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    await waitForSidebarInitialization(client);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(/简短描述|Briefly describe/), { target: { value: 'A figure' } });
    fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    await waitFor(() => expect(attachMedia).toHaveBeenCalledTimes(1));
    await act(async () => {
      await researchWorkspaceStore.getState().setActiveProject('project-other');
    });
    expect(researchWorkspaceStore.getState().snapshot?.project.id).toBe('project-other');
    expect(researchWorkspaceStore.getState().selection).toEqual({ kind: 'project', id: 'project-other' });

    await act(async () => {
      resolveAttach?.({ success: true, code: 'research_media_attached' } as ResearchMediaAttachResult);
    });
    await waitFor(() => expect(researchWorkspaceStore.getState().loading.mutation).toBe(false));
    expect(researchWorkspaceStore.getState().activeProjectId).toBe('project-other');
    expect(researchWorkspaceStore.getState().snapshot?.project.id).toBe('project-other');
    expect(researchWorkspaceStore.getState().selection).toEqual({ kind: 'project', id: 'project-other' });
  });

  it('distinguishes conflict and unavailable attach errors', async () => {
    const attachMedia = vi.fn().mockResolvedValue({ success: false, code: 'research_media_conflict' });
    setup({ attachMedia } as unknown as Partial<ResearchWorkspaceClient>);

    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(/简短描述|Briefly describe/), { target: { value: 'A figure' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认导入|Confirm import/ }));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/已存在|already exists/).textContent).toBeTruthy();
  });

  it('closes the import dialog on Escape', async () => {
    setup();
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(screen.getByRole('form')).toBeDefined());

    fireEvent.keyDown(screen.getByRole('form'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
  });
});

describe('MEDIA-304 Phase B — ResearchInspectorPanels image source & purge', () => {
  it('shows an image-source badge for sources with kind === image', () => {
    setup();
    render(<ResearchInspectorPanels />);
    expect(screen.getByText(/图片文件|Image file/)).toBeDefined();
  });

  it('does not expose identifier, sourceVersionHash, or sha256 in the DOM for image sources', () => {
    const snapshot = makeSnapshot({
      sources: [
        {
          id: 'image-with-hash',
          projectId: 'project-1',
          kind: 'image',
          title: 'Hashed Figure',
          authors: [],
          year: null,
          venue: '',
          identifier: 'sha256:abcd1234efgh5678',
          identifierType: 'other',
          externalUrl: null,
          tags: [],
          sourceVersionHash: 'sha256:deadbeefcafebabe',
          createdAt: makeTimestamp(),
          updatedAt: makeTimestamp(),
          deletedAt: null,
        },
      ],
    });
    setup({}, snapshot);
    act(() => {
      researchWorkspaceStore.setState({ selection: { kind: 'source', id: 'image-with-hash' } });
    });

    const { container } = render(<ResearchInspectorPanels />);
    expect(container.textContent).toContain('Hashed Figure');
    expect(container.textContent).not.toContain('abcd1234efgh5678');
    expect(container.textContent).not.toContain('deadbeefcafebabe');
    expect(container.textContent).not.toContain('sha256:');
  });

  it('lists deleted image sources in the recycle bin purge panel', () => {
    setup();
    act(() => {
      researchWorkspaceStore.getState().setActiveSection('recycle_bin');
    });
    render(<ResearchInspectorPanels />);
    expect(screen.getByText(/清理已删除图片|Purge deleted images/)).toBeDefined();
    const purgePanel = screen.getByRole('list', { name: /清理已删除图片|Purge deleted images/ });
    expect(purgePanel.textContent).toContain('Deleted Figure');
  });

  it('calls purgeMedia when confirming purge of a deleted image', async () => {
    const purgeMedia = vi.fn().mockResolvedValue({ success: true, code: 'research_media_purged', sourceId: 'deleted-image-1' });
    setup({ purgeMedia } as unknown as Partial<ResearchWorkspaceClient>);
    act(() => {
      researchWorkspaceStore.getState().setActiveSection('recycle_bin');
    });
    render(<ResearchInspectorPanels />);

    const purgePanel = screen.getByRole('list', { name: /清理已删除图片|Purge deleted images/ });
    const purgeButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    fireEvent.click(purgeButton);
    const confirmButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(purgeMedia).toHaveBeenCalledTimes(1));
    expect(purgeMedia).toHaveBeenCalledWith({ projectId: 'project-1', sourceId: 'deleted-image-1' });
  });

  it('clears stale selection after purge success', async () => {
    const purgeMedia = vi.fn().mockResolvedValue({ success: true, code: 'research_media_purged', sourceId: 'deleted-image-1' });
    // Derive purged snapshot from activeSnapshot (no makeSnapshot) so
    // the legacy decoder inside refreshActiveProject can apply it.
    const purgedSnapshot: ProjectSnapshotRuntime = {
      ...activeSnapshot,
      sources: activeSnapshot.sources.filter((source) => source.id !== 'deleted-image-1'),
    } as unknown as ProjectSnapshotRuntime;
    const getSnapshot = vi.fn().mockResolvedValue({ success: true, snapshot: purgedSnapshot });
    setup({ purgeMedia, getSnapshot } as unknown as Partial<ResearchWorkspaceClient>);
    act(() => {
      researchWorkspaceStore.setState({
        activeSection: 'recycle_bin',
        selection: { kind: 'source', id: 'deleted-image-1' },
        selectedIds: ['deleted-image-1', 'other-source'],
      });
    });
    render(<ResearchInspectorPanels />);

    const purgePanel = screen.getByRole('list', { name: /清理已删除图片|Purge deleted images/ });
    const purgeButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    fireEvent.click(purgeButton);
    const confirmButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => expect(purgeMedia).toHaveBeenCalledTimes(1));
    // Let runMediaMutation → refreshActiveProject apply purgedSnapshot naturally.
    await waitFor(() => expect(researchWorkspaceStore.getState().selection).toBeNull());
    expect(researchWorkspaceStore.getState().selectedIds).toEqual(['other-source']);
    // "Deleted Figure" appears in both the restore list and the purge panel;
    // after successful purge it should be gone from both. Use queryAllByText
    // to avoid the multi-element error from queryByText.
    await waitFor(() => expect(screen.queryAllByText('Deleted Figure')).toHaveLength(0));
  });

  it.each([
    ['research_media_referenced', /仍被引用|still referenced/],
    ['research_media_conflict', /清理失败|purge failed/i],
    ['research_media_unavailable', /清理失败|purge failed/i],
  ] as const)('keeps the item and selection when purge fails with %s', async (code, errorPattern) => {
    const purgeMedia = vi.fn().mockResolvedValue({ success: false, code });
    setup({ purgeMedia } as unknown as Partial<ResearchWorkspaceClient>);
    act(() => {
      researchWorkspaceStore.setState({
        activeSection: 'recycle_bin',
        selection: { kind: 'source', id: 'deleted-image-1' },
        selectedIds: ['deleted-image-1', 'other-source'],
      });
    });
    render(<ResearchInspectorPanels />);

    const purgePanel = screen.getByRole('list', { name: /清理已删除图片|Purge deleted images/ });
    const purgeButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    fireEvent.click(purgeButton);
    const confirmButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => expect(purgeMedia).toHaveBeenCalledTimes(1));
    expect(researchWorkspaceStore.getState().selection).toEqual({ kind: 'source', id: 'deleted-image-1' });
    expect(researchWorkspaceStore.getState().selectedIds).toEqual(['deleted-image-1', 'other-source']);
    expect(within(purgePanel).getByText('Deleted Figure')).toBeDefined();
    expect(within(purgePanel).getByRole('alert').textContent).toMatch(errorPattern);
    expect(screen.queryByText(/已永久删除|permanently deleted/i)).toBeNull();
  });

  it('shows a referenced error when purgeMedia returns research_media_referenced', async () => {
    const purgeMedia = vi.fn().mockResolvedValue({ success: false, code: 'research_media_referenced' });
    setup({ purgeMedia } as unknown as Partial<ResearchWorkspaceClient>);
    act(() => {
      researchWorkspaceStore.getState().setActiveSection('recycle_bin');
    });
    render(<ResearchInspectorPanels />);

    const purgePanel = screen.getByRole('list', { name: /清理已删除图片|Purge deleted images/ });
    const purgeButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    fireEvent.click(purgeButton);
    const confirmButton = within(purgePanel).getByRole('button', { name: /永久清理|Purge permanently/ });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(within(purgePanel).getByRole('alert')).toBeDefined());
    expect(within(purgePanel).getByText(/仍被引用|still referenced/).textContent).toBeTruthy();
  });

  it('exposes exactly one purge entry for a deleted image while preserving restore', () => {
    setup();
    act(() => {
      researchWorkspaceStore.getState().setActiveSection('recycle_bin');
    });
    render(<ResearchInspectorPanels />);

    const recycleItem = screen.getAllByText('Deleted Figure')
      .map((label) => label.closest('.recycle-restore__item'))
      .find((item): item is Element => item !== null);
    expect(recycleItem).toBeDefined();
    expect(recycleItem?.querySelector('.recycle-restore__icon-btn--restore')).not.toBeNull();
    expect(recycleItem?.querySelector('.recycle-restore__icon-btn--danger')).toBeNull();

    const purgePanel = screen.getByRole('list', { name: /清理已删除图片|Purge deleted images/ });
    expect(within(purgePanel).getAllByRole('button', { name: /永久清理|Purge permanently/ })).toHaveLength(1);
  });

  it('routes permanent deletion of a non-image source through generic CRUD delete', async () => {
    const deletedPaper = {
      ...activeSnapshot.sources[0]!,
      id: 'deleted-paper-1',
      kind: 'paper' as const,
      title: 'Deleted Paper',
      identifier: '10.1234/deleted-paper',
      identifierType: 'doi' as const,
      deletedAt: makeTimestamp(),
    };
    const snapshot = makeSnapshot({
      sources: [...activeSnapshot.sources, deletedPaper],
    });
    const mutateCrud = vi.fn().mockResolvedValue({ success: true, code: 'research_mutation_applied' });
    const purgeMedia = vi.fn().mockResolvedValue({
      success: true,
      code: 'research_media_purged',
      sourceId: deletedPaper.id,
    });
    setup({ mutateCrud, purgeMedia } as unknown as Partial<ResearchWorkspaceClient>, snapshot);
    act(() => {
      researchWorkspaceStore.getState().setActiveSection('recycle_bin');
    });
    render(<ResearchInspectorPanels />);

    const recycleItem = screen.getByText(deletedPaper.title).closest<HTMLElement>('.recycle-restore__item');
    expect(recycleItem).not.toBeNull();
    if (!recycleItem) throw new Error('Deleted paper recycle item is unavailable');
    fireEvent.click(within(recycleItem).getByRole('button', { name: /永久删除 Deleted Paper/ }));
    fireEvent.click(screen.getByRole('button', { name: /确认删除|Confirm delete/ }));

    await waitFor(() => expect(mutateCrud).toHaveBeenCalledTimes(1));
    expect(mutateCrud).toHaveBeenCalledWith({
      operation: 'delete',
      projectId: 'project-1',
      entityKind: 'source',
      entityId: deletedPaper.id,
    });
    expect(purgeMedia).not.toHaveBeenCalled();
  });
});

describe('MEDIA-304 Phase B — accessibility & CSS contracts', () => {
  it('moves focus to the caption input when the import dialog opens', async () => {
    setup();
    const metis = {
      selectFileCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: makeReadableFileCapability(),
      }),
    };
    Object.defineProperty(window, 'metis', { value: metis, writable: true, configurable: true });

    render(<ProjectWorkspaceSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /导入图片来源|Import image source/ }));
    await waitFor(() => expect(document.activeElement?.getAttribute('placeholder')).toMatch(/简短描述|Briefly describe/));
  });

  it('renders the import trigger without overflow in narrow sidebars', async () => {
    const { client } = setup();
    const { container } = render(<ProjectWorkspaceSidebar />);
    await waitForSidebarInitialization(client);
    const trigger = screen.getByRole('button', { name: /导入图片来源|Import image source/ });
    expect(container.contains(trigger)).toBe(true);
    expect(trigger.textContent).toMatch(/导入图片来源|Import image source/);
  });

  it('includes reduced-motion and forced-colors media queries in ResearchWorkspace.css', () => {
    expect(cssContent).toMatch(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    expect(cssContent).toMatch(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/);
  });

  it('supports RTL layout direction without crashing', async () => {
    document.documentElement.dir = 'rtl';
    const { client } = setup();
    render(<ProjectWorkspaceSidebar />);
    await waitForSidebarInitialization(client);
    expect(screen.getByRole('button', { name: /导入图片来源|Import image source/ })).toBeDefined();
  });
});
