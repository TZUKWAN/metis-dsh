import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationBundleService } from '../../electron/PersonalizationBundleService.js';
import { PersonalizationBundleRepositorySink } from '../../electron/PersonalizationBundleRepositorySink.js';

describe('PersonalizationBundleRepositorySink', () => {
  let sourceDb: Database.Database;
  let targetDb: Database.Database;
  let source: PersonalizationRepository;
  let target: PersonalizationRepository;
  let importRoot: string;

  beforeEach(() => {
    sourceDb = new Database(':memory:');
    targetDb = new Database(':memory:');
    source = new PersonalizationRepository(sourceDb);
    target = new PersonalizationRepository(targetDb);
    const builtins = buildBuiltinPersonalizationDefinitions();
    source.seedBuiltins(builtins);
    target.seedBuiltins(builtins);
    importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-personalization-bundle-repo-'));
  });

  afterEach(() => {
    sourceDb.close();
    targetDb.close();
    fs.rmSync(importRoot, { recursive: true, force: true });
  });

  it('round-trips a custom scenario graph into the real repository atomically', async () => {
    const fork = source.forkBuiltin(
      'builtin:scenarios/general-research',
      'user:scenarios/shared-research',
      'Bundle author',
      200,
    );
    expect(fork.ok).toBe(true);
    const service = new PersonalizationBundleService(importRoot, { now: () => 300 });
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:scenarios/shared-research'],
      assetMode: 'none',
      createdBy: 'Bundle author',
    }, { get: (id) => source.get(id) });
    const sink = new PersonalizationBundleRepositorySink(target);

    const imported = await service.importBundle(exported.bytes, sink);

    expect(imported.ok).toBe(true);
    expect(target.get('user:scenarios/shared-research')).toEqual(source.get('user:scenarios/shared-research'));
    expect(target.getFactory('builtin:scenarios/general-research'))
      .toEqual(source.getFactory('builtin:scenarios/general-research'));
    expect(await service.importBundle(exported.bytes, sink)).toEqual({ ok: false, code: 'existing_conflict' });
  });

  it('rolls back the whole repository batch when one imported dependency is absent', () => {
    const sourceScenario = source.forkBuiltin(
      'builtin:scenarios/general-research',
      'user:scenarios/broken-import',
      'Bundle author',
      200,
    );
    expect(sourceScenario.ok).toBe(true);
    const definition = source.get('user:scenarios/broken-import');
    if (!definition || definition.kind !== 'scenario') throw new Error('Expected custom scenario');
    const broken = {
      ...definition,
      id: 'user:scenarios/atomic-broken',
      agentIds: ['user:agents/missing'],
      workflow: definition.workflow.map((step) => ({ ...step, agentId: 'user:agents/missing' })),
    };

    expect(() => target.importDefinitionsAtomically([{ definition: broken }])).toThrow(/dependency is missing/u);
    expect(target.get('user:scenarios/atomic-broken')).toBeUndefined();
  });
});
