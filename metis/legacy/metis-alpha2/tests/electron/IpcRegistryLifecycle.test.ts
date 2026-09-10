/**
 * Task 3 tests — IPC registry & domain registrar lifecycle.
 *
 * Covers the DoD items:
 *  1. IPC registry snapshot           (channel → owner ledger)
 *  2. duplicate channel gate          (strict mode throws, loose mode records)
 *  3. unauthorized sender             (registrar recovers with fixed shape)
 *  4. invalid/oversized payload       (schema-violating payloads recover)
 *  5. exception sanitization          (domain throw never leaks its message)
 *  6. listener dispose                (disposer removes handler + ledger entry)
 *  9. renderer destroyed send safety  (stream forwarding skips dead senders)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IpcRegistry, IpcRegistrationError, type IpcMainLike } from '../../electron/ipc/IpcRegistry';
import { RuntimeShutdownCoordinator } from '../../electron/RuntimeShutdownCoordinator';
import { registerTopicIpc } from '../../electron/ipc/registerTopicIpc';
import { registerFreeModelIpc } from '../../electron/ipc/registerFreeModelIpc';
import type { DomainIpcContext } from '../../electron/ipc/DomainIpcContext';

function makeIpcMain(): IpcMainLike & { handlers: Map<string, unknown> } {
  const handlers = new Map<string, unknown>();
  return {
    handlers,
    handle(channel: string, listener: unknown) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for channel '${channel}'`);
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    listenerCount(channel: string) {
      return handlers.has(channel) ? 1 : 0;
    },
  };
}

function makeEvent(senderOverrides: Partial<{ isDestroyed(): boolean; send(ch: string, payload: unknown): void }> = {}): IpcMainInvokeEvent {
  return {
    sender: {
      id: 7,
      isDestroyed: senderOverrides.isDestroyed ?? (() => false),
      send: senderOverrides.send ?? (() => undefined),
    },
    senderFrame: { url: 'metis-app://bundle/index.html', processId: 1, routingId: 2 },
  } as unknown as IpcMainInvokeEvent;
}

function makeContext(ipcMain: ReturnType<typeof makeIpcMain>, overrides: Partial<DomainIpcContext> = {}): DomainIpcContext {
  const registry = new IpcRegistry({ ipcMain, strict: true });
  return {
    registry,
    requireRendererMainFrame: vi.fn(() => ({}) as never),
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
    ...overrides,
  } as DomainIpcContext;
}

// ── 1 + 2: registry snapshot & duplicate gate ─────────────────
describe('IpcRegistry ledger', () => {
  let ipcMain: ReturnType<typeof makeIpcMain>;
  beforeEach(() => {
    ipcMain = makeIpcMain();
  });

  it('builds a sorted channel→owner snapshot across domains', () => {
    const ctx = makeContext(ipcMain);
    const disposeTopic = registerTopicIpc(ctx);
    const disposeFreeModel = registerFreeModelIpc(ctx);
    const snapshot = ctx.registry.snapshot();
    const owners = new Map(snapshot.entries.map((e) => [e.channel, e.owner]));
    expect(owners.get('topic:sessions:create')).toBe('topic');
    expect(owners.get('topic:chat')).toBe('topic');
    expect(owners.get('freeModel:listSources')).toBe('freeModel');
    expect(owners.get('mailbox:add')).toBe('freeModel');
    expect(snapshot.entries).toEqual([...snapshot.entries].sort((a, b) => a.channel.localeCompare(b.channel)));
    expect(snapshot.conflicts).toEqual([]);
    expect(ctx.registry.channelsByOwner('topic')).toHaveLength(10);
    disposeTopic();
    disposeFreeModel();
  });

  it('throws in strict mode when a channel is registered twice', () => {
    const ctx = makeContext(ipcMain);
    const dispose = registerTopicIpc(ctx);
    expect(() => registerTopicIpc(ctx)).toThrowError(IpcRegistrationError);
    dispose();
  });

  it('throws when a registrar claims a channel outside its declared prefixes', () => {
    const ctx = makeContext(ipcMain);
    const dom = ctx.registry.domain('topic', ['topic:']);
    expect(() => dom.handle('outcomes:list', () => null)).toThrowError(/channel_prefix_mismatch/);
  });

  it('rejects registration when a non-registry listener already owns the channel', () => {
    const ctx = makeContext(ipcMain);
    // Simulate a legacy direct ipcMain.handle registration.
    ipcMain.handle('topic:sessions:create', () => null);
    expect(() => registerTopicIpc(ctx)).toThrowError(/existing_electron_listener/);
  });

  it('disposeAll removes every channel and clears the ledger', () => {
    const ctx = makeContext(ipcMain);
    registerTopicIpc(ctx);
    expect(ipcMain.handlers.size).toBe(10);
    ctx.registry.disposeAll();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ctx.registry.snapshot().entries).toEqual([]);
  });
});

// ── 3 + 4 + 5: auth, payload, sanitization via migrated handlers ──
describe('registerTopicIpc handler behavior (migrated)', () => {
  let ipcMain: ReturnType<typeof makeIpcMain>;
  let ctx: DomainIpcContext;
  beforeEach(() => {
    ipcMain = makeIpcMain();
    ctx = makeContext(ipcMain);
    registerTopicIpc(ctx);
  });

  it('recovers with the fixed unauthorized shape when auth fails (item 3)', async () => {
    (ctx.requireRendererMainFrame as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Unauthorized IPC sender');
    });
    const handler = ipcMain.handlers.get('topic:sessions:create') as (e: unknown, raw: unknown) => unknown;
    expect(handler(makeEvent(), {})).toEqual({ ok: false, code: 'create_failed' });
    const list = ipcMain.handlers.get('topic:sessions:list') as (e: unknown) => unknown;
    expect(list(makeEvent())).toEqual([]);
  });

  it('recovers on schema-invalid payloads (item 4)', async () => {
    const getDetail = ipcMain.handlers.get('topic:sessions:get') as (e: unknown, raw: unknown) => unknown;
    // payload is not an object / sessionId missing
    expect(getDetail(makeEvent(), { nope: true })).toBeNull();
    expect(getDetail(makeEvent(), 'a string')).toBeNull();
    // oversized sessionId (>160) is rejected by the bounded schema
    expect(getDetail(makeEvent(), { sessionId: 'x'.repeat(500) })).toBeNull();
  });

  it('never reflects a domain exception message to the renderer (item 5)', async () => {
    (ctx.ensureTopicService as ReturnType<typeof vi.fn>).mockReturnValue({
      createSession: () => {
        throw new Error('SQLITE_CORRUPT: secret page /home/me/secret.db leaked');
      },
    });
    const handler = ipcMain.handlers.get('topic:sessions:create') as (e: unknown, raw: unknown) => unknown;
    const result = (await handler(makeEvent(), {})) as { ok: boolean; code: string };
    expect(result).toEqual({ ok: false, code: 'create_failed' });
    expect(JSON.stringify(result)).not.toContain('SQLITE_CORRUPT');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('routes admitted chat turns and forwards stream tokens (item 9)', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const unregisterHook = vi.fn();
    const agentLoopMock = {
      registerHook: vi.fn(),
      unregisterHook,
    };
    (ctx.agentLoop as ReturnType<typeof vi.fn>) = vi.fn(() => agentLoopMock as never);
    // re-register with the live agentLoop mock (previous registration closed over the old getter)
    ipcMain = makeIpcMain();
    ctx = makeContext(ipcMain, {
      agentLoop: () => agentLoopMock as never,
      ensureTopicService: vi.fn().mockReturnValue({
        chat: vi.fn().mockResolvedValue({ ok: true, answer: 'done' }),
      }),
    } as Partial<DomainIpcContext>);
    const dispose = registerTopicIpc(ctx);

    // capture the stream hook registered on the agent loop and fire it.
    agentLoopMock.registerHook.mockImplementation((_type: string, hook: (c: unknown) => unknown) => {
      void hook; // the registrar registers the hook; invocation happens below
    });
    const handler = ipcMain.handlers.get('topic:chat') as (e: unknown, raw: unknown) => unknown;
    const event = makeEvent({
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    });
    const rawRequest = { sessionId: 's1', message: 'hello' };
    // simulate the token forwarding hook by grabbing it from registerHook args
    let capturedHook: ((c: unknown) => unknown) | null = null;
    agentLoopMock.registerHook.mockImplementation((_type: string, hook: (c: unknown) => unknown) => {
      capturedHook = hook;
    });
    const chatMock = (ctx.ensureTopicService as ReturnType<typeof vi.fn>).mock.results.length
      ? null
      : null;
    void chatMock;
    const promise = handler(event, rawRequest) as Promise<unknown>;
    // hook registration happens synchronously before the service call resolves
    await Promise.resolve();
    expect(capturedHook).not.toBeNull();
    capturedHook!({ sessionId: 'topic_s1', content: 'tok', isFinished: false });
    capturedHook!({ sessionId: 'other_session', content: 'must-not-leak', isFinished: false });
    await promise;
    expect(sent).toEqual([
      { channel: 'topic:stream-chunk', payload: { sessionId: 's1', content: 'tok', reasoning: undefined, isFinished: false } },
    ]);
    expect(unregisterHook).toHaveBeenCalled();
    dispose();
  });

  it('does not send stream tokens to a destroyed renderer (item 9)', async () => {
    const send = vi.fn();
    const agentMock = { registerHook: vi.fn(), unregisterHook: vi.fn() };
    ipcMain = makeIpcMain();
    ctx = makeContext(ipcMain, {
      agentLoop: () => agentMock as never,
      ensureTopicService: vi.fn().mockReturnValue({ chat: vi.fn().mockResolvedValue({ ok: true }) }),
    } as Partial<DomainIpcContext>);
    const dispose = registerTopicIpc(ctx);
    let capturedHook: ((c: unknown) => unknown) | null = null;
    agentMock.registerHook.mockImplementation((_t: string, h: (c: unknown) => unknown) => { capturedHook = h; });
    const handler = ipcMain.handlers.get('topic:chat') as (e: unknown, raw: unknown) => unknown;
    const event = makeEvent({ isDestroyed: () => true, send });
    const p = handler(event, { sessionId: 's1', message: 'hello' }) as Promise<unknown>;
    await Promise.resolve();
    capturedHook!({ sessionId: 'topic_s1', content: 'tok', isFinished: false });
    await p;
    expect(send).not.toHaveBeenCalled();
    dispose();
  });
});

// ── 6: listener dispose (open/close cycles) ───────────────────
describe('registrar dispose cycles (item 6)', () => {
  it('survives 100 register/dispose cycles without duplicate-channel errors', () => {
    const ipcMain = makeIpcMain();
    const ctx = makeContext(ipcMain);
    for (let cycle = 0; cycle < 100; cycle++) {
      const dispose = registerTopicIpc(ctx);
      expect(ctx.registry.snapshot().entries).toHaveLength(10);
      dispose();
      expect(ctx.registry.snapshot().entries).toHaveLength(0);
    }
    expect(ipcMain.handlers.size).toBe(0);
  });

  it('a registrar disposer removes only its own channels', () => {
    const ipcMain = makeIpcMain();
    const ctx = makeContext(ipcMain);
    const disposeTopic = registerTopicIpc(ctx);
    const disposeFreeModel = registerFreeModelIpc(ctx);
    disposeTopic();
    expect(ctx.registry.ownerOf('topic:select')).toBeNull();
    expect(ctx.registry.ownerOf('freeModel:scan')).toBe('freeModel');
    disposeFreeModel();
    expect(ctx.registry.snapshot().entries).toHaveLength(0);
  });
});
