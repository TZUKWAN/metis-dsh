/**
 * Tests for experiment_to_findings — bridge from experiment metrics to the
 * durable findings log. Round 312.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PersistenceStore, setSharedStore } from '../../engine/persistence/PersistenceStore.js';
import { listFindings, clearFindings } from '../../engine/workspace/FindingsLog.js';
import { experimentToFindingsHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('experiment_to_findings', () => {
  let originalDataDir: string | undefined;
  let tempBase: string;
  let dataDir: string;
  let workspaceRoot: string;
  let store: PersistenceStore;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-exp-findings-'));
    dataDir = path.join(tempBase, 'data');
    workspaceRoot = path.join(tempBase, 'workspace');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.METIS_DATA_DIR = dataDir;
    store = new PersistenceStore(path.join(tempBase, 'store.db'));
    setSharedStore(store);
  });

  afterEach(async () => {
    store.close();
    setSharedStore(null as unknown as PersistenceStore);
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.promises.rm(tempBase, { recursive: true, force: true });
  });

  function seedExperiment(id: string, overrides: Partial<{ name: string; metrics: Record<string, number>; tags: string[] }> = {}) {
    store.saveExperiment({
      id,
      name: overrides.name ?? `Experiment ${id}`,
      description: 'test',
      status: 'completed',
      parameters: { lr: '3e-5' },
      metrics: overrides.metrics ?? { accuracy: 0.92, f1: 0.88 },
      tags: overrides.tags ?? ['nlp'],
      notes: '',
      linkedPaperIds: [],
      createdAt: Date.now(),
    });
  }

  it('converts each experiment metric into a finding', async () => {
    seedExperiment('exp1', { metrics: { accuracy: 0.92, f1: 0.88, loss: 0.31 } });
    await clearFindings();

    const out = await experimentToFindingsHandler(
      { experimentId: 'exp1' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('Experiment → Findings');
    expect(out).toContain('3 metric(s)');

    const findings = await listFindings();
    expect(findings.length).toBe(3);
    expect(findings.some((f) => f.text.includes('accuracy = 0.92'))).toBe(true);
    expect(findings.some((f) => f.text.includes('f1 = 0.88'))).toBe(true);
    expect(findings.some((f) => f.text.includes('loss = 0.31'))).toBe(true);
  });

  it('tags findings with exp:<id> and the experiment tags', async () => {
    seedExperiment('exp2', { tags: ['vision', 'ablation'] });
    await clearFindings();

    await experimentToFindingsHandler(
      { experimentId: 'exp2' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );

    const findings = await listFindings();
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.tags).toContain('exp:exp2');
      expect(f.tags).toContain('vision');
      expect(f.tags).toContain('ablation');
    }
  });

  it('sets source to exp:<id>', async () => {
    seedExperiment('exp3');
    await clearFindings();

    await experimentToFindingsHandler(
      { experimentId: 'exp3' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );

    const findings = await listFindings();
    expect(findings.every((f) => f.source === 'exp:exp3')).toBe(true);
  });

  it('uses the given confidence (default high)', async () => {
    seedExperiment('exp4');
    await clearFindings();

    await experimentToFindingsHandler(
      { experimentId: 'exp4' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    let findings = await listFindings();
    expect(findings.every((f) => f.confidence === 'high')).toBe(true);

    await clearFindings();
    await experimentToFindingsHandler(
      { experimentId: 'exp4', confidence: 'medium' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    findings = await listFindings();
    expect(findings.every((f) => f.confidence === 'medium')).toBe(true);
  });

  it('appends to findings.md when workspaceRoot is given', async () => {
    seedExperiment('exp5', { metrics: { accuracy: 0.95 } });
    await clearFindings();

    await experimentToFindingsHandler(
      { experimentId: 'exp5', workspaceRoot },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    const md = await fs.promises.readFile(path.join(workspaceRoot, 'findings.md'), 'utf-8');
    expect(md).toContain('accuracy = 0.95');
    expect(md).toContain('exp5');
  });

  it('reports when the experiment has no metrics', async () => {
    seedExperiment('exp6', { metrics: {} });
    const out = await experimentToFindingsHandler(
      { experimentId: 'exp6' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('no metrics');
  });

  it('reports when the experiment id is not found', async () => {
    const out = await experimentToFindingsHandler(
      { experimentId: 'does-not-exist' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('No experiment found');
  });

  it('validates that experimentId is required', async () => {
    const out = await experimentToFindingsHandler(
      {},
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('experimentId is required');
  });

  it('errors when store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const out = await experimentToFindingsHandler(
      { experimentId: 'x' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('not initialized');
  });
});
