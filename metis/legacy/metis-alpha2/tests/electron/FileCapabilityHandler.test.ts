import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
  executionOwnerFor,
  createFileCapabilityUseHandler,
  type FileCapabilityHandlerDeps,
} from '../../electron/FileCapabilityHandler.js';
import { FileCapabilityRegistry } from '../../electron/FileCapabilityRegistry.js';
import type {
  FileCapabilityUseRequest,
  FileCapabilityUseResult,
} from '../../engine/runtime/FileCapabilityContract.js';

const RENDERER_ENTRY_URL = 'http://127.0.0.1:5173/';
let currentMainWindow: BrowserWindow | null = null;

vi.mock(import('electron'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>();
  const mockShellOpenPath = vi.fn(() => Promise.resolve(''));
  return {
    ...actual,
    app: {
      ...actual.app,
      getPath: vi.fn(() => path.join(os.tmpdir(), 'metis-test-user-data')),
      setPath: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      isReady: vi.fn(() => true),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
    },
    shell: {
      ...actual.shell,
      openPath: mockShellOpenPath,
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    },
    BrowserWindow: Object.assign(
      function MockBrowserWindow(options?: { id?: number }) {
        const frame = {
          processId: 1,
          routingId: 1,
          url: RENDERER_ENTRY_URL,
        };
        const webContentsId = options?.id ?? 999;
        return {
          loadURL: vi.fn(),
          loadFile: vi.fn(),
          webContents: {
            mainFrame: frame,
            id: webContentsId,
            openDevTools: vi.fn(),
            getURL: () => RENDERER_ENTRY_URL,
            once: vi.fn(),
            on: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            session: {
              clearCache: vi.fn(() => Promise.resolve()),
            },
          },
          on: vi.fn(),
          isDestroyed: () => false,
        };
      },
      {
        ...actual.BrowserWindow,
        getAllWindows: vi.fn(() => []),
        fromWebContents: vi.fn(() => currentMainWindow),
      },
    ),
  };
});

const OWNER_A = {
  webContentsId: 101,
  mainFrameProcessId: 201,
  mainFrameRoutingId: 301,
} as const;
const OWNER_B = {
  webContentsId: 102,
  mainFrameProcessId: 202,
  mainFrameRoutingId: 302,
} as const;
const OWNER_A_RELOADED = {
  webContentsId: 101,
  mainFrameProcessId: 211,
  mainFrameRoutingId: 311,
} as const;

function fakeMainFrame(
  owner: { mainFrameProcessId: number; mainFrameRoutingId: number },
  url = RENDERER_ENTRY_URL,
) {
  return {
    processId: owner.mainFrameProcessId,
    routingId: owner.mainFrameRoutingId,
    url,
  };
}

