/**
 * System domain IPC registrar (storage location / backup / clipboard /
 * flashcard) — Task 3 §4. Migrated verbatim from `electron/main.ts`
 * setupIPC(). The `update:*` channels deliberately stay in main.ts for now:
 * the auto-update trust lifecycle is an active parallel workstream.
 *
 * Storage-location handlers read the resolved data directory lazily through
 * the domain context (it binds after module init).
 */

import { app, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import {
  LOCATION_POINTER_VERSION,
  validateTargetLocation,
  writeLocationPointer,
} from '../StorageLocation.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSystemIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, store } = ctx;
  const DATA_DIR = (): string => ctx.dataDir();
  const dom = ctx.registry.domain('system', ['storage:', 'backup:', 'clipboard:', 'flashcard:', 'dialog:']);

  // ── Storage location (user-configurable data directory) ──────
  dom.handle('storage:getLocation', (event) => {
    try {
      requireRendererMainFrame(event);
      return {
        ok: true,
        dataDir: DATA_DIR(),
        defaultDir: ctx.defaultDataDir(),
        usingDefault: path.resolve(DATA_DIR()) === path.resolve(ctx.defaultDataDir()),
      };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  dom.handle('storage:chooseLocation', async (event) => {
    try {
      const win = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Metis data directory',
      });
      return { canceled: selected.canceled, path: selected.canceled ? undefined : selected.filePaths[0] };
    } catch {
      return { canceled: true, path: undefined };
    }
  });

  dom.handle('storage:setLocation', (event, rawTarget: unknown) => {
    try {
      requireRendererMainFrame(event);
      const target = typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim() : '';
      if (!target) return { ok: false, error: 'location_invalid_path' };
      const current = DATA_DIR();
      if (path.resolve(target) === path.resolve(current)) {
        return { ok: true, restarting: false, dataDir: current };
      }
      const validation = validateTargetLocation(target, ctx.userDataDir());
      if (!validation.ok) return { ok: false, error: `location_${validation.reason}` };
      const written = writeLocationPointer(ctx.userDataDir(), {
        version: LOCATION_POINTER_VERSION,
        dataDir: target,
        pendingMigrateFrom: current,
      });
      if (!written) return { ok: false, error: 'location_pointer_write_failed' };
      // Relaunch so the migration runs before any data handle is opened.
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 200);
      return { ok: true, restarting: true, dataDir: target };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  dom.handle('storage:openFolder', async (event) => {
    try {
      requireRendererMainFrame(event);
      const errorMessage = await shell.openPath(DATA_DIR());
      return { ok: !errorMessage, error: errorMessage || undefined };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── Backup management ──────────────────────────────────────
  dom.handle('backup:list', (event) => {
    try {
      requireRendererMainFrame(event);
      const backupService = ctx.backupService();
      if (!backupService) return { backups: [] };
      return { backups: backupService.listBackups().map((p) => ({ path: p, name: path.basename(p) })) };
    } catch {
      return { backups: [] };
    }
  });

  dom.handle('backup:restore', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const backupService = ctx.backupService();
      const request = rawRequest as { backupPath?: string };
      if (!backupService || !request?.backupPath) return { ok: false, error: 'backup_unavailable' };
      // P0-7: drain via the real RuntimeShutdownCoordinator (aborts agent
      // runs / scenario workflows / queued writers, awaits settlement with
      // the coordinator's own timeout). The restore aborts before the swap
      // when the drain times out.
      return backupService.restoreFrom(request.backupPath, {
        drain: async () => ctx.runtimeShutdown.drain(),
      });
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // 剪贴板只读回读（选区捕获失败时的 fallback；用户点击「引用」即授权）。
  dom.handle('clipboard:readText', (event) => {
    try {
      requireRendererMainFrame(event);
      return { ok: true, text: clipboard.readText() };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // 剪贴板写入（Context Package 发送；渲染层无可靠剪贴板写权限）。
  dom.handle('clipboard:writeText', (event, rawText: unknown) => {
    try {
      requireRendererMainFrame(event);
      const text = typeof rawText === 'string' ? rawText : '';
      if (!text) return { ok: false, error: 'empty_text' };
      clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── Flashcards (SQLite-backed via memory store) ──────────
  dom.handle('flashcard:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!store()) return { cards: [] };
      const entries = store()!.getMemoryByCategory('flashcard');
      return { cards: entries.map((e) => { try { return JSON.parse(e.value); } catch { return null; } }).filter(Boolean) };
    } catch {
      return { cards: [] };
    }
  });

  dom.handle('flashcard:save', (event, rawCard: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store()) return { ok: false };
      const card = rawCard as { id?: unknown; front?: unknown; back?: unknown; dueAt?: unknown; intervalDays?: unknown; createdAt?: unknown };
      if (typeof card?.id !== 'string') return { ok: false };
      store()!.setMemory(`flashcard:${card.id}`, JSON.stringify(card), 'flashcard');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  dom.handle('flashcard:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store()) return { ok: false };
      const id = typeof rawId === 'string' ? rawId : '';
      if (!id) return { ok: false };
      store()!.deleteMemory?.(`flashcard:${id}`);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // ── Reference file picker (scenario / personalization material import) ──
  // Contract (electron/preload.ts openReferenceFileDialog): resolves to a
  // list of chosen absolute paths; an empty array means the user cancelled or
  // the picker could not run. Multi-select is the point — consumers feed the
  // paths into importScenarioMaterials.
  dom.handle('dialog:openReferenceFiles', async (event) => {
    try {
      const win = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(win, {
        title: '选择参考文件',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '参考文档', extensions: ['md', 'txt', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'csv', 'html', 'htm', 'json', 'rtf'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (selected.canceled || selected.filePaths.length === 0) return [];
      return selected.filePaths;
    } catch {
      // Cancelled-by-exception (window destroyed, dialog unavailable) is
      // surfaced as "nothing picked" per the preload contract.
      return [];
    }
  });

  return () => dom.dispose();
}
