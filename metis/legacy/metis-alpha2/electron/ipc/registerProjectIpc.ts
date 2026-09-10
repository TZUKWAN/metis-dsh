/**
 * Project domain IPC registrar — Task 3 §4.
 * Migrated verbatim from `electron/main.ts` setupIPC(); archive format,
 * provider-override contract and recovery shapes unchanged.
 */

import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_ARCHIVE_EXT,
  PROJECT_ARCHIVE_LEGACY_EXTS,
  exportProjectArchive,
  importProjectArchive,
} from '../../engine/export/ProjectArchiveExporter.js';
import {
  decodeProjectProviderOverride,
  ProjectProviderOverrideSchema,
} from '../../engine/runtime/ProviderProfileContract.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerProjectIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, store, researchRepository, providerProfileStore } = ctx;
  const EXPORTS_DIR = (): string => path.join(ctx.dataDir(), 'exports');
  const IMPORTS_DIR = (): string => path.join(ctx.dataDir(), 'imports');
  const dom = ctx.registry.domain('project', ['project:']);

  // ── Complete project archive (METIS-F10) ───────────────────
  dom.handle('project:export', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { projectId?: string; destPath?: string };
      if (!store() || !researchRepository() || !request?.projectId) {
        return { ok: false, error: 'project_export_unavailable' };
      }
      fs.mkdirSync(EXPORTS_DIR(), { recursive: true });
      const destPath = request.destPath
        ?? path.join(EXPORTS_DIR(), `${request.projectId}-${new Date().toISOString().replace(/[:.]/g, '-')}${PROJECT_ARCHIVE_EXT}`);
      return await exportProjectArchive({
        db: store()!.raw,
        projectId: request.projectId,
        destPath,
        appVersion: app.getVersion(),
      });
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  dom.handle('project:import', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { archivePath?: string; projectId?: string; overwrite?: boolean };
      if (!store() || !request?.archivePath) return { ok: false, error: 'archive_path_required' };
      fs.mkdirSync(IMPORTS_DIR(), { recursive: true });
      return await importProjectArchive({
        db: store()!.raw,
        archivePath: request.archivePath,
        projectId: request.projectId,
        overwrite: request.overwrite,
        filesDir: IMPORTS_DIR(),
      });
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  dom.handle('project:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!researchRepository()) return { success: false, code: 'project_repository_unavailable' };
      const projects = researchRepository()!.listProjects().map((p) => ({
        id: p.id,
        title: p.title,
        updatedAt: p.updatedAt,
        archivedAt: p.archivedAt,
      }));
      return { success: true, projects };
    } catch {
      return { success: false, code: 'project_list_failed' };
    }
  });

  // ── O13: 项目级 provider/model 覆盖 ───────────────────────
  // 覆盖存于 projects.metadata.providerOverride；读取经 zod 校验，损坏数据
  // 一律视为无覆盖。写入只允许 contract 定义的字段。
  dom.handle('project:getProviderOverride', (event, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!researchRepository() || typeof rawProjectId !== 'string' || !rawProjectId) {
        return { ok: false as const, code: 'invalid_request' as const };
      }
      const override = researchRepository()!.getProjectProviderOverride(rawProjectId);
      return { ok: true as const, override };
    } catch {
      return { ok: false as const, code: 'invalid_request' as const };
    }
  });

  dom.handle('project:setProviderOverride', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { projectId?: unknown; override?: unknown };
      if (!researchRepository() || typeof request?.projectId !== 'string' || !request.projectId) {
        return { ok: false as const, code: 'invalid_request' as const };
      }
      // override 为 null 表示清除；否则必须通过 contract 校验。
      if (request.override === null) {
        const cleared = researchRepository()!.setProjectProviderOverride(request.projectId, null);
        return cleared ? { ok: true as const } : { ok: false as const, code: 'not_found' as const };
      }
      const parsed = ProjectProviderOverrideSchema.safeParse(request.override);
      if (!parsed.success || !decodeProjectProviderOverride(parsed.data)) {
        return { ok: false as const, code: 'invalid_request' as const };
      }
      // 引用的 profile 必须真实存在，防止写入悬空覆盖。
      if (parsed.data.providerProfileId) {
        const listed = providerProfileStore()?.list();
        const exists = listed?.ok === true && listed.value.profiles.some((p) => p.id === parsed.data.providerProfileId);
        if (!exists) return { ok: false as const, code: 'not_found' as const };
      }
      const saved = researchRepository()!.setProjectProviderOverride(request.projectId, parsed.data);
      return saved ? { ok: true as const } : { ok: false as const, code: 'not_found' as const };
    } catch {
      return { ok: false as const, code: 'invalid_request' as const };
    }
  });

  dom.handle('project:pickArchive', async (event) => {
    try {
      const win = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{
          name: 'Metis Project Archive',
          extensions: [PROJECT_ARCHIVE_EXT.slice(1), ...PROJECT_ARCHIVE_LEGACY_EXTS.map((ext) => ext.slice(1))],
        }],
      });
      return { canceled: selected.canceled, path: selected.canceled ? undefined : selected.filePaths[0] };
    } catch {
      return { canceled: true, path: undefined };
    }
  });

  return () => dom.dispose();
}