function fakeEvent(
  owner: {
    webContentsId: number;
    mainFrameProcessId: number;
    mainFrameRoutingId: number;
  },
  frameOverride?: Record<string, unknown>,
): IpcMainInvokeEvent {
  const frame = frameOverride ?? fakeMainFrame(owner);
  return {
    sender: { id: owner.webContentsId, __mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}

function eventFor(
  owner: {
    webContentsId: number;
    mainFrameProcessId: number;
    mainFrameRoutingId: number;
  },
  win: BrowserWindow,
  frameOverride?: Record<string, unknown>,
): IpcMainInvokeEvent {
  const frame = frameOverride
    ?? (win as unknown as { webContents: { mainFrame: Record<string, unknown> } }).webContents.mainFrame;
  return {
    sender: { id: owner.webContentsId, __mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}

function makeWindow(
  owner: { webContentsId: number; mainFrameProcessId: number; mainFrameRoutingId: number },
  options?: { wrongUrl?: string; destroyed?: boolean },
): BrowserWindow {
  const win = new BrowserWindow({ id: owner.webContentsId });
  (win as unknown as { webContents: { mainFrame: ReturnType<typeof fakeMainFrame> } }).webContents.mainFrame = fakeMainFrame(
    owner,
    options?.wrongUrl,
  );
  if (options?.destroyed) {
    (win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
  }
  return win;
}

function rawUseRequest(request: FileCapabilityUseRequest): unknown {
  return request;
}

describe('fileCapability:use handler-level boundary', () => {
  let temporaryRoot: string;
  let filePath: string;
  let registry: FileCapabilityRegistry;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-file-handler-'));
    filePath = path.join(temporaryRoot, 'research.pdf');
    fs.writeFileSync(filePath, Buffer.from('pdf content'));
    registry = new FileCapabilityRegistry();
    currentMainWindow = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    registry.clear();
    currentMainWindow = null;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function issueCapability(owner: typeof OWNER_A) {
    const result = registry.issue({
      path: filePath,
      kind: 'file',
      mime: 'application/pdf',
      operations: ['read'],
      displayName: 'research.pdf',
    }, owner);
    expect(result.success).toBe(true);
    return result.capability!;
  }

  function makeDeps(overrides?: Partial<FileCapabilityHandlerDeps>): FileCapabilityHandlerDeps {
    return {
      getMainWindow: () => currentMainWindow,
      getRendererEntryUrl: () => RENDERER_ENTRY_URL,
      registry,
      ...overrides,
    };
  }

  async function invokeHandler(
    handler: (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => Promise<FileCapabilityUseResult>,
    event: IpcMainInvokeEvent,
    request: FileCapabilityUseRequest,
  ): Promise<FileCapabilityUseResult> {
    return handler(event, rawUseRequest(request));
  }

  it('factory handler is a function', () => {
    const handler = createFileCapabilityUseHandler(makeDeps());
    expect(typeof handler).toBe('function');
  });

  it('executionOwnerFor derives the canonical owner tuple from the main frame', () => {
    expect(executionOwnerFor(fakeEvent(OWNER_A))).toEqual({
      webContentsId: OWNER_A.webContentsId,
      mainFrameProcessId: OWNER_A.mainFrameProcessId,
      mainFrameRoutingId: OWNER_A.mainFrameRoutingId,
    });
  });

  it('rejects requests before main window is set and succeeds after it is set', async () => {
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);
    const request: FileCapabilityUseRequest = {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    };

    const before = await invokeHandler(handler, fakeEvent(OWNER_A), request);
    expect(before).toEqual({ success: false, code: 'file_capability_unavailable' });

    currentMainWindow = makeWindow(OWNER_A);
    const after = await invokeHandler(handler, eventFor(OWNER_A, currentMainWindow), request);
    expect(after.success).toBe(true);
    if (!after.success || after.operation !== 'read') return;
    expect(Buffer.from(after.data).toString()).toBe('pdf content');
  });

  it('rejects a subframe sender', async () => {
    currentMainWindow = makeWindow(OWNER_A);
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);
    const subframe = {
      ...(currentMainWindow as unknown as { webContents: { mainFrame: Record<string, unknown> } }).webContents.mainFrame,
      parent: { processId: 1, routingId: 1 },
    };

    const result = await invokeHandler(handler, eventFor(OWNER_A, currentMainWindow, subframe), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    });
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
  });

  it.each([
    ['exact entry URL', 'http://127.0.0.1:5173/', true],
    ['entry URL with hash', 'http://127.0.0.1:5173/#/dashboard', true],
    ['entry URL with trailing slash', 'http://127.0.0.1:5173/index.html', false],
    ['wrong port', 'http://127.0.0.1:9999/', false],
    ['wrong protocol', 'file:///C:/app/dist/index.html', false],
    ['https instead of http', 'https://127.0.0.1:5173/', false],
    ['query change', 'http://127.0.0.1:5173/?debug=1', false],
  ])('same-frame URL authorization matrix: %s', async (_, url, shouldSucceed) => {
    currentMainWindow = makeWindow(OWNER_A);
    (currentMainWindow as unknown as { webContents: { mainFrame: { url: string } } }).webContents.mainFrame.url = url;
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);

    const result = await invokeHandler(handler, eventFor(OWNER_A, currentMainWindow), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    });
    if (shouldSucceed) {
      expect(result.success).toBe(true);
    } else {
      expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
    }
  });

  it('rejects a malformed request with extra keys', async () => {
    currentMainWindow = makeWindow(OWNER_A);
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);

    const result = await handler(eventFor(OWNER_A, currentMainWindow), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
      extraKey: 'should be rejected',
    });
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
  });

  it('rejects a capability resolved by a different owner identity', async () => {
    currentMainWindow = makeWindow(OWNER_A);
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);

    const result = await invokeHandler(handler, eventFor(OWNER_B, currentMainWindow), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    });
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
  });

  it('rejects a reloaded frame with the same webContents but different process/routing tuple', async () => {
    currentMainWindow = makeWindow(OWNER_A);
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);

    const reloadedFrame = fakeMainFrame(OWNER_A_RELOADED);
    const result = await invokeHandler(handler, eventFor(OWNER_A_RELOADED, currentMainWindow, reloadedFrame), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    });
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
  });

  it('returns read payload for the legitimate owner', async () => {
    currentMainWindow = makeWindow(OWNER_A);
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);

    const result = await invokeHandler(handler, eventFor(OWNER_A, currentMainWindow), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    });
    expect(result.success).toBe(true);
    if (!result.success || result.operation !== 'read') return;
    expect(result.capability.capabilityId).toBe(capability.capabilityId);
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.data).toString()).toBe('pdf content');
  });

  it('recovers with a fixed failure value that does not leak the resolved path', async () => {
    currentMainWindow = makeWindow(OWNER_A);
    const handler = createFileCapabilityUseHandler(makeDeps());
    const capability = issueCapability(OWNER_A);

    // maxBytes below actual file size triggers execute failure, which must be recovered.
    const result = await invokeHandler(handler, eventFor(OWNER_A, currentMainWindow), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1,
    });
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
  });

  it('recovers from a thrown execute error without leaking exception details', async () => {
    class ThrowingRegistry extends FileCapabilityRegistry {
      resolve(): ReturnType<FileCapabilityRegistry['resolve']> {
        throw new Error('Boom: /secret.pdf leaked');
      }
    }
    currentMainWindow = makeWindow(OWNER_A);
    const throwingRegistry = new ThrowingRegistry();
    const handler = createFileCapabilityUseHandler({
      ...makeDeps(),
      registry: throwingRegistry,
    });
    const capability = issueCapability(OWNER_A);

    const result = await invokeHandler(handler, eventFor(OWNER_A, currentMainWindow), {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    });

    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('Boom');
    expect(rendered).not.toContain('/secret.pdf');
    expect(rendered).not.toContain('leaked');
  });
});
