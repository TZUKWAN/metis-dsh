/**
 * Free-model center (免费模型中心) + mailbox domain IPC registrar — Task 3 §4.
 * Migrated verbatim from `electron/main.ts` setupIPC(); channels, payloads and
 * recovery shapes unchanged. `freeModelService` arrives via the domain context
 * because the service is created during `app.whenReady()`.
 */

import type { DomainIpcContext } from './DomainIpcContext.js';
import { isRecord } from './sharedGuards.js';

export function registerFreeModelIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame } = ctx;
  const freeModelService = () => ctx.freeModelService();
  const dom = ctx.registry.domain('freeModel', ['freeModel:', 'mailbox:']);

  // ---- 免费模型中心 IPC（2026-08-23）----
  dom.handle('freeModel:listSources', (event) => {
    try { requireRendererMainFrame(event); return freeModelService()?.listSources() ?? []; } catch { return []; }
  });
  dom.handle('freeModel:addSource', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(raw)) return { ok: false, code: 'invalid_request' };
      return freeModelService()?.addSource({ name: String(raw.name ?? ''), baseUrl: String(raw.baseUrl ?? ''), apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined }) ?? { ok: false, code: 'unavailable' };
    } catch { return { ok: false, code: 'internal_error' }; }
  });
  dom.handle('freeModel:removeSource', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); if (!isRecord(raw)) return false; return freeModelService()?.removeSource(String(raw.id ?? '')) ?? false; } catch { return false; }
  });
  dom.handle('freeModel:scan', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const probe = isRecord(raw) && raw.probe === true;
      return await freeModelService()?.scanNow(probe) ?? { count: 0 };
    } catch { return { count: 0 }; }
  });
  dom.handle('freeModel:listDiscoveries', (event) => {
    try { requireRendererMainFrame(event); return freeModelService()?.listDiscoveries() ?? []; } catch { return []; }
  });
  dom.handle('freeModel:listAttached', (event) => {
    try { requireRendererMainFrame(event); return freeModelService()?.listAttached() ?? []; } catch { return []; }
  });
  dom.handle('freeModel:attach', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(raw) || typeof raw.discoveryKey !== 'string') return { ok: false, code: 'invalid_request' };
      return await freeModelService()?.attachModel(raw.discoveryKey) ?? { ok: false, code: 'unavailable' };
    } catch { return { ok: false, code: 'internal_error' }; }
  });
  dom.handle('freeModel:detach', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(raw) || typeof raw.profileId !== 'string') return { removedAttachment: false, deletedProfile: false };
      return await freeModelService()?.detachModel(raw.profileId) ?? { removedAttachment: false, deletedProfile: false };
    } catch { return { removedAttachment: false, deletedProfile: false }; }
  });
  dom.handle('freeModel:setDisabled', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(raw) || typeof raw.profileId !== 'string') return false;
      return freeModelService()?.setDisabled(raw.profileId, raw.disabled === true) ?? false;
    } catch { return false; }
  });
  dom.handle('freeModel:discoverCommunity', async (event) => {
    try {
      requireRendererMainFrame(event);
      return await freeModelService()?.discoverCommunitySources() ?? { found: 0, added: 0, stations: [] };
    } catch { return { found: 0, added: 0, stations: [] }; }
  });
  dom.handle('mailbox:add', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(raw)) return { ok: false, code: 'invalid_request' };
      return freeModelService()?.addMailbox({ kind: String(raw.kind ?? ''), label: typeof raw.label === 'string' ? raw.label : undefined, user: String(raw.user ?? ''), authorizationCode: String(raw.authorizationCode ?? '') }) ?? { ok: false, code: 'unavailable' };
    } catch { return { ok: false, code: 'internal_error' }; }
  });
  dom.handle('mailbox:list', (event) => {
    try { requireRendererMainFrame(event); return freeModelService()?.listMailboxes() ?? []; } catch { return []; }
  });
  dom.handle('mailbox:remove', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); if (!isRecord(raw)) return false; return freeModelService()?.removeMailbox(String(raw.id ?? '')) ?? false; } catch { return false; }
  });
  dom.handle('mailbox:testFetch', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(raw) || typeof raw.id !== 'string') return { ok: false, error: 'invalid_request' };
      return await freeModelService()?.testAndFetchMailbox(raw.id) ?? { ok: false, error: 'unavailable' };
    } catch { return { ok: false, error: 'internal_error' }; }
  });
  dom.handle('freeModel:autoRegisterBatch', async (event) => {
    try {
      requireRendererMainFrame(event);
      return await freeModelService()?.runAutoRegisterBatch() ?? { ok: false as const, code: 'unavailable' };
    } catch { return { ok: false as const, code: 'internal_error' }; }
  });
  dom.handle('freeModel:stationStates', (event) => {
    try { requireRendererMainFrame(event); return freeModelService()?.listStationStates() ?? {}; } catch { return {}; }
  });
  dom.handle('freeModel:omniRouteStatus', async (event) => {
    try {
      requireRendererMainFrame(event);
      return await freeModelService()?.omniRouteStatus() ?? { running: false, models: [], latencyMs: null, error: 'unavailable' };
    } catch { return { running: false, models: [], latencyMs: null, error: 'internal_error' }; }
  });
  dom.handle('freeModel:omniRouteStart', async (event) => {
    try {
      requireRendererMainFrame(event);
      return await freeModelService()?.omniRouteStart() ?? { running: false, models: [], latencyMs: null, started: false, error: 'unavailable' };
    } catch { return { running: false, models: [], latencyMs: null, started: false, error: 'internal_error' }; }
  });

  return () => dom.dispose();
}
