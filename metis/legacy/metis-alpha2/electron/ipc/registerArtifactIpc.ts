/**
 * Artifact domain IPC registrar — Task 3 §4.
 * Migrated verbatim from `electron/main.ts` setupIPC(); channel names, decode
 * contracts, capability checks and recovery shapes unchanged.
 */

import {
  RuntimeIdSchema,
} from '../../engine/runtime/ChatRuntimeContract.js';
import {
  decodeArtifactContentRequest,
  decodeArtifactContentResponse,
  decodeArtifactCreateRequest,
  decodeArtifactCreatedNotification,
  decodeArtifactListResponse,
  decodeArtifactMutationResult,
} from '../../engine/runtime/ArtifactRuntimeContract.js';
import type { DomainIpcContext } from './DomainIpcContext.js';
import { executionOwnerFor, mimeForLocalFile } from './sharedGuards.js';

export function registerArtifactIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, store, researchRepository } = ctx;
  const fileCapabilities = () => ctx.fileCapabilities();
  const dom = ctx.registry.domain('artifact', ['artifact:']);

  // ── Artifacts ───────────────────────────────────────────
  dom.handle('artifact:create', (event, rawRecord: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decoded = decodeArtifactCreateRequest(rawRecord);
      if (!decoded.ok || !store()) return decodeArtifactMutationResult(null);
      const source = decoded.value.sourceCapabilityId
        ? fileCapabilities().resolve({
            capabilityId: decoded.value.sourceCapabilityId,
            operation: 'read',
            maxBytes: 1,
          }, owner)
        : undefined;
      if (source && !source.ok) return decodeArtifactMutationResult({ success: false, code: 'rejected' });
      const createdAt = Date.now();
      store()!.createArtifact({
        id: decoded.value.id,
        sessionId: decoded.value.sessionId,
        name: decoded.value.name,
        type: decoded.value.type,
        path: source?.ok ? source.resolvedPath : undefined,
        size: decoded.value.size,
        metadata: {},
      });
      const notification = decodeArtifactCreatedNotification({
        artifactId: decoded.value.id,
        sessionId: decoded.value.sessionId,
        name: decoded.value.name,
        type: decoded.value.type,
        size: decoded.value.size,
        contentAvailable: false,
        sourceCapability: source?.ok ? source.capability : undefined,
        createdAt,
      });
      if (notification.ok) event.sender.send('artifact:created', notification.value);
      return decodeArtifactMutationResult({ success: true, code: 'created' });
    } catch {
      return decodeArtifactMutationResult(null);
    }
  });
  dom.handle('artifact:list', (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const items = (store()?.listArtifacts(sessionId) ?? []).map((item) => {
        const issued = item.path
          ? fileCapabilities().issue({
              path: item.path,
              kind: 'file',
              mime: mimeForLocalFile(item.path),
              displayName: item.name,
              operations: ['file', 'folder', 'read', 'extract'],
            }, owner)
          : undefined;
        return {
          id: item.id,
          sessionId: item.sessionId,
          name: item.name,
          type: item.type,
          size: item.size,
          contentAvailable: item.contentAvailable,
          sourceCapability: issued?.success ? issued.capability : undefined,
          createdAt: item.createdAt,
        };
      });
      return decodeArtifactListResponse({ success: true, items });
    } catch {
      return decodeArtifactListResponse(null);
    }
  });
  dom.handle('artifact:get-content', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeArtifactContentRequest(rawRequest);
      if (!decoded.ok || !store()) return decodeArtifactContentResponse(null);
      const artifact = store()!.getArtifactContent(
        decoded.value.artifactId,
        decoded.value.sessionId,
      );
      if (!artifact) {
        return decodeArtifactContentResponse({ success: false, code: 'not_found' });
      }
      return decodeArtifactContentResponse({ success: true, ...artifact });
    } catch {
      return decodeArtifactContentResponse(null);
    }
  });
  dom.handle('artifact:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!store()) return decodeArtifactMutationResult(null);
      store()!.deleteArtifact(id);
      return decodeArtifactMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeArtifactMutationResult(null);
    }
  });

  // ── Project artifact management (research_artifacts, project-scoped) ──
  dom.handle('artifact:listByProject', (event, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
      if (!projectId || !researchRepository()) return { items: [] };
      const repository = researchRepository()!;
      const items = repository.listArtifacts(projectId).map((artifact) => {
        const current = repository.getArtifactVersion(artifact.id);
        const manifest = (current?.manifest ?? {}) as Record<string, unknown>;
        return {
          id: artifact.id,
          projectId: artifact.projectId,
          title: artifact.title,
          artifactType: artifact.artifactType,
          reviewStatus: artifact.reviewStatus,
          version: artifact.version,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          citedSourceIds: Array.isArray(manifest.citedSourceIds) ? manifest.citedSourceIds : [],
          reviewTrail: Array.isArray(manifest.reviewTrail) ? manifest.reviewTrail : [],
        };
      });
      return { items };
    } catch {
      return { items: [] };
    }
  });

  dom.handle('artifact:updateReviewStatus', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { artifactId?: unknown; toStatus?: unknown; reason?: unknown };
      const artifactId = typeof request?.artifactId === 'string' ? request.artifactId : '';
      const toStatus = typeof request?.toStatus === 'string' ? request.toStatus : '';
      const reason = typeof request?.reason === 'string' ? request.reason : '';
      const allowed = new Set(['draft', 'pending', 'partial', 'verified', 'stale']);
      if (!artifactId || !allowed.has(toStatus) || !researchRepository()) {
        return { ok: false, error: 'invalid_request' };
      }
      const updated = researchRepository()!.updateArtifactReviewStatus(artifactId, toStatus, reason || 'manual');
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'update_failed' };
    }
  });

  dom.handle('artifact:listVersions', (event, rawArtifactId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const artifactId = typeof rawArtifactId === 'string' ? rawArtifactId : '';
      if (!artifactId || !researchRepository()) return { versions: [] };
      const versions = researchRepository()!.listArtifactVersions(artifactId).map((record) => ({
        version: record.version,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        contentPreview: typeof record.content === 'string' ? record.content.slice(0, 2000) : '',
      }));
      return { versions };
    } catch {
      return { versions: [] };
    }
  });

  dom.handle('artifact:restoreVersion', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { artifactId?: unknown; version?: unknown };
      const artifactId = typeof request?.artifactId === 'string' ? request.artifactId : '';
      const version = typeof request?.version === 'number' ? request.version : 0;
      if (!artifactId || version < 1 || !researchRepository()) return { ok: false, error: 'invalid_request' };
      const restored = researchRepository()!.restoreArtifactVersion(artifactId, version);
      return restored ? { ok: true, version: restored.version } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'restore_failed' };
    }
  });

  return () => dom.dispose();
}
