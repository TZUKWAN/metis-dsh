import { hashWorkspaceAgentsContent } from '../engine/memory/WorkspaceAgentsHash.js';
import {
  MetisRulesDefinitionSchema,
  PersonalizationIdSchema,
  type MetisRulesDefinition,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  WorkspaceAgentsViewSchema,
  type WorkspaceAgentsView,
} from '../engine/runtime/WorkspaceAgentsContract.js';

export type ProjectMetisRulesProjection =
  | { ok: true; projectRulesId?: string; definition?: MetisRulesDefinition }
  | { ok: false; code: 'invalid_view' | 'external_conflict' | 'content_hash_mismatch' };

export function projectMetisRulesId(projectId: string): string {
  return PersonalizationIdSchema.parse(`user:projects/${projectId}/metis-md`);
}

/**
 * Project Metis.md is authoritative file-backed user input.  It is projected
 * into a transient rules definition in Electron main rather than copied into a
 * second mutable store.  The run manifest still freezes the exact revision,
 * content digest, and Markdown bytes for independent session execution.
 */
export function projectMetisRulesFromWorkspace(
  rawView: WorkspaceAgentsView,
  expectedProjectId: string,
): ProjectMetisRulesProjection {
  const parsed = WorkspaceAgentsViewSchema.safeParse(rawView);
  if (!parsed.success || parsed.data.projectId !== expectedProjectId) {
    return { ok: false, code: 'invalid_view' };
  }
  const view = parsed.data;
  if (view.externalConflict) return { ok: false, code: 'external_conflict' };
  if (!view.exists) {
    return view.version === 0 && view.content === '' && view.contentHash === ''
      ? { ok: true }
      : { ok: false, code: 'invalid_view' };
  }
  if (view.version < 1 || view.contentHash !== hashWorkspaceAgentsContent(view.content)) {
    return view.version < 1
      ? { ok: false, code: 'invalid_view' }
      : { ok: false, code: 'content_hash_mismatch' };
  }
  if (view.content.length === 0) return { ok: true };

  let id: string;
  let scopeId: string;
  try {
    id = projectMetisRulesId(expectedProjectId);
    scopeId = PersonalizationIdSchema.parse(`user:projects/${expectedProjectId}`);
  } catch {
    return { ok: false, code: 'invalid_view' };
  }
  const definition = MetisRulesDefinitionSchema.safeParse({
    contractVersion: 1,
    id,
    kind: 'rules',
    name: 'Project Metis.md',
    description: 'Authoritative project rules projected from the CAS-protected Metis.md file.',
    enabled: true,
    tags: ['project', 'metis-md'],
    revision: view.version,
    provenance: {
      origin: 'user',
      author: 'Metis project workspace',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: view.contentHash,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: 0,
      updatedAt: 0,
    },
    scope: 'project',
    scopeId,
    markdown: view.content,
  });
  return definition.success
    ? { ok: true, projectRulesId: id, definition: definition.data }
    : { ok: false, code: 'invalid_view' };
}
