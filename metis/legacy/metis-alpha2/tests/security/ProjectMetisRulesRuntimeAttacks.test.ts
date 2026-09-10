import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentChatOptionsSchema } from '../../engine/runtime/ChatRuntimeContract.js';
import {
  WorkspaceAgentsManager,
  workspaceProjectDirectoryName,
} from '../../engine/memory/WorkspaceAgentsManager.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { MetisRulesDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  projectMetisRulesFromWorkspace,
  projectMetisRulesId,
} from '../../electron/ProjectMetisRulesBridge.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';

const SCENARIO_ID = 'builtin:scenarios/general-research';
const MANIFEST_SECRET = Buffer.alloc(32, 0x5a);
const roots: string[] = [];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function legacyManifestTag(manifest: unknown): string {
  return createHmac('sha256', MANIFEST_SECRET)
    .update('metis:personalization-run-manifest:v1\0')
    .update(canonicalJson(manifest), 'utf8')
    .digest('hex');
}

function currentManifestTag(manifest: unknown): string {
  return createHmac('sha256', MANIFEST_SECRET)
    .update('metis:personalization-run-manifest:v2\0')
    .update(canonicalJson(manifest), 'utf8')
    .digest('hex');
}

function projectRule(projectId: string, markdown: string, version: number) {
  return projectMetisRulesFromWorkspace({
    exists: true,
    content: markdown,
    version,
    contentHash: hashWorkspaceAgentsContent(markdown),
    projectId,
  }, projectId);
}

