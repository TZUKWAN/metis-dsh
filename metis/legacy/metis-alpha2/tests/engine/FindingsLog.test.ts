/**
 * Tests for FindingsLog — durable research findings persistence.
 * Round 311.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { addFinding, listFindings, clearFindings, loadFindingsIndex } from '../../engine/workspace/FindingsLog.js';
import { findingsAddHandler, findingsListHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('FindingsLog', () => {
  let originalDataDir: string | undefined;
  let dataDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    const tempBase = fsSync.mkdtempSync(path.join(os.tmpdir(), 'metis-findings-'));
    dataDir = path.join(tempBase, 'data');
    workspaceRoot = path.join(tempBase, 'workspace');
    fsSync.mkdirSync(dataDir, { recursive: true });
    fsSync.mkdirSync(workspaceRoot, { recursive: true });
    process.env.METIS_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(path.dirname(workspaceRoot), { recursive: true, force: true });
  });

  it('starts with an empty index', async () => {
    const index = await loadFindingsIndex();
    expect(index.findings).toEqual([]);
    expect(index.version).toBe(1);
  });

  it('adds a finding and returns it with an id', async () => {
    const f = await addFinding({ text: 'Transformers outperform RNNs on translation.' });
    expect(f.id).toBeTruthy();
    expect(f.text).toBe('Transformers outperform RNNs on translation.');
    expect(f.confidence).toBe('medium');
    expect(f.createdAt).toBeGreaterThan(0);
  });

  it('normalizes tags to lowercase', async () => {
    const f = await addFinding({ text: 'x', tags: ['NLP', 'Transformers'] });
    expect(f.tags).toEqual(['nlp', 'transformers']);
  });

  it('persists to the JSON index on disk', async () => {
    await addFinding({ text: 'first' });
    await addFinding({ text: 'second' });
    const raw = await fs.readFile(path.join(dataDir, 'findings-index.json'), 'utf-8');
    const index = JSON.parse(raw);
    expect(index.findings).toHaveLength(2);
  });

  it('appends to findings.md when workspaceRoot is given', async () => {
    await addFinding({ text: 'md test', workspaceRoot });
    const md = await fs.readFile(path.join(workspaceRoot, 'findings.md'), 'utf-8');
    expect(md).toContain('# Findings Log');
    expect(md).toContain('md test');
  });

  it('writes the markdown header only once', async () => {
    await addFinding({ text: 'first', workspaceRoot });
    await addFinding({ text: 'second', workspaceRoot });
    const md = await fs.readFile(path.join(workspaceRoot, 'findings.md'), 'utf-8');
    const headerCount = (md.match(/# Findings Log/g) || []).length;
    expect(headerCount).toBe(1);
  });

  it('lists findings most recent first', async () => {
    await addFinding({ text: 'oldest' });
    await addFinding({ text: 'middle' });
    await addFinding({ text: 'newest' });
    const list = await listFindings();
    expect(list.map((f) => f.text)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('filters by tag', async () => {
    await addFinding({ text: 'a', tags: ['nlp'] });
    await addFinding({ text: 'b', tags: ['cv'] });
    await addFinding({ text: 'c', tags: ['nlp'] });
    const filtered = await listFindings({ tag: 'nlp' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((f) => f.tags.includes('nlp'))).toBe(true);
  });

  it('filters by text substring', async () => {
    await addFinding({ text: 'attention is all you need' });
    await addFinding({ text: 'residual learning' });
    const filtered = await listFindings({ contains: 'attention' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.text).toContain('attention');
  });

  it('filters by confidence', async () => {
    await addFinding({ text: 'a', confidence: 'low' });
    await addFinding({ text: 'b', confidence: 'high' });
    const filtered = await listFindings({ confidence: 'high' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.confidence).toBe('high');
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i++) await addFinding({ text: `f${i}` });
    expect((await listFindings({ limit: 2 })).length).toBe(2);
  });

  it('rejects empty text', async () => {
    await expect(addFinding({ text: '   ' })).rejects.toThrow(/empty/i);
  });

  it('clearFindings empties the index', async () => {
    await addFinding({ text: 'a' });
    await addFinding({ text: 'b' });
    const result = await clearFindings();
    expect(result.cleared).toBe(2);
    expect((await loadFindingsIndex()).findings).toEqual([]);
  });

  // --- handler integration ---

  it('findingsAddHandler validates required text', async () => {
    const out = await findingsAddHandler({}, { sessionId: 't', workspace: workspaceRoot, turnIndex: 0 });
    expect(out).toContain('required');
  });

  it('findingsAddHandler logs and returns the finding', async () => {
    const out = await findingsAddHandler(
      { text: 'Handler finding', tags: ['test'], confidence: 'high', source: 'paper-1' },
      { sessionId: 't', workspace: workspaceRoot, turnIndex: 0 },
    );
    expect(out).toContain('Finding Logged');
    expect(out).toContain('Handler finding');
    expect(out).toContain('high');
    expect(out).toContain('test');
    expect(out).toContain('paper-1');
    expect(out).toContain('Raw JSON');
  });

  it('findingsAddHandler appends to findings.md when workspaceRoot passed', async () => {
    await findingsAddHandler(
      { text: 'Workspace finding', workspaceRoot },
      { sessionId: 't', workspace: workspaceRoot, turnIndex: 0 },
    );
    const md = await fs.readFile(path.join(workspaceRoot, 'findings.md'), 'utf-8');
    expect(md).toContain('Workspace finding');
  });

  it('findingsListHandler reports empty log', async () => {
    const out = await findingsListHandler({}, { sessionId: 't', workspace: workspaceRoot, turnIndex: 0 });
    expect(out).toContain('No findings');
  });

  it('findingsListHandler lists recorded findings', async () => {
    await addFinding({ text: 'first finding', tags: ['x'] });
    await addFinding({ text: 'second finding' });
    const out = await findingsListHandler({}, { sessionId: 't', workspace: workspaceRoot, turnIndex: 0 });
    expect(out).toContain('Findings Log');
    expect(out).toContain('second finding'); // most recent first
    expect(out).toContain('first finding');
    expect(out).toContain('Raw JSON');
  });
});
