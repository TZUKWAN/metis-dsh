import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';
import { PersonalizationRepository, TRASH_RETENTION_MS } from '../../engine/personalization/PersonalizationRepository.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { projectMetisRulesFromWorkspace } from '../../electron/ProjectMetisRulesBridge.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';

const RUNTIME_SECRET = Buffer.alloc(32, 7);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

describe('PersonalizationRuntimeService', () => {
  let db: Database.Database | undefined;
  let service: PersonalizationRuntimeService;
  let repository: PersonalizationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new PersonalizationRepository(db, RUNTIME_SECRET);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    service = new PersonalizationRuntimeService(repository, RUNTIME_SECRET);
  });

  afterEach(() => db?.close());

  it('lists factory definitions through a strict request', () => {
    const result = service.list({ contractVersion: 1, includeDisabled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected a successful list response, received ${result.code}`);
    expect(result.definitions.length).toBeGreaterThan(12);
    expect(result.definitions.some((definition) => definition.id === 'builtin:scenarios/general-research')).toBe(true);
  });

  it('returns an explicit failure instead of an authoritative empty list for malformed requests', () => {
    expect(service.list({ contractVersion: 2, includeDisabled: true }))
      .toEqual({ ok: false, code: 'invalid_request' });
    expect(service.list({ contractVersion: 1, includeDisabled: 'yes' }))
      .toEqual({ ok: false, code: 'invalid_request' });
  });

  it('rejects malformed save and archive requests without mutation', () => {
    expect(service.save({ definition: {} })).toEqual({ ok: false, code: 'invalid_request' });
    expect(service.archive({ contractVersion: 1, id: '../escape', expectedRevision: 1 }))
      .toEqual({ ok: false, code: 'invalid_request' });
  });

  it('lists and restores a user scenario through the persisted seven-day trash', () => {
    const source = buildBuiltinPersonalizationDefinitions()
      .find((definition) => definition.kind === 'scenario')!;
    const userScenario = {
      ...structuredClone(source),
      id: 'user:scenarios/trash-round-trip',
      revision: 1,
      provenance: {
        ...source.provenance,
        origin: 'user' as const,
        author: 'Researcher',
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: null,
        parentVersion: null,
        locallyModified: true,
      },
    };
    expect(service.save({ contractVersion: 1, definition: userScenario, expectedRevision: 0 }).ok).toBe(true);
    expect(service.archive({ contractVersion: 1, id: userScenario.id, expectedRevision: 1 })).toEqual({
      ok: true,
      code: 'deleted',
      id: userScenario.id,
    });

    const trash = service.listTrash({ contractVersion: 1, kind: 'scenario' });
    expect(trash).toEqual(expect.objectContaining({
      ok: true,
      definitions: [expect.objectContaining({ definition: expect.objectContaining({ id: userScenario.id }) })],
    }));

    expect(service.restoreFromTrash({ contractVersion: 1, id: userScenario.id, expectedRevision: 1 }))
      .toEqual(expect.objectContaining({ ok: true, code: 'restored', definition: expect.objectContaining({ id: userScenario.id }) }));
    expect(service.listTrash({ contractVersion: 1, kind: 'scenario' })).toEqual({ ok: true, definitions: [] });
    expect(service.get({ contractVersion: 1, id: userScenario.id }).definition).toEqual(expect.objectContaining({ id: userScenario.id }));

    // This is the same list call made when the scene library opens: no
    // renderer timer is involved, and a restart after expiry still purges.
    expect(repository.archive(userScenario.id, 1, Date.now() - TRASH_RETENTION_MS)).toEqual({
      ok: true,
      code: 'deleted',
      id: userScenario.id,
    });
    expect(service.listTrash({ contractVersion: 1, kind: 'scenario' })).toEqual({ ok: true, definitions: [] });
    expect(repository.get(userScenario.id, true)).toBeUndefined();
  });

  it('round-trips an archived skill through the shared trash and keeps factory rows protected', () => {
    const source = buildBuiltinPersonalizationDefinitions()
      .find((definition) => definition.kind === 'skill')!;
    const userSkill = {
      ...structuredClone(source),
      id: 'user:skills/trash-round-trip',
      revision: 1,
      provenance: {
        ...source.provenance,
        origin: 'user' as const,
        author: 'Researcher',
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: null,
        parentVersion: null,
        locallyModified: true,
      },
    };
    expect(service.save({ contractVersion: 1, definition: userSkill, expectedRevision: 0 }).ok).toBe(true);
    expect(service.archive({ contractVersion: 1, id: userSkill.id, expectedRevision: 1 })).toEqual({
      ok: true, code: 'deleted', id: userSkill.id,
    });

    // The full trash (no kind filter) is what the library sidebar renders.
    const trash = service.listTrash({ contractVersion: 1 });
    expect(trash.ok).toBe(true);
    if (!trash.ok) throw new Error('Expected a successful trash list');
    expect(trash.definitions.map((item) => item.definition.id)).toContain(userSkill.id);

    expect(service.restoreFromTrash({ contractVersion: 1, id: userSkill.id, expectedRevision: 1 }))
      .toEqual(expect.objectContaining({ ok: true, code: 'restored', definition: expect.objectContaining({ id: userSkill.id }) }));
    expect(service.get({ contractVersion: 1, id: userSkill.id }).definition).toEqual(expect.objectContaining({ id: userSkill.id }));

    // Factory rows never enter the user-visible trash lifecycle.
    const builtinSkill = service.list({ contractVersion: 1, includeDisabled: true });
    expect(builtinSkill.ok).toBe(true);
    if (!builtinSkill.ok) throw new Error('Expected a successful definition list');
    const factorySkill = builtinSkill.definitions.find((definition) => definition.kind === 'skill' && definition.provenance.origin === 'builtin');
    if (!factorySkill) throw new Error('Fixture is missing a built-in skill');
    expect(service.restoreFromTrash({ contractVersion: 1, id: factorySkill.id, expectedRevision: factorySkill.revision }))
      .toEqual({ ok: false, code: 'factory_protected' });
  });

  it('hands expired skill definitions to the purge callback so installed assets can be released', () => {
    const source = buildBuiltinPersonalizationDefinitions()
      .find((definition) => definition.kind === 'skill')!;
    const db2 = new Database(':memory:');
    try {
      const repo2 = new PersonalizationRepository(db2);
      repo2.seedBuiltins(buildBuiltinPersonalizationDefinitions());
      const purgedIds: string[] = [];
      const service2 = new PersonalizationRuntimeService(repo2, RUNTIME_SECRET, {
        onPurgeExpired: (definitions) => purgedIds.push(...definitions.map((definition) => definition.id)),
      });
      const expiring = {
        ...structuredClone(source),
        id: 'user:skills/expired-purge',
        revision: 1,
        provenance: {
          ...source.provenance,
          origin: 'user' as const,
          author: 'Researcher',
          sourceUrl: null,
          sourceRevision: null,
          installedDigest: null,
          parentId: null,
          parentVersion: null,
          locallyModified: true,
        },
      };
      expect(service2.save({ contractVersion: 1, definition: expiring, expectedRevision: 0 }).ok).toBe(true);
      expect(repo2.archive(expiring.id, 1, Date.now() - TRASH_RETENTION_MS).ok).toBe(true);
      expect(purgedIds).toEqual([]);
      // The next trash listing applies retention synchronously.
      expect(service2.listTrash({ contractVersion: 1 }).ok).toBe(true);
      expect(purgedIds).toEqual([expiring.id]);
      expect(repo2.get(expiring.id, true)).toBeUndefined();
      expect(repo2.listVersions(expiring.id)).toEqual([]);
    } finally {
      db2.close();
    }
  });

  it('does not resolve a runnable scenario when its durable integrity key is unavailable', () => {
    const unavailable = new PersonalizationRuntimeService(repository);
    expect(unavailable.resolve({
      contractVersion: 1,
      sessionId: 'session-unavailable',
      projectId: 'project-unavailable',
      scenarioId: 'builtin:scenarios/general-research',
    })).toEqual({
      ok: false,
      code: 'definition_corrupt',
      issues: ['Scenario run integrity key is unavailable'],
    });
    expect(unavailable.resolveForAgent({
      contractVersion: 1,
      sessionId: 'session-unavailable',
      projectId: 'project-unavailable',
      scenarioId: 'builtin:scenarios/general-research',
    })).toBeUndefined();
  });

  it('forks a built-in skill and resolves the factory scenario', () => {
    const fork = service.fork({
      contractVersion: 1,
      sourceId: 'builtin:skills/literature-review',
      targetId: 'user:skills/my-literature-review',
      author: 'Researcher',
    });
    expect(fork.ok).toBe(true);
    expect(service.get({ contractVersion: 1, id: 'user:skills/my-literature-review' }).definition).not.toBeNull();

    const resolved = service.resolve({
      contractVersion: 1,
      sessionId: 'session-one',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.manifest.truthPolicy).toBe('automatic_required');
      expect(resolved.manifest.fullAccess.perActionConfirmation).toBe(false);
    }
  });

  it('does not expose a workflow for the reserved Presentation scenario', () => {
    const result = service.get({
      contractVersion: 1,
      id: 'builtin:scenarios/presentation-reserved',
    });
    expect(result.definition?.kind).toBe('scenario');
    if (result.definition?.kind === 'scenario') {
      expect(result.definition.enabled).toBe(false);
      expect(result.definition.workflow).toEqual([]);
    }
  });

  it('lists immutable version history through a strict request', () => {
    const result = service.versions({
      contractVersion: 1,
      id: 'builtin:scenarios/general-research',
    });
    expect(result.ok).toBe(true);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]?.revision).toBe(1);
    expect(service.versions({ id: '../escape' })).toEqual({ ok: true, versions: [] });
  });

  it('reports quarantined definitions and recovers them only from verified history', () => {
    const source = buildBuiltinPersonalizationDefinitions()
      .find((definition) => definition.kind === 'scenario')!;
    const scenario = {
      ...structuredClone(source),
      id: 'user:scenarios/quarantine-recovery',
      revision: 1,
      provenance: {
        ...source.provenance,
        origin: 'user' as const,
        author: 'Researcher',
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: null,
        parentVersion: null,
        locallyModified: true,
      },
    };
    expect(service.save({ contractVersion: 1, definition: scenario, expectedRevision: 0 }).ok).toBe(true);
    db.prepare('UPDATE personalization_definitions SET current_revision = 2 WHERE id = ?').run(scenario.id);

    expect(service.list({ contractVersion: 1, kind: 'scenario', includeDisabled: true }))
      .toEqual(expect.objectContaining({ ok: true, definitions: expect.not.arrayContaining([expect.objectContaining({ id: scenario.id })]) }));
    expect(service.listIntegrityIssues({ contractVersion: 1, kind: 'scenario' })).toEqual({
      ok: true,
      issues: [expect.objectContaining({
        id: scenario.id,
        currentRevision: 2,
        latestVerifiedRevision: 1,
        code: 'current_definition_identity_mismatch',
      })],
    });
    expect(service.recoverIntegrityIssue({
      contractVersion: 1,
      id: scenario.id,
      sourceRevision: 1,
      expectedCurrentRevision: 2,
    })).toEqual(expect.objectContaining({
      ok: true,
      code: 'saved',
      definition: expect.objectContaining({ id: scenario.id, revision: 3 }),
    }));
    expect(service.get({ contractVersion: 1, id: scenario.id }).definition)
      .toEqual(expect.objectContaining({ id: scenario.id, revision: 3 }));
  });

  it('freezes and reuses the active run manifest across definition changes', () => {
    const request = {
      contractVersion: 1 as const,
      sessionId: 'session-frozen',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    };
    const first = service.resolveForAgent(request);
    expect(first?.ok).toBe(true);
    const frozenDigest = first?.manifest.manifestDigest;
    const current = repository.get('builtin:scenarios/general-research');
    expect(current?.kind).toBe('scenario');
    // Factory reseeding creates a newer definition revision, but the running
    // session remains bound to its persisted snapshot.
    const reseeded = buildBuiltinPersonalizationDefinitions().map((definition) => (
      definition.id === 'builtin:scenarios/general-research'
        ? { ...definition, description: `${definition.description} Updated.` }
        : definition
    ));
    repository.seedBuiltins(reseeded);
    const second = service.resolveForAgent(request);
    expect(second?.manifest.manifestDigest).toBe(frozenDigest);
    expect(repository.listRunManifests('session-frozen')).toHaveLength(1);
  });

  it('re-resolves an old output-plan snapshot that lacks its frozen implicit step policy', () => {
    const request = {
      contractVersion: 1 as const,
      sessionId: 'session-old-output-plan',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    };
    const preview = service.resolve(request);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const {
      manifestDigest: _previewDigest,
      implicitOutputStep: _implicitOutputStep,
      ...previewWithoutDigest
    } = preview.manifest;
    void _previewDigest;
    void _implicitOutputStep;
    const legacyWithoutDigest = {
      ...previewWithoutDigest,
      workflow: [],
      output: {
        ...preview.manifest.output,
        plan: {
          primaryDeliverable: 'Legacy primary',
          supportingArtifacts: ['Legacy supporting'],
          qualityCriteria: ['Legacy criterion'],
        },
      },
    };
    const legacyManifest = {
      ...legacyWithoutDigest,
      manifestDigest: createHash('sha256').update(canonicalJson(legacyWithoutDigest), 'utf8').digest('hex'),
    };
    const integrityTag = createHmac('sha256', RUNTIME_SECRET)
      .update('metis:personalization-run-manifest:v2\0')
      .update(canonicalJson(legacyManifest), 'utf8')
      .digest('hex');
    repository.saveRunManifest(legacyManifest, integrityTag);

    const resolved = service.resolveForAgent(request);
    expect(resolved?.ok).toBe(true);
    expect(resolved?.manifest.manifestDigest).not.toBe(legacyManifest.manifestDigest);
    expect(resolved?.manifest.workflow.length).toBeGreaterThan(0);
  });

  it('binds authoritative project Metis.md and replaces the session snapshot when that file revision changes', () => {
    const firstMarkdown = '# Metis.md\n\n- Use Chicago citations.\n';
    const firstProjection = projectMetisRulesFromWorkspace({
      exists: true,
      content: firstMarkdown,
      version: 1,
      contentHash: hashWorkspaceAgentsContent(firstMarkdown),
      projectId: 'project-one',
    }, 'project-one');
    expect(firstProjection.ok).toBe(true);
    if (!firstProjection.ok || !firstProjection.definition || !firstProjection.projectRulesId) return;
    const request = {
      contractVersion: 1 as const,
      sessionId: 'session-project-metis',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
      projectRulesId: firstProjection.projectRulesId,
    };
    const first = service.resolveForAgent(request, firstProjection.definition);
    expect(first?.ok).toBe(true);
    expect(first?.manifest.promptStack).toContainEqual(expect.objectContaining({
      sourceId: firstProjection.projectRulesId,
      sourceKind: 'rules',
      precedence: 500,
      content: firstMarkdown,
    }));

    const secondMarkdown = '# Metis.md\n\n- Use APA citations.\n';
    const secondProjection = projectMetisRulesFromWorkspace({
      exists: true,
      content: secondMarkdown,
      version: 2,
      contentHash: hashWorkspaceAgentsContent(secondMarkdown),
      projectId: 'project-one',
    }, 'project-one');
    expect(secondProjection.ok).toBe(true);
    if (!secondProjection.ok || !secondProjection.definition || !secondProjection.projectRulesId) return;
    const second = service.resolveForAgent(request, secondProjection.definition);
    expect(second?.ok).toBe(true);
    expect(second?.manifest.manifestDigest).not.toBe(first?.manifest.manifestDigest);
    expect(second?.manifest.definitionRevisions[secondProjection.projectRulesId]).toBe(2);
    expect(second?.systemPrompt).toContain(secondMarkdown);
    expect(second?.systemPrompt).not.toContain(firstMarkdown);
    expect(repository.listRunManifests('session-project-metis')).toHaveLength(2);
  });

  it('rejects a project rule id without the main-derived definition and removes an old project layer when no file remains', () => {
    const markdown = '# Metis.md\n\n- Preserve quotations exactly.\n';
    const projection = projectMetisRulesFromWorkspace({
      exists: true,
      content: markdown,
      version: 1,
      contentHash: hashWorkspaceAgentsContent(markdown),
      projectId: 'project-one',
    }, 'project-one');
    expect(projection.ok).toBe(true);
    if (!projection.ok || !projection.definition || !projection.projectRulesId) return;
    const boundRequest = {
      contractVersion: 1 as const,
      sessionId: 'session-project-rule-removal',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
      projectRulesId: projection.projectRulesId,
    };
    expect(service.resolveForAgent(boundRequest)).toBeUndefined();
    expect(service.resolveForAgent(boundRequest, projection.definition)?.ok).toBe(true);

    const withoutFile = service.resolveForAgent({
      contractVersion: 1,
      sessionId: 'session-project-rule-removal',
      projectId: 'project-one',
      scenarioId: 'builtin:scenarios/general-research',
    });
    expect(withoutFile?.ok).toBe(true);
    expect(withoutFile?.manifest.promptStack.some((layer) => layer.precedence === 500)).toBe(false);
    expect(repository.listRunManifests('session-project-rule-removal')).toHaveLength(2);
  });
});
