import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PersonalizationRepository, TRASH_RETENTION_MS } from '../../engine/personalization/PersonalizationRepository.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunCoordinator,
  digestScenarioStepOutput,
} from '../../engine/personalization/ScenarioRunCoordinator.js';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  type AgentDefinition,
  type MetisRulesDefinition,
  type ScenarioDefinition,
  type SkillDefinitionV2,
  type ResolvedRunManifest,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_785_394_400_000;
const INTEGRITY_SECRET = Buffer.alloc(32, 17);

function provenance(origin: 'builtin' | 'user' = 'user') {
  return {
    origin,
    author: origin === 'builtin' ? 'Metis' : 'Test user',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: origin !== 'builtin',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function skill(id: string, origin: 'builtin' | 'user' = 'user', revision = 1): SkillDefinitionV2 {
  return {
    contractVersion: 1,
    id,
    kind: 'skill',
    name: 'Literature review',
    description: 'Review literature.',
    enabled: true,
    tags: ['review'],
    revision,
    provenance: provenance(origin),
    sourceMode: 'markdown',
    markdown: '# Literature review',
    systemPrompt: 'Review literature with evidence.',
    toolIds: ['read_pdf'],
    mcpIds: [],
    maxTurns: 12,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
}

function rules(id: string): MetisRulesDefinition {
  return {
    contractVersion: 1,
    id,
    kind: 'rules',
    name: 'Global Metis rules',
    description: 'Global rules.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    scope: 'global',
    scopeId: null,
    markdown: '# Metis.md\n\nWork autonomously.',
  };
}

function agent(id: string, skillId: string): AgentDefinition {
  return {
    contractVersion: 1,
    id,
    kind: 'agent',
    name: 'Review agent',
    description: 'Reviews evidence.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    role: 'Reviewer',
    systemPrompt: 'Review evidence.',
    modelPreference: null,
    skillIds: [skillId],
    toolIds: ['read_pdf'],
    mcpIds: [],
    memory: { scope: 'scenario', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
    output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
    maxTurns: 10,
    retryLimit: 2,
  };
}

function scenario(id: string, agentId: string, skillId: string, rulesId: string): ScenarioDefinition {
  return {
    contractVersion: 1,
    id,
    kind: 'scenario',
    name: 'Research scenario',
    description: 'A research scenario.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    agentIds: [agentId],
    skillIds: [skillId],
    mcpIds: [],
    rulesIds: [rulesId],
    workflow: [{
      id: 'review',
      name: 'Review',
      description: 'Review evidence.',
      agentId,
      skillIds: [skillId],
      toolIds: ['read_pdf'],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 10,
    }],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory: { scope: 'scenario', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
    output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
    triggerPhrases: ['review evidence'],
    capability: 'research',
  };
}

describe('PersonalizationRepository', () => {
  let db: Database.Database | undefined;
  let repository: PersonalizationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new PersonalizationRepository(db, INTEGRITY_SECRET);
  });

  afterEach(() => db?.close());

  it('seeds immutable factory definitions idempotently', () => {
    const builtin = skill('builtin:skills/literature-review', 'builtin');
    repository.seedBuiltins([builtin]);
    repository.seedBuiltins([builtin]);
    expect(repository.list()).toEqual([builtin]);
    expect(repository.getFactory(builtin.id)).toEqual(builtin);
    expect(repository.listVersions(builtin.id)).toHaveLength(1);
  });

  it('protects factory records and creates an editable fork', () => {
    const builtin = skill('builtin:skills/literature-review', 'builtin');
    repository.seedBuiltins([builtin]);
    expect(repository.save({
      contractVersion: 1,
      definition: builtin,
      expectedRevision: 1,
    })).toEqual({ ok: false, code: 'factory_protected' });

    const result = repository.forkBuiltin(builtin.id, 'user:skills/my-review', 'Researcher', NOW + 1);
    expect(result.ok).toBe(true);
    const fork = repository.get('user:skills/my-review');
    expect(fork?.provenance.parentId).toBe(builtin.id);
    expect(fork?.provenance.origin).toBe('user');
    expect(repository.getFactory(builtin.id)).toEqual(builtin);
  });

  it('uses compare-and-swap revisions and preserves version history', () => {
    const first = skill('user:skills/review');
    expect(repository.save({ contractVersion: 1, definition: first, expectedRevision: 0 }).ok).toBe(true);
    const second = {
      ...first,
      revision: 2,
      markdown: '# Improved review',
      provenance: { ...first.provenance, updatedAt: NOW + 1 },
    };
    expect(repository.save({ contractVersion: 1, definition: second, expectedRevision: 1 }).ok).toBe(true);
    expect(repository.save({ contractVersion: 1, definition: { ...second, revision: 3 }, expectedRevision: 1 }))
      .toEqual({ ok: false, code: 'revision_conflict', currentRevision: 2 });
    expect(repository.listVersions(first.id).map((view) => view.revision)).toEqual([2, 1]);
    expect(repository.listVersions(first.id)[0]?.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('quarantines a missing current ledger entry and recovers only from verified history', () => {
    const definition = skill('user:skills/missing-current-version');
    expect(repository.save({ contractVersion: 1, definition, expectedRevision: 0 }).ok).toBe(true);
    const second: SkillDefinitionV2 = {
      ...definition,
      revision: 2,
      markdown: '# Changed',
      provenance: { ...definition.provenance, updatedAt: NOW + 1 },
    };
    expect(repository.save({ contractVersion: 1, definition: second, expectedRevision: 1 }).ok).toBe(true);
    db.prepare('DELETE FROM personalization_versions WHERE id = ? AND revision = ?').run(second.id, second.revision);

    const restarted = new PersonalizationRepository(db, INTEGRITY_SECRET);
    expect(restarted.get(second.id)).toBeUndefined();
    expect(restarted.list('skill', true)).not.toContainEqual(second);
    expect(restarted.listVersions(second.id).map((view) => view.revision)).toEqual([1]);
    expect(restarted.listIntegrityIssues('skill')).toEqual([{
      id: second.id,
      kind: 'skill',
      archived: false,
      currentRevision: 2,
      latestVerifiedRevision: 1,
      code: 'current_version_missing',
    }]);

    const recovered = restarted.recoverIntegrityIssue(second.id, 1, 2, NOW + 2);
    expect(recovered).toEqual(expect.objectContaining({
      ok: true,
      code: 'saved',
      definition: expect.objectContaining({ revision: 3, markdown: definition.markdown }),
    }));
    expect(restarted.get(second.id)).toEqual(expect.objectContaining({ revision: 3, markdown: definition.markdown }));
    expect(restarted.listIntegrityIssues('skill')).toEqual([]);
    expect(restarted.listVersions(second.id).map((view) => view.revision)).toEqual([3, 1]);
    expect(db.prepare(`
      SELECT quarantined_revision, current_json, issue_code FROM personalization_definition_quarantine WHERE id = ?
    `).get(second.id)).toEqual({
      quarantined_revision: 2,
      current_json: expect.any(String),
      issue_code: 'current_version_missing',
    });
  });

  it('does not recover schema-invalid or identity-mismatched current JSON', () => {
    const definition = skill('user:skills/unrecoverable-current');
    expect(repository.save({ contractVersion: 1, definition, expectedRevision: 0 }).ok).toBe(true);
    db.prepare(`
      UPDATE personalization_definitions SET current_revision = 2, current_json = ? WHERE id = ?
    `).run('{}', definition.id);

    const restarted = new PersonalizationRepository(db, INTEGRITY_SECRET);
    expect(restarted.get(definition.id)).toBeUndefined();
    expect(restarted.listIntegrityIssues('skill')).toEqual([expect.objectContaining({
      id: definition.id,
      currentRevision: 2,
      latestVerifiedRevision: 1,
      code: 'current_definition_invalid',
    })]);
    expect(restarted.recoverIntegrityIssue(definition.id, 1, 1, NOW + 2))
      .toEqual({ ok: false, code: 'revision_conflict', currentRevision: 2 });
    expect(restarted.recoverIntegrityIssue(definition.id, 1, 2, NOW + 2)).toEqual(expect.objectContaining({
      ok: true,
      code: 'saved',
      definition: expect.objectContaining({ revision: 3 }),
    }));
    expect(restarted.get(definition.id)).toEqual(expect.objectContaining({ revision: 3 }));
  });

  it('rolls back both the current row and version ledger when version publication fails', () => {
    const first = skill('user:skills/atomic-publication');
    expect(repository.save({ contractVersion: 1, definition: first, expectedRevision: 0 }).ok).toBe(true);
    db.exec(`
      CREATE TRIGGER reject_personalization_version_two
      BEFORE INSERT ON personalization_versions
      WHEN NEW.id = 'user:skills/atomic-publication' AND NEW.revision = 2
      BEGIN SELECT RAISE(ABORT, 'injected version failure'); END;
    `);
    const second: SkillDefinitionV2 = {
      ...first,
      revision: 2,
      markdown: '# Must not publish',
      provenance: { ...first.provenance, updatedAt: NOW + 1 },
    };
    expect(repository.save({ contractVersion: 1, definition: second, expectedRevision: 1 }))
      .toEqual({ ok: false, code: 'io_error' });
    expect(repository.get(first.id)).toEqual(first);
    expect(repository.listVersions(first.id).map((view) => view.revision)).toEqual([1]);
  });

  it('survives a real file close and reopen with a complete immutable ledger', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-personalization-restart-'));
    const filePath = path.join(directory, 'personalization.db');
    const first = skill('user:skills/file-restart');
    try {
      const firstDb = new Database(filePath);
      const firstRepository = new PersonalizationRepository(firstDb, INTEGRITY_SECRET);
      expect(firstRepository.save({ contractVersion: 1, definition: first, expectedRevision: 0 }).ok).toBe(true);
      const second: SkillDefinitionV2 = {
        ...first,
        revision: 2,
        markdown: '# Durable after restart',
        provenance: { ...first.provenance, updatedAt: NOW + 1 },
      };
      expect(firstRepository.save({ contractVersion: 1, definition: second, expectedRevision: 1 }).ok).toBe(true);
      firstDb.close();

      const restartedDb = new Database(filePath);
      const restarted = new PersonalizationRepository(restartedDb, INTEGRITY_SECRET);
      expect(restarted.get(first.id)).toEqual(second);
      expect(restarted.list('skill', true)).toContainEqual(second);
      expect(restarted.listVersions(first.id).map((version) => version.revision)).toEqual([2, 1]);
      restartedDb.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores an earlier version by creating a new revision', () => {
    const first = skill('user:skills/restore');
    repository.save({ contractVersion: 1, definition: first, expectedRevision: 0 });
    const second = {
      ...first,
      revision: 2,
      markdown: '# Changed',
      provenance: { ...first.provenance, updatedAt: NOW + 1 },
    };
    repository.save({ contractVersion: 1, definition: second, expectedRevision: 1 });
    const restored = repository.restoreVersion(first.id, 1, 2, NOW + 2);
    expect(restored.ok).toBe(true);
    expect(repository.get(first.id)?.revision).toBe(3);
    expect((repository.get(first.id) as SkillDefinitionV2).markdown).toBe(first.markdown);
  });

  it('rejects missing scenario dependencies and accepts a complete graph', () => {
    const skillId = 'user:skills/review';
    const agentId = 'user:agents/reviewer';
    const rulesId = 'user:rules/global';
    const definition = scenario('user:scenarios/research', agentId, skillId, rulesId);
    const missing = repository.save({ contractVersion: 1, definition, expectedRevision: 0 });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.code === 'dependency_invalid') {
      expect(missing.issues).toHaveLength(3);
    }
    repository.save({ contractVersion: 1, definition: skill(skillId), expectedRevision: 0 });
    repository.save({ contractVersion: 1, definition: rules(rulesId), expectedRevision: 0 });
    repository.save({ contractVersion: 1, definition: agent(agentId, skillId), expectedRevision: 0 });
    expect(repository.save({ contractVersion: 1, definition, expectedRevision: 0 }).ok).toBe(true);
  });

  it('archives user definitions but never factory definitions', () => {
    const userSkill = skill('user:skills/archive');
    repository.save({ contractVersion: 1, definition: userSkill, expectedRevision: 0 });
    expect(repository.archive(userSkill.id, 1)).toEqual({ ok: true, code: 'deleted', id: userSkill.id });
    expect(repository.get(userSkill.id)).toBeUndefined();
    expect(repository.get(userSkill.id, true)).toBeDefined();

    const builtin = skill('builtin:skills/archive', 'builtin');
    repository.seedBuiltins([builtin]);
    expect(repository.archive(builtin.id, 1)).toEqual({ ok: false, code: 'factory_protected' });
  });

  it('keeps archived scenarios recoverable for seven days and then permanently purges them', () => {
    const factory = buildBuiltinPersonalizationDefinitions();
    repository.seedBuiltins(factory);
    const source = factory.find((definition): definition is ScenarioDefinition => definition.kind === 'scenario')!;
    const userScenario: ScenarioDefinition = {
      ...structuredClone(source),
      id: 'user:scenarios/seven-day-trash',
      revision: 1,
      provenance: {
        ...source.provenance,
        origin: 'user',
        author: 'Test user',
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: null,
        parentVersion: null,
        locallyModified: true,
      },
    };
    expect(repository.save({ contractVersion: 1, definition: userScenario, expectedRevision: 0 }).ok).toBe(true);

    const archivedAt = NOW + 10;
    expect(repository.archive(userScenario.id, 1, archivedAt)).toEqual({ ok: true, code: 'deleted', id: userScenario.id });
    expect(repository.listArchived('scenario')).toEqual([expect.objectContaining({
      definition: expect.objectContaining({ id: userScenario.id }),
      archivedAt,
      expiresAt: archivedAt + TRASH_RETENTION_MS,
    })]);
    expect(repository.purgeExpiredArchivedDefinitions(archivedAt + TRASH_RETENTION_MS - 1)).toEqual([]);

    expect(repository.restoreArchived(userScenario.id, 1, archivedAt + 100)).toEqual(expect.objectContaining({
      ok: true,
      code: 'restored',
      definition: expect.objectContaining({ id: userScenario.id, revision: 1 }),
    }));
    expect(repository.get(userScenario.id)).toEqual(expect.objectContaining({ id: userScenario.id, revision: 1 }));
    expect(repository.listArchived('scenario')).toEqual([]);

    const rearchivedAt = archivedAt + 200;
    expect(repository.archive(userScenario.id, 1, rearchivedAt).ok).toBe(true);
    const purged = repository.purgeExpiredArchivedDefinitions(rearchivedAt + TRASH_RETENTION_MS);
    expect(purged.map((definition) => definition.id)).toEqual([userScenario.id]);
    expect(repository.listVersions(userScenario.id)).toEqual([]);
    expect(repository.get(userScenario.id, true)).toBeUndefined();
    expect(repository.listVersions(userScenario.id)).toEqual([]);
  });

  it('applies the same seven-day retention to archived skills and releases them with their history', () => {
    const userSkill = skill('user:skills/expired-trash');
    repository.save({ contractVersion: 1, definition: userSkill, expectedRevision: 0 });
    const archivedAt = NOW + 500;
    expect(repository.archive(userSkill.id, 1, archivedAt)).toEqual({ ok: true, code: 'deleted', id: userSkill.id });
    expect(repository.listArchived('skill').map((item) => item.definition.id)).toEqual([userSkill.id]);

    // One tick before expiry the skill stays recoverable.
    expect(repository.purgeExpiredArchivedDefinitions(archivedAt + TRASH_RETENTION_MS - 1)).toEqual([]);
    expect(repository.restoreArchived(userSkill.id, 1, archivedAt + 10)).toEqual(expect.objectContaining({ ok: true, code: 'restored' }));

    const rearchivedAt = archivedAt + 20;
    expect(repository.archive(userSkill.id, 1, rearchivedAt).ok).toBe(true);
    const purged = repository.purgeExpiredArchivedDefinitions(rearchivedAt + TRASH_RETENTION_MS);
    expect(purged.map((definition) => definition.id)).toEqual([userSkill.id]);
    expect(purged[0]?.kind).toBe('skill');
    expect(repository.get(userSkill.id, true)).toBeUndefined();
    expect(repository.listVersions(userSkill.id)).toEqual([]);
  });

  it('does not allow a create request to masquerade as an update', () => {
    const definition = skill('user:skills/cas');
    expect(repository.save({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      definition,
      expectedRevision: 1,
    })).toEqual({ ok: false, code: 'revision_conflict', currentRevision: 0 });
    expect(repository.get(definition.id)).toBeUndefined();
  });

  it('persists immutable run manifests and switches the active session snapshot', () => {
    const baseManifest: ResolvedRunManifest = {
      contractVersion: 1,
      sessionId: 'session-1',
      projectId: 'project-1',
      scenarioId: 'user:scenarios/research',
      scenarioRevision: 1,
      definitionRevisions: { 'user:scenarios/research': 1 },
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      allowedTools: [],
      workflow: [],
      maxTurns: 1,
      promptStack: [],
      fullAccess: { mode: 'full_access', perActionConfirmation: false, liveSteering: true, silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true },
      memory: { scope: 'session', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
      output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
      truthPolicy: 'automatic_required',
      createdAt: NOW,
      manifestDigest: 'a'.repeat(64),
    };
    repository.saveRunManifest(baseManifest);
    expect(repository.getActiveRunManifest('session-1')).toEqual(baseManifest);
    const next = { ...baseManifest, createdAt: NOW + 1, scenarioRevision: 2, manifestDigest: 'b'.repeat(64) };
    repository.saveRunManifest(next);
    expect(repository.getActiveRunManifest('session-1')).toEqual(next);
    expect(repository.listRunManifests('session-1').map((item) => item.manifestDigest)).toEqual([
      next.manifestDigest,
      baseManifest.manifestDigest,
    ]);
  });

  it('durably stores scenario run checkpoints and rejects run-id manifest rebinding', async () => {
    const definitions = buildBuiltinPersonalizationDefinitions();
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const resolved = new PersonalizationResolver({
      get: (id) => byId.get(id),
      list: (kind, includeDisabled) => definitions.filter((definition) => (
        (!kind || definition.kind === kind) && (includeDisabled || definition.enabled)
      )),
    }).resolve({
      sessionId: 'durable-session',
      projectId: 'durable-project',
      scenarioId: 'builtin:scenarios/general-research',
      createdAt: NOW,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const coordinator = new ScenarioRunCoordinator({
      now: () => NOW,
      onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      executor: async (input) => {
        const output = { stepId: input.step.id, answer: 'verified workflow output' };
        return { ok: true, output, outputDigest: digestScenarioStepOutput(output), artifactRefs: [] };
      },
    });
    const result = await coordinator.start({ runId: 'durable-run', manifest: resolved.manifest });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repository.getScenarioRunRecord('durable-run')).toEqual(result.record);
    expect(repository.listScenarioRunRecords('durable-session')).toEqual([result.record]);
    expect(repository.latestScenarioRunForProject('durable-project')).toEqual(result.record);
    expect(repository.latestScenarioRunForProject('other-project')).toBeNull();

    expect(() => repository.saveScenarioRunRecord({
      ...result.record,
      manifestDigest: '0'.repeat(64),
    })).toThrow(/manifest binding/u);
    expect(() => repository.saveScenarioRunRecord({
      ...result.record,
      status: 'running',
      completedAt: null,
      updatedAt: result.record.updatedAt + 1,
    })).toThrow(/Terminal scenario run records are immutable/u);
    expect(repository.getScenarioRunRecord('durable-run')).toEqual(result.record);

    db.prepare('UPDATE personalization_scenario_runs SET record_json = ? WHERE run_id = ?').run(
      JSON.stringify({ ...result.record, updatedAt: result.record.updatedAt + 1 }),
      'durable-run',
    );
    expect(repository.latestScenarioRunForProject('durable-project')).toBeNull();
  });
});