describe('Project Metis.md runtime attacks', () => {
  let db: Database.Database;
  let repository: PersonalizationRepository;
  let service: PersonalizationRuntimeService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new PersonalizationRepository(db);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    service = new PersonalizationRuntimeService(repository, MANIFEST_SECRET);
  });

  afterEach(() => {
    db.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')(
    'does not alias case-distinct project IDs onto the same Windows workspace',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-case-'));
      roots.push(root);
      const upper = new WorkspaceAgentsManager(root, 'ProjectAlpha');
      const secret = '# Metis.md\n\n- ProjectAlpha private rule.\n';
      expect(upper.write(secret, 0)).toMatchObject({ success: true, version: 1 });

      const lower = new WorkspaceAgentsManager(root, 'projectalpha');
      const lowerView = lower.read();
      expect(lowerView.exists).toBe(false);
      expect(lowerView.content).not.toContain('ProjectAlpha private rule');
    },
  );

  it('moves an exact legacy project directory without losing its committed rule', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-legacy-content-'));
    roots.push(root);
    const projectId = 'legacy-content-project';
    const seeded = new WorkspaceAgentsManager(root, projectId);
    const rule = '# Metis.md\n\n- LEGACY-CONTENT-MUST-SURVIVE.\n';
    expect(seeded.write(rule, 0)).toMatchObject({ success: true, version: 1 });

    const legacyDirectory = path.join(root, 'projects', projectId);
    fs.mkdirSync(path.dirname(legacyDirectory), { recursive: true });
    fs.renameSync(seeded.workspaceRoot, legacyDirectory);

    const migrated = new WorkspaceAgentsManager(root, projectId);
    expect(migrated.read()).toMatchObject({
      exists: true,
      version: 1,
      content: rule,
      projectId,
    });
    expect(fs.existsSync(legacyDirectory)).toBe(false);
    expect(fs.existsSync(migrated.workspaceRoot)).toBe(true);
  });

  it('does not let a project ID impersonate another project canonical directory name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-digest-id-'));
    roots.push(root);
    const victimId = 'victim-project';
    const victim = new WorkspaceAgentsManager(root, victimId);
    const secret = '# Metis.md\n\n- VICTIM-DIGEST-NAMESPACE-SECRET.\n';
    expect(victim.write(secret, 0)).toMatchObject({ success: true, version: 1 });

    const attackerId = workspaceProjectDirectoryName(victimId);
    let attacker: WorkspaceAgentsManager;
    try {
      attacker = new WorkspaceAgentsManager(root, attackerId);
    } catch {
      // A failed migration must not leave a moved directory that becomes
      // claimable on retry.
      attacker = new WorkspaceAgentsManager(root, attackerId);
    }
    const attackerView = attacker.read();
    expect(attackerView.exists).toBe(false);
    expect(attackerView.content).not.toContain('VICTIM-DIGEST-NAMESPACE-SECRET');
    expect(victim.read().content).toContain('VICTIM-DIGEST-NAMESPACE-SECRET');
  });

  it.runIf(process.platform === 'win32')(
    'migrates an exact legacy project directory without a post-rename partial failure',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-legacy-migrate-'));
      roots.push(root);
      fs.mkdirSync(path.join(root, 'projects', 'legacy-project'), { recursive: true });
      expect(() => new WorkspaceAgentsManager(root, 'legacy-project')).not.toThrow();
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not alias a trailing-dot project ID onto another Windows workspace',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-dot-'));
      roots.push(root);
      const canonical = new WorkspaceAgentsManager(root, 'project-dot');
      const secret = '# Metis.md\n\n- project-dot private rule.\n';
      expect(canonical.write(secret, 0)).toMatchObject({ success: true, version: 1 });

      const aliased = new WorkspaceAgentsManager(root, 'project-dot.');
      const aliasedView = aliased.read();
      expect(aliasedView.exists).toBe(false);
      expect(aliasedView.content).not.toContain('project-dot private rule');
    },
  );

  it('rejects a project-A overlay for project B and never reuses A prompt bytes in B', () => {
    const alphaMarkdown = '# Metis.md\n\n- ALPHA-ONLY-RULE.\n';
    const betaMarkdown = '# Metis.md\n\n- BETA-ONLY-RULE.\n';
    const alpha = projectRule('project-alpha', alphaMarkdown, 1);
    const beta = projectRule('project-beta', betaMarkdown, 1);
    expect(alpha.ok && alpha.definition && alpha.projectRulesId).toBeTruthy();
    expect(beta.ok && beta.definition && beta.projectRulesId).toBeTruthy();
    if (!alpha.ok || !alpha.definition || !alpha.projectRulesId
      || !beta.ok || !beta.definition || !beta.projectRulesId) return;

    expect(service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'shared-session',
      projectId: 'project-beta',
      scenarioId: SCENARIO_ID,
      projectRulesId: alpha.projectRulesId,
    }, alpha.definition)).toBeUndefined();

    const first = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'shared-session',
      projectId: 'project-alpha',
      scenarioId: SCENARIO_ID,
      projectRulesId: alpha.projectRulesId,
    }, alpha.definition);
    const second = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'shared-session',
      projectId: 'project-beta',
      scenarioId: SCENARIO_ID,
      projectRulesId: beta.projectRulesId,
    }, beta.definition);

    expect(first?.systemPrompt).toContain('ALPHA-ONLY-RULE');
    expect(second?.systemPrompt).toContain('BETA-ONLY-RULE');
    expect(second?.systemPrompt).not.toContain('ALPHA-ONLY-RULE');
    expect(second?.manifest.projectId).toBe('project-beta');
  });

  it('invalidates cached project layers on same-revision content changes, revision changes, and deletion', () => {
    const projectId = 'project-cache';
    const first = projectRule(projectId, '# Metis.md\n\n- CACHE-V1-A.\n', 1);
    const sameRevisionChanged = projectRule(projectId, '# Metis.md\n\n- CACHE-V1-B.\n', 1);
    const newRevisionSameContent = projectRule(projectId, '# Metis.md\n\n- CACHE-V1-B.\n', 2);
    expect(first.ok && first.definition && first.projectRulesId).toBeTruthy();
    expect(sameRevisionChanged.ok && sameRevisionChanged.definition).toBeTruthy();
    expect(newRevisionSameContent.ok && newRevisionSameContent.definition).toBeTruthy();
    if (!first.ok || !first.definition || !first.projectRulesId
      || !sameRevisionChanged.ok || !sameRevisionChanged.definition
      || !newRevisionSameContent.ok || !newRevisionSameContent.definition) return;
    const request = {
      contractVersion: 1 as const,
      sessionId: 'cache-session',
      projectId,
      scenarioId: SCENARIO_ID,
      projectRulesId: first.projectRulesId,
    };

    const manifestA = service.resolveForAgent(request, first.definition);
    const manifestB = service.resolveForAgent(request, sameRevisionChanged.definition);
    const manifestRevision2 = service.resolveForAgent(request, newRevisionSameContent.definition);
    const afterDelete = service.resolveForAgent({
      contractVersion: 1,
      sessionId: request.sessionId,
      projectId,
      scenarioId: SCENARIO_ID,
    });

    expect(manifestB?.manifest.manifestDigest).not.toBe(manifestA?.manifest.manifestDigest);
    expect(manifestB?.systemPrompt).toContain('CACHE-V1-B');
    expect(manifestB?.systemPrompt).not.toContain('CACHE-V1-A');
    expect(manifestRevision2?.manifest.manifestDigest).not.toBe(manifestB?.manifest.manifestDigest);
    expect(manifestRevision2?.manifest.definitionRevisions[first.projectRulesId]).toBe(2);
    expect(afterDelete?.manifest.promptStack.some((layer) => layer.precedence === 500)).toBe(false);
    expect(afterDelete?.systemPrompt).not.toContain('CACHE-V1-B');
  });

  it('fails closed for hash/conflict attacks and does not accept a renderer-authored projectRulesId option', () => {
    const projectId = 'project-integrity';
    const markdown = '# Metis.md\n\n- INTEGRITY-RULE.\n';
    expect(projectMetisRulesFromWorkspace({
      exists: true,
      content: markdown,
      version: 1,
      contentHash: 'a'.repeat(64),
      projectId,
    }, projectId)).toEqual({ ok: false, code: 'content_hash_mismatch' });
    expect(projectMetisRulesFromWorkspace({
      exists: true,
      content: markdown,
      version: 1,
      contentHash: hashWorkspaceAgentsContent(markdown),
      externalConflict: true,
      projectId,
    }, projectId)).toEqual({ ok: false, code: 'external_conflict' });
    expect(projectMetisRulesFromWorkspace({
      exists: false,
      content: '',
      version: 0,
      contentHash: 'a'.repeat(64),
      projectId,
    }, projectId)).toEqual({ ok: false, code: 'invalid_view' });

    expect(AgentChatOptionsSchema.safeParse({
      mode: 'send',
      projectId,
      scenarioId: SCENARIO_ID,
      projectRulesId: projectMetisRulesId(projectId),
    }).success).toBe(false);
  });

  it('propagates a real external Metis.md edit as a blocking conflict', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-conflict-'));
    roots.push(root);
    const projectId = 'project-conflict';
    const manager = new WorkspaceAgentsManager(root, projectId);
    const original = '# Metis.md\n\n- ORIGINAL-AUTHORITATIVE-RULE.\n';
    expect(manager.write(original, 0)).toMatchObject({ success: true, version: 1 });

    fs.writeFileSync(
      path.join(manager.workspaceRoot, 'Metis.md'),
      '# Metis.md\n\n- EXTERNAL-UNVERSIONED-EDIT.\n',
      'utf8',
    );
    const conflicted = manager.read();
    expect(conflicted.externalConflict).toBe(true);
    expect(projectMetisRulesFromWorkspace(conflicted, projectId))
      .toEqual({ ok: false, code: 'external_conflict' });
  });

  it('does not keep projecting an old rule after the authoritative Metis.md file is deleted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-delete-'));
    roots.push(root);
    const projectId = 'project-delete';
    const manager = new WorkspaceAgentsManager(root, projectId);
    const oldRule = '# Metis.md\n\n- DELETED-RULE-MUST-NOT-SURVIVE.\n';
    expect(manager.write(oldRule, 0)).toMatchObject({ success: true, version: 1 });
    fs.unlinkSync(path.join(manager.workspaceRoot, 'Metis.md'));

    const afterDelete = manager.read();
    const projection = projectMetisRulesFromWorkspace(afterDelete, projectId);
    expect(
      !projection.ok || projection.definition === undefined,
      'deleted authoritative file was silently replaced by an old internal slot',
    ).toBe(true);
    if (projection.ok) expect(projection.definition?.markdown).not.toContain('DELETED-RULE-MUST-NOT-SURVIVE');
  });

  it('removes the cached project layer after a CAS-authored empty Metis.md revision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-empty-'));
    roots.push(root);
    const projectId = 'project-empty';
    const manager = new WorkspaceAgentsManager(root, projectId);
    const oldRule = '# Metis.md\n\n- EMPTY-REVISION-REMOVES-ME.\n';
    expect(manager.write(oldRule, 0)).toMatchObject({ success: true, version: 1 });
    const firstProjection = projectMetisRulesFromWorkspace(manager.read(), projectId);
    expect(firstProjection.ok && firstProjection.definition && firstProjection.projectRulesId).toBeTruthy();
    if (!firstProjection.ok || !firstProjection.definition || !firstProjection.projectRulesId) return;
    const request = {
      contractVersion: 1 as const,
      sessionId: 'empty-revision-session',
      projectId,
      scenarioId: SCENARIO_ID,
      projectRulesId: firstProjection.projectRulesId,
    };
    expect(service.resolveForAgent(request, firstProjection.definition)?.systemPrompt)
      .toContain('EMPTY-REVISION-REMOVES-ME');

    expect(manager.write('', 1)).toMatchObject({ success: true, version: 2 });
    const emptyProjection = projectMetisRulesFromWorkspace(manager.read(), projectId);
    expect(emptyProjection).toEqual({ ok: true });
    const afterEmpty = service.resolveForAgent({
      contractVersion: 1,
      sessionId: request.sessionId,
      projectId,
      scenarioId: SCENARIO_ID,
    });
    expect(afterEmpty?.manifest.promptStack.some((layer) => layer.precedence === 500)).toBe(false);
    expect(afterEmpty?.systemPrompt).not.toContain('EMPTY-REVISION-REMOVES-ME');
  });

  it('rejects an internally supplied project rule whose id and scope do not agree with the request project', () => {
    const alpha = projectRule('project-alpha', '# Metis.md\n\n- Alpha.\n', 1);
    expect(alpha.ok && alpha.definition && alpha.projectRulesId).toBeTruthy();
    if (!alpha.ok || !alpha.definition || !alpha.projectRulesId) return;
    const forgedScope = {
      ...alpha.definition,
      scopeId: 'user:projects/project-beta',
    } satisfies MetisRulesDefinition;
    const request = {
      contractVersion: 1,
      sessionId: 'forged-scope-session',
      projectId: 'project-alpha',
      scenarioId: SCENARIO_ID,
      projectRulesId: alpha.projectRulesId,
    } as const;
    expect(service.resolveForAgent(request, forgedScope)).toBeUndefined();

    expect(service.resolveForAgent(request, alpha.definition)?.ok).toBe(true);
    expect(service.resolveForAgent(request, forgedScope)).toBeUndefined();
  });

  it('does not reuse a renderer-primed manifest created with a forged projectRulesId', () => {
    const projectId = 'project-renderer-poison';
    const markdown = '# Metis.md\n\n- AUTHORITATIVE-PROJECT-RULE.\n';
    const authoritative = projectRule(projectId, markdown, 1);
    expect(authoritative.ok && authoritative.definition && authoritative.projectRulesId).toBeTruthy();
    if (!authoritative.ok || !authoritative.definition || !authoritative.projectRulesId) return;

    const rendererProjectRule: MetisRulesDefinition = {
      ...authoritative.definition,
      provenance: {
        ...authoritative.definition.provenance,
        author: 'renderer attacker',
        sourceRevision: null,
      },
    };
    const poisonRule: MetisRulesDefinition = {
      ...rendererProjectRule,
      id: 'user:rules/renderer-cache-poison',
      name: 'Renderer cache poison',
      scope: 'global',
      scopeId: null,
      markdown: '# Hidden rule\n\nRENDERER-CACHE-POISON-MARKER',
    };
    expect(service.save({
      contractVersion: 1,
      definition: rendererProjectRule,
      expectedRevision: 0,
    }).ok).toBe(true);
    expect(service.save({
      contractVersion: 1,
      definition: poisonRule,
      expectedRevision: 0,
    }).ok).toBe(true);

    const request = {
      contractVersion: 1 as const,
      sessionId: 'renderer-poison-session',
      projectId,
      scenarioId: SCENARIO_ID,
      projectRulesId: authoritative.projectRulesId,
    };
    const rendererPrimed = service.resolve(request);
    expect(rendererPrimed.ok).toBe(true);
    if (!rendererPrimed.ok) return;
    expect(repository.listRunManifests(request.sessionId)).toHaveLength(0);
    expect(rendererPrimed.manifest.promptStack.some((layer) => (
      layer.sourceId === poisonRule.id && layer.content.includes('RENDERER-CACHE-POISON-MARKER')
    ))).toBe(true);

    expect(service.archive({
      contractVersion: 1,
      id: poisonRule.id,
      expectedRevision: 1,
    }).ok).toBe(true);
    expect(service.archive({
      contractVersion: 1,
      id: rendererProjectRule.id,
      expectedRevision: 1,
    }).ok).toBe(true);

    const agentResolved = service.resolveForAgent(request, authoritative.definition);
    expect(agentResolved?.ok).toBe(true);
    expect(agentResolved?.systemPrompt).not.toContain('RENDERER-CACHE-POISON-MARKER');
    expect(agentResolved?.manifest.promptStack.some((layer) => layer.sourceId === poisonRule.id)).toBe(false);
    expect(repository.listRunManifests(request.sessionId)).toHaveLength(1);
  });

  it('invalidates a poisoned HMAC manifest persisted by the pre-fix renderer resolve path', () => {
    const projectId = 'project-legacy-poison';
    const markdown = '# Metis.md\n\n- AUTHORITATIVE-LEGACY-PROJECT-RULE.\n';
    const authoritative = projectRule(projectId, markdown, 1);
    expect(authoritative.ok && authoritative.definition && authoritative.projectRulesId).toBeTruthy();
    if (!authoritative.ok || !authoritative.definition || !authoritative.projectRulesId) return;
    const rendererProjectRule: MetisRulesDefinition = {
      ...authoritative.definition,
      provenance: {
        ...authoritative.definition.provenance,
        author: 'legacy renderer attacker',
        sourceRevision: null,
      },
    };
    const poisonRule: MetisRulesDefinition = {
      ...rendererProjectRule,
      id: 'user:rules/legacy-renderer-cache-poison',
      name: 'Legacy renderer cache poison',
      scope: 'global',
      scopeId: null,
      markdown: '# Hidden legacy rule\n\nLEGACY-RENDERER-CACHE-POISON-MARKER',
    };
    for (const definition of [rendererProjectRule, poisonRule]) {
      expect(service.save({ contractVersion: 1, definition, expectedRevision: 0 }).ok).toBe(true);
    }
    const request = {
      contractVersion: 1 as const,
      sessionId: 'legacy-renderer-poison-session',
      projectId,
      scenarioId: SCENARIO_ID,
      projectRulesId: authoritative.projectRulesId,
    };
    const legacyResolution = new PersonalizationResolver(repository).resolve(request);
    expect(legacyResolution.ok).toBe(true);
    if (!legacyResolution.ok) return;
    repository.saveRunManifest(
      legacyResolution.manifest,
      legacyManifestTag(legacyResolution.manifest),
    );
    for (const definition of [poisonRule, rendererProjectRule]) {
      expect(service.archive({
        contractVersion: 1,
        id: definition.id,
        expectedRevision: 1,
      }).ok).toBe(true);
    }

    const agentResolved = service.resolveForAgent(request, authoritative.definition);
    expect(agentResolved?.ok).toBe(true);
    if (!agentResolved?.ok) return;
    expect(agentResolved?.systemPrompt).not.toContain('LEGACY-RENDERER-CACHE-POISON-MARKER');
    expect(agentResolved?.manifest.promptStack.some((layer) => layer.sourceId === poisonRule.id)).toBe(false);
    expect(agentResolved?.manifest.manifestDigest).not.toBe(legacyResolution.manifest.manifestDigest);
    expect(repository.getActiveRunManifestRecord(request.sessionId)?.integrityTag)
      .toBe(currentManifestTag(agentResolved.manifest));
    expect(repository.listRunManifests(request.sessionId)).toHaveLength(2);
  });

  it('reuses an exact v2 HMAC snapshot after reopening the persistent database with the same secret', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-manifest-v2-restart-'));
    roots.push(root);
    const databasePath = path.join(root, 'personalization.db');
    const projectId = 'project-v2-restart';
    const authoritative = projectRule(
      projectId,
      '# Metis.md\n\n- V2-PERSISTENT-AUTHORITATIVE-RULE.\n',
      1,
    );
    expect(authoritative.ok && authoritative.definition && authoritative.projectRulesId).toBeTruthy();
    if (!authoritative.ok || !authoritative.definition || !authoritative.projectRulesId) return;
    const request = {
      contractVersion: 1 as const,
      sessionId: 'v2-persistent-session',
      projectId,
      scenarioId: SCENARIO_ID,
      projectRulesId: authoritative.projectRulesId,
    };

    let firstDb: Database.Database | undefined = new Database(databasePath);
    let secondDb: Database.Database | undefined;
    try {
      firstDb.pragma('foreign_keys = ON');
      const firstRepository = new PersonalizationRepository(firstDb);
      firstRepository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
      const firstService = new PersonalizationRuntimeService(firstRepository, MANIFEST_SECRET);
      const first = firstService.resolveForAgent(request, authoritative.definition);
      expect(first?.ok).toBe(true);
      if (!first?.ok) return;
      expect(firstRepository.getActiveRunManifestRecord(request.sessionId)?.integrityTag)
        .toBe(currentManifestTag(first.manifest));
      expect(firstRepository.listRunManifests(request.sessionId)).toHaveLength(1);
      firstDb.close();
      firstDb = undefined;

      secondDb = new Database(databasePath);
      secondDb.pragma('foreign_keys = ON');
      const secondRepository = new PersonalizationRepository(secondDb);
      const secondService = new PersonalizationRuntimeService(secondRepository, MANIFEST_SECRET);
      const second = secondService.resolveForAgent(request, authoritative.definition);
      expect(second?.ok).toBe(true);
      expect(second?.manifest.manifestDigest).toBe(first.manifest.manifestDigest);
      expect(secondRepository.getActiveRunManifestRecord(request.sessionId)?.integrityTag)
        .toBe(currentManifestTag(first.manifest));
      expect(secondRepository.listRunManifests(request.sessionId)).toHaveLength(1);
    } finally {
      secondDb?.close();
      firstDb?.close();
    }
  });

  it('rejects a valid v2 HMAC snapshot replayed through another session lookup key', () => {
    const source = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'owner-source-session',
      projectId: 'owner-shared-project',
      scenarioId: SCENARIO_ID,
    });
    expect(source?.ok).toBe(true);
    if (!source?.ok) return;
    expect(repository.getActiveRunManifestRecord('owner-source-session')?.integrityTag)
      .toBe(currentManifestTag(source.manifest));
    db.prepare(`
      UPDATE personalization_run_manifests
      SET session_id = ?
      WHERE manifest_digest = ?
    `).run('owner-target-session', source.manifest.manifestDigest);

    const target = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'owner-target-session',
      projectId: 'owner-shared-project',
      scenarioId: SCENARIO_ID,
    });
    expect(target?.ok).toBe(true);
    expect(target?.manifest.sessionId).toBe('owner-target-session');
    expect(target?.manifest.manifestDigest).not.toBe(source.manifest.manifestDigest);
  });

  it('does not reuse a valid v2 HMAC snapshot for another project', () => {
    const first = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'cross-project-v2-session',
      projectId: 'project-v2-a',
      scenarioId: SCENARIO_ID,
    });
    expect(first?.ok).toBe(true);
    if (!first?.ok) return;

    const second = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'cross-project-v2-session',
      projectId: 'project-v2-b',
      scenarioId: SCENARIO_ID,
    });
    expect(second?.ok).toBe(true);
    expect(second?.manifest.projectId).toBe('project-v2-b');
    expect(second?.manifest.manifestDigest).not.toBe(first.manifest.manifestDigest);
  });
});
