/**
 * WeChat Bot domain IPC registrar — Task 3 §4.
 * Migrated verbatim from `electron/main.ts` setupIPC(); the bot service
 * factory stays in the main process (it closes over the AI runtime and
 * secure storage) and arrives via the domain context.
 */

import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerWeChatIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, ensureWeChatBot } = ctx;
  const dom = ctx.registry.domain('wechat', ['wechat:']);

  // ── WeChat Bot (METIS-WX-1, iLink protocol — same as ZCode) ──
  dom.handle('wechat:getStatus', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      return service ? { ok: true, status: service.getStatus() } : { ok: false, error: 'wechat_unavailable' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  dom.handle('wechat:beginLogin', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      if (!service) return { ok: false, error: 'wechat_unavailable' };
      return await service.beginLogin();
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  dom.handle('wechat:pollLogin', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      if (!service) return { ok: false, phase: 'error', error: 'wechat_unavailable' };
      return await service.pollLogin();
    } catch {
      return { ok: false, phase: 'error', error: 'unauthorized_renderer' };
    }
  });
  dom.handle('wechat:submitVerifyCode', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      const request = rawRequest as { code?: string };
      if (!service || !request?.code) return { ok: false, error: 'wechat_unavailable' };
      service.submitVerifyCode(request.code);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  dom.handle('wechat:logout', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      if (!service) return { ok: false, error: 'wechat_unavailable' };
      await service.logout();
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  dom.handle('wechat:sendTest', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      const request = rawRequest as { text?: string };
      if (!service || !request?.text?.trim()) return { ok: false, error: 'wechat_unavailable' };
      return await service.sendTestMessage(request.text);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  dom.handle('wechat:setProject', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureWeChatBot();
      const request = rawRequest as { projectId?: string };
      if (!service || !request?.projectId) return { ok: false, error: 'wechat_unavailable' };
      service.setActiveProject(request.projectId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  return () => dom.dispose();
}
