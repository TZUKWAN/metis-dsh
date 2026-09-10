
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import type {
  PersonalizationDefinition,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';

const FIXED_TIME = 1_800_000_000_000;
const INTEGRITY_SECRET = Buffer.from('integration-manifest-secret-32-bytes-minimum');

const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function createHarness() {
  const db = new Database(':memory:');
  databases.push(db);
  const repository = new PersonalizationRepository(db, INTEGRITY_SECRET);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
  const runtime = new PersonalizationRuntimeService(repository, INTEGRITY_SECRET);
  return { repository, runtime };
}

function userSkillDefinition(input: { id: string; name?: string }): SkillDefinitionV2 {
  return {
    contractVersion: 1,
    id: input.id,
    kind: 'skill',
    name: input.name ?? '我的技能',
    description: 'Renderer-authored markdown skill for delete tests.',
    enabled: true,
    tags: ['integration'],
    revision: 1,
    provenance: {
      origin: 'user',
      author: 'Integration test',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    },
    sourceMode: 'markdown',
    markdown: '# 我的技能\n\n删除测试用技能定义。',
    systemPrompt: 'You are a test skill.',
    toolIds: [],
    mcpIds: [],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
}

function expectSaved<T extends PersonalizationDefinition>(result: ReturnType<PersonalizationRuntimeService['save']>): T {
  expect(result).toMatchObject({ ok: true, code: 'saved' });
  if (!result.ok || result.code !== 'saved') throw new Error(`save failed: ${result.code}`);
  return result.definition as T;
}

function expectDeleted(result: ReturnType<PersonalizationRuntimeService['deletePermanent']>): void {
  expect(result).toMatchObject({ ok: true, code: 'deleted' });
}

describe('permanent skill deletion', () => {
  it('permanently removes a user skill together with its version history and reports cleanup', () => {
    const { repository, runtime } = createHarness();
    const saved = expectSaved<SkillDefinitionV2>(runtime.save({
      contractVersion: 1,
      definition: userSkillDefinition({ id: 'user:skills/delete-me' }),
      expectedRevision: 0,
    }));
    expect(repository.listVersions(saved.id).length).toBeGreaterThan(0);
    const cleanedUp: string[] = [];
    expectDeleted(runtime.deletePermanent(
      { contractVersion: 1, id: saved.id, expectedRevision: saved.revision },
      (definition) => { cleanedUp.push(definition.id); },
    ));
    expect(cleanedUp).toEqual([saved.id]);
    expect(repository.get(saved.id, true)).toBeUndefined();
    expect(repository.listVersions(saved.id)).toEqual([]);
    expect(repository.list('skill', true).some((definition) => definition.id === saved.id)).toBe(false);
  });

  it('keeps built-in skills factory protected', () => {
    const { repository, runtime } = createHarness();
    const builtinSkill = repository.list('skill').find((definition) => definition.provenance.origin === 'builtin');
    if (!builtinSkill) throw new Error('Fixture is missing a built-in skill');
    const result = runtime.deletePermanent({ contractVersion: 1, id: builtinSkill.id, expectedRevision: builtinSkill.revision });
    expect(result).toMatchObject({ ok: false, code: 'factory_protected' });
    expect(repository.get(builtinSkill.id)).toBeDefined();
  });

  it('rejects a stale expected revision instead of deleting', () => {
    const { repository, runtime } = createHarness();
    const saved = expectSaved<SkillDefinitionV2>(runtime.save({
      contractVersion: 1,
      definition: userSkillDefinition({ id: 'user:skills/stale-revision' }),
      expectedRevision: 0,
    }));
    const updated = expectSaved<SkillDefinitionV2>(runtime.save({
      contractVersion: 1,
      definition: {
        ...saved,
        revision: saved.revision + 1,
        description: 'Updated past the stale revision.',
        provenance: { ...saved.provenance, updatedAt: FIXED_TIME + 1 },
      },
      expectedRevision: saved.revision,
    }));
    const result = runtime.deletePermanent({ contractVersion: 1, id: saved.id, expectedRevision: saved.revision });
    expect(result).toMatchObject({ ok: false, code: 'revision_conflict', currentRevision: updated.revision });
    expect(repository.get(saved.id)).toBeDefined();
  });

  it('fails closed while an active scenario references the skill and allows deletion after the scenario is archived', () => {
    const { repository, runtime } = createHarness();
    const skill = expectSaved<SkillDefinitionV2>(runtime.save({
      contractVersion: 1,
      definition: userSkillDefinition({ id: 'user:skills/referenced' }),
      expectedRevision: 0,
    }));
    const forkResult = runtime.fork({
      contractVersion: 1,
      sourceId: 'builtin:scenarios/general-research',
      targetId: 'user:scenarios/referencing-scenario',
      author: 'Integration test',
    });
    const forked = expectSaved<ScenarioDefinition>(forkResult);
    const referencing = expectSaved<ScenarioDefinition>(runtime.save({
      contractVersion: 1,
      definition: {
        ...forked,
        revision: forked.revision + 1,
        skillIds: [skill.id],
        workflow: forked.workflow.map((step) => ({ ...step, skillIds: [skill.id] })),
        provenance: { ...forked.provenance, updatedAt: FIXED_TIME + 1 },
      },
      expectedRevision: forked.revision,
    }));
    const blocked = runtime.deletePermanent({ contractVersion: 1, id: skill.id, expectedRevision: skill.revision });
    expect(blocked).toMatchObject({ ok: false, code: 'dependency_invalid' });
    if (blocked.ok || blocked.code !== 'dependency_invalid') throw new Error('Expected dependency_invalid');
    expect(blocked.issues).toContain(`scenario:${referencing.id}`);
    expect(repository.get(skill.id)).toBeDefined();
    const archivedScenario = runtime.archive({
      contractVersion: 1,
      id: referencing.id,
      expectedRevision: referencing.revision,
    });
    expect(archivedScenario).toMatchObject({ ok: true, code: 'deleted' });
    expectDeleted(runtime.deletePermanent({ contractVersion: 1, id: skill.id, expectedRevision: skill.revision }));
    expect(repository.get(skill.id, true)).toBeUndefined();
  });

  it('purges an already archived skill permanently', () => {
    const { repository, runtime } = createHarness();
    const saved = expectSaved<SkillDefinitionV2>(runtime.save({
      contractVersion: 1,
      definition: userSkillDefinition({ id: 'user:skills/archived-then-purged' }),
      expectedRevision: 0,
    }));
    expect(runtime.archive({ contractVersion: 1, id: saved.id, expectedRevision: saved.revision }))
      .toMatchObject({ ok: true, code: 'deleted' });
    expect(repository.get(saved.id)).toBeUndefined();
    expect(repository.get(saved.id, true)).toBeDefined();
    expectDeleted(runtime.deletePermanent({ contractVersion: 1, id: saved.id, expectedRevision: saved.revision }));
    expect(repository.get(saved.id, true)).toBeUndefined();
    expect(repository.listArchived('skill').some((item) => item.definition.id === saved.id)).toBe(false);
  });

  it('reports not_found for unknown ids and invalid_request for malformed requests', () => {
    const { runtime } = createHarness();
    expect(runtime.deletePermanent({ contractVersion: 1, id: 'user:skills/missing', expectedRevision: 1 }))
      .toMatchObject({ ok: false, code: 'not_found' });
    // Malformed payloads must never reach the repository layer.
    expect(runtime.deletePermanent({ contractVersion: 1, id: '', expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: 'invalid_request' });
    expect(runtime.deletePermanent(null)).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('treats asset cleanup failures as non-fatal after a successful commit', () => {
    const { repository, runtime } = createHarness();
    const saved = expectSaved<SkillDefinitionV2>(runtime.save({
      contractVersion: 1,
      definition: userSkillDefinition({ id: 'user:skills/cleanup-throws' }),
      expectedRevision: 0,
    }));
    expectDeleted(runtime.deletePermanent(
      { contractVersion: 1, id: saved.id, expectedRevision: saved.revision },
      () => { throw new Error('installer exploded'); },
    ));
    expect(repository.get(saved.id, true)).toBeUndefined();
  });
});
