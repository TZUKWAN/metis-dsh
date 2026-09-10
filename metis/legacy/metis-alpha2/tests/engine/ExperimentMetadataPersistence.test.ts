import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import {
  decodeExperimentDelete,
  decodeExperimentList,
  decodeExperimentMutationResult,
  decodeExperimentSave,
  type ExperimentMetadata,
} from '../../engine/runtime/ExperimentMetadataContract.js';

const METADATA: ExperimentMetadata = {
  id: 'exp-persist',
  name: 'Persistent experiment',
  description: 'Round-trip',
  status: 'planned',
  parameters: { learning_rate: '0.1' },
  metrics: { score: 0.5 },
  tags: ['reproducible'],
  notes: 'safe',
  linkedPaperIds: ['paper-1'],
  starred: true,
  createdAt: 1,
};

describe('safe experiment metadata persistence', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips every safe field across a SQLite restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-exp-crud-'));
    roots.push(root);
    const dbPath = path.join(root, 'metis.db');
    let store = new PersistenceStore(dbPath);
    store.saveExperimentMetadata(METADATA);
    store.close();
    store = new PersistenceStore(dbPath);
    expect(store.getExperimentMetadata()).toEqual([METADATA]);
    expect(store.updateExperimentRunState('exp-persist', 'completed', { accuracy: 0.9 }))
      .toBe(true);
    expect(store.getExperimentMetadata()[0]).toMatchObject({
      status: 'completed',
      metrics: { score: 0.5, accuracy: 0.9 },
    });
    store.deleteExperimentMetadata('exp-persist');
    expect(store.getExperimentMetadata()).toEqual([]);
    store.close();
  });

  it('never selects legacy script_path or script_type into the safe DTO', () => {
    const store = new PersistenceStore(':memory:');
    try {
      store.saveExperiment({
        ...METADATA,
        scriptPath: 'C:\\secret\\legacy.js',
        scriptType: 'node',
      });
      const presented = store.getExperimentMetadata();
      const decoded = decodeExperimentList(presented);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toMatchObject({
        id: METADATA.id,
        parameters: METADATA.parameters,
        metrics: METADATA.metrics,
      });
      expect(decoded[0]?.starred).toBeUndefined();
      expect(JSON.stringify(presented)).not.toContain('legacy.js');
      expect(Object.keys(presented[0] ?? {})).not.toContain('scriptPath');
      expect(Object.keys(presented[0] ?? {})).not.toContain('scriptType');
    } finally {
      store.close();
    }
  });

  it('uses strict request and result schemas', () => {
    expect(decodeExperimentSave(METADATA)).toEqual(METADATA);
    expect(decodeExperimentSave({ ...METADATA, scriptPath: 'C:\\leak.js' })).toBeNull();
    expect(decodeExperimentSave({ ...METADATA, owner: 'forged' })).toBeNull();
    expect(decodeExperimentDelete({ id: 'exp-persist' })).toBe('exp-persist');
    expect(decodeExperimentDelete({ id: 'exp-persist', owner: 'forged' })).toBeNull();
    expect(decodeExperimentMutationResult({ success: true, code: 'saved' }))
      .toEqual({ success: true, code: 'saved' });
    expect(decodeExperimentMutationResult({ success: true, code: 'saved', scriptPath: 'x' }))
      .toEqual({ success: false, code: 'experiment_metadata_unavailable' });
  });
});
