/**
 * dialog:openReferenceFiles — the reference-file picker registrar (P0-9).
 *
 * Contract (electron/preload.ts openReferenceFileDialog): resolves to
 * string[] of chosen absolute paths; [] means cancelled / picker unavailable.
 * Covers: multi-select, user cancel, dialog exception, unauthorized sender,
 * and the picker actually being owned by the system domain registrar.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const dialogMock = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/tmp/userdata', isPackaged: true },
  clipboard: { readText: vi.fn(async () => ''), writeText: vi.fn() },
  dialog: dialogMock,
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), listenerCount: () => 0 },
}));

import { IpcRegistry, type IpcMainLike } from '../../electron/ipc/IpcRegistry';
import { RuntimeShutdownCoordinator } from '../../electron/RuntimeShutdownCoordinator';
import { registerSystemIpc } from '../../electron/ipc/registerSystemIpc';
import type { DomainIpcContext } from '../../electron/ipc/DomainIpcContext';

function makeIpcMain(): IpcMainLike & { handlers: Map<string, unknown> } {
  const handlers = new Map<string, unknown>();
  return {
    handlers,
    handle(channel: string, listener: unknown) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) { handlers.delete(channel); },
    listenerCount(channel: string) { return handlers.has(channel) ? 1 : 0; },
  };
}

function makeEvent(): IpcMainInvokeEvent {
  return {
    sender: { id: 7, isDestroyed: () => false, send: () => undefined },
    senderFrame: { url: 'metis-app://bundle/index.html', processId: 1, routingId: 2 },
  } as unknown as IpcMainInvokeEvent;
}

function makeContext(ipcMain: ReturnType<typeof makeIpcMain>, requireRendererMainFrame?: unknown): DomainIpcContext {
  const registry = new IpcRegistry({ ipcMain, strict: true });
  return {
    registry,
    requireRendererMainFrame: requireRendererMainFrame ?? vi.fn(() => ({}) as never),
    runtimeShutdown: new RuntimeShutdownCoordinator(),
    agentLoop: () => null,
    ensureTopicService: vi.fn(),
    freeModelService: () => null,
    provider: () => null,
    store: () => null,
    researchRepository: () => null,
    providerProfileStore: () => null,
    experimentScriptAdapter: () => null,
    fileCapabilities: () => ({}) as never,
    ensureWeChatBot: () => null,
    browserService: () => null,
    collabService: () => null,
    ensureCollabService: () => null,
    dataDir: () => '/tmp/metis-test-data',
    userDataDir: () => '/tmp/metis-test-userdata',
    defaultDataDir: () => '/tmp/metis-test-userdata/metis-data',
    backupService: () => null,
  } as unknown as DomainIpcContext;
}

describe('dialog:openReferenceFiles (reference file picker)', () => {
  let handlers: Map<string, unknown>;
  let dispose: () => void;

  beforeEach(() => {
    dialogMock.showOpenDialog.mockReset();
    const ipcMain = makeIpcMain();
    handlers = ipcMain.handlers;
    dispose = registerSystemIpc(makeContext(ipcMain));
  });

  it('is owned by the system domain registrar', () => {
    expect(handlers.has('dialog:openReferenceFiles')).toBe(true);
  });

  it('returns the selected absolute paths on multi-select', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:/ref/a.pdf', 'C:/ref/b.md'] });
    const handler = handlers.get('dialog:openReferenceFiles') as (e: IpcMainInvokeEvent) => Promise<string[]>;
    await expect(handler(makeEvent())).resolves.toEqual(['C:/ref/a.pdf', 'C:/ref/b.md']);
    expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the user cancels', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = handlers.get('dialog:openReferenceFiles') as (e: IpcMainInvokeEvent) => Promise<string[]>;
    await expect(handler(makeEvent())).resolves.toEqual([]);
  });

  it('returns [] (never throws) when the dialog itself fails', async () => {
    dialogMock.showOpenDialog.mockRejectedValue(new Error('dialog unavailable'));
    const handler = handlers.get('dialog:openReferenceFiles') as (e: IpcMainInvokeEvent) => Promise<string[]>;
    await expect(handler(makeEvent())).resolves.toEqual([]);
  });

  it('returns [] for an unauthorized sender (main-frame guard)', async () => {
    const ipcMain = makeIpcMain();
    const guard = vi.fn(() => { throw new Error('unauthorized_renderer'); });
    registerSystemIpc(makeContext(ipcMain, guard));
    const handler = ipcMain.handlers.get('dialog:openReferenceFiles') as (e: IpcMainInvokeEvent) => Promise<string[]>;
    await expect(handler(makeEvent())).resolves.toEqual([]);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('unregisters with the domain disposer', () => {
    dispose();
    expect(handlers.has('dialog:openReferenceFiles')).toBe(false);
  });
});
