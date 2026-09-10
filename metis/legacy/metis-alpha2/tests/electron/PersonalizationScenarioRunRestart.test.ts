import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { loadOrCreateCitationTruthSecret } from '../../electron/CitationTruthKeyStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import type { ScenarioRunRecord } from '../../engine/personalization/ScenarioRunCoordinator.js';

const directories: string[] = [];

const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value: Buffer) => {
    const text = value.toString('utf8');
    if (!text.startsWith('protected:')) throw new Error('invalid ciphertext');
    return text.slice('protected:'.length);
  },
};

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-personalization-run-restart-'));
  directories.push(directory);
  return directory;
}

function record(): ScenarioRunRecord {
  return {
    recordVersion: 1,
    runId: 'scenario-restart-run',
    manifestDigest: 'a'.repeat(64),
    manifestSnapshot: {
      contractVersion: 1,
      sessionId: 'session-restart',
      projectId: 'project-restart',
      scenarioId: 'user:scenarios/restart',
      scenarioRevision: 1,
      definitionRevisions: { 'user:scenarios/restart': 1 },
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      allowedTools: [],
      workflow: [],
      maxTurns: 1,
      promptStack: [],
      fullAccess: {
        mode: 'full_access',
        perActionConfirmation: false,
        liveSteering: true,
        silentCheckpoints: true,
        rollbackOnFailure: false,
        persistAcrossRestart: true,
      },
      memory: { scope: 'session', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 1_000 },
      output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
      truthPolicy: 'automatic_required',
      createdAt: 1_785_394_400_000,
      manifestDigest: 'a'.repeat(64),
    },
    status: 'paused',
    workflowIteration: 1,
    workflowIterationsCompleted: 0,
    backtrackCount: 0,
    totalStepExecutions: 0,
    executionOrder: [],
    steps: [],
    failureStepIds: [],
    startedAt: 1_785_394_400_000,
    updatedAt: 1_785_394_400_001,
    completedAt: null,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* test cleanup only */ }
  }
});

describe('scenario run persistence across process restarts', () => {
  it('reuses the protected persistent key to verify a saved paused run after reopening SQLite', () => {
    const directory = temporaryDirectory();
    const dbPath = path.join(directory, 'metis.db');
    const firstSecret = loadOrCreateCitationTruthSecret(directory, protector);
    expect(firstSecret).toHaveLength(32);
    let firstDb: Database.Database | undefined;
    let restartedDb: Database.Database | undefined;
    try {
      firstDb = new Database(dbPath);
      const firstRepository = new PersonalizationRepository(firstDb, firstSecret ?? undefined);
      const saved = firstRepository.saveScenarioRunRecord(record());
      firstDb.close();
      firstDb = undefined;

      const restartedSecret = loadOrCreateCitationTruthSecret(directory, protector);
      expect(restartedSecret).toEqual(firstSecret);
      restartedDb = new Database(dbPath);
      const restartedRepository = new PersonalizationRepository(restartedDb, restartedSecret ?? undefined);
      expect(restartedRepository.getRecoverableScenarioRun('session-restart')).toEqual(saved);
      expect(restartedRepository.latestScenarioRunForProject('project-restart')).toEqual(saved);
    } finally {
      firstDb?.close();
      restartedDb?.close();
    }
  });

  it('does not create a scenario run when the durable integrity key is unavailable', () => {
    const directory = temporaryDirectory();
    const db = new Database(path.join(directory, 'metis.db'));
    const repository = new PersonalizationRepository(db);
    expect(() => repository.saveScenarioRunRecord(record())).toThrow('Scenario run integrity key is unavailable');
    expect(db.prepare('SELECT COUNT(*) AS total FROM personalization_scenario_runs').get()).toEqual({ total: 0 });
    db.close();
  });
});
