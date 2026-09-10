/**
 * Tests for findings_export — portable export of research findings.
 * Round 314.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { addFinding, clearFindings, exportFindings } from '../../engine/workspace/FindingsLog.js';
import { findingsExportHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('findings_export', () => {
  let originalDataDir: string | undefined;
  let dataDir: string;
  let tempBase: string;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempBase = fsSync.mkdtempSync(path.join(os.tmpdir(), 'metis-fexport-'));
    dataDir = path.join(tempBase, 'data');
    fsSync.mkdirSync(dataDir, { recursive: true });
    process.env.METIS_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempBase, { recursive: true, force: true });
  });

  async function seed() {
    await clearFindings();
    await addFinding({ text: 'Attention is O(n^2).', tags: ['complexity', 'transformer'], confidence: 'high', source: 'paper:a' });
    await addFinding({ text: 'Sparse attention helps.', tags: ['complexity', 'sparse'], confidence: 'medium', source: 'paper:b' });
    await addFinding({ text: 'We achieved 92 F1.', tags: ['experiment', 'results'], confidence: 'high', source: 'exp:1' });
  }

  it('exports markdown grouped by tag', async () => {
    await seed();
    const result = await exportFindings({ format: 'markdown' });
    expect(result.format).toBe('markdown');
    expect(result.count).toBe(3);
    expect(result.content).toContain('# Findings Export');
    expect(result.content).toContain('Attention is O(n^2)');
    expect(result.content).toContain('## complexity'); // first tag groups
  });

  it('exports json as a pretty-printed array', async () => {
    await seed();
    const result = await exportFindings({ format: 'json' });
    expect(result.format).toBe('json');
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);
    expect(parsed[0].text).toBeTruthy();
  });

  it('exports csv with header and quoted fields', async () => {
    await seed();
    const result = await exportFindings({ format: 'csv' });
    expect(result.format).toBe('csv');
    const lines = result.content.split('\n');
    expect(lines[0]).toBe('id,date,confidence,source,tags,text');
    expect(lines.length).toBe(4); // header + 3 rows
    // Text with no comma still quoted
    expect(result.content).toContain('"Attention is O(n^2)."');
  });

  it('csv escapes embedded quotes (RFC-4180)', async () => {
    await clearFindings();
    await addFinding({ text: 'She said "hello" to the model.', tags: ['quote'] });
    const result = await exportFindings({ format: 'csv' });
    // Embedded double-quotes should be doubled.
    expect(result.content).toContain('""hello""');
  });

  it('defaults to markdown when format is omitted', async () => {
    await seed();
    const result = await exportFindings();
    expect(result.format).toBe('markdown');
  });

  it('filters by tag', async () => {
    await seed();
    const result = await exportFindings({ format: 'json', tag: 'complexity' });
    const parsed = JSON.parse(result.content);
    expect(parsed.length).toBe(2);
    expect(parsed.every((f: { tags: string[] }) => f.tags.includes('complexity'))).toBe(true);
  });

  it('filters by confidence', async () => {
    await seed();
    const result = await exportFindings({ format: 'json', confidence: 'high' });
    const parsed = JSON.parse(result.content);
    expect(parsed.length).toBe(2);
    expect(parsed.every((f: { confidence: string }) => f.confidence === 'high')).toBe(true);
  });

  it('filters by text substring', async () => {
    await seed();
    const result = await exportFindings({ format: 'json', contains: 'attention' });
    const parsed = JSON.parse(result.content);
    expect(parsed.length).toBe(2);
  });

  it('writes to disk when filePath is given', async () => {
    await seed();
    const filePath = path.join(tempBase, 'export.md');
    const result = await exportFindings({ format: 'markdown', filePath });
    expect(result.filePath).toBe(filePath);
    const onDisk = await fs.readFile(filePath, 'utf-8');
    expect(onDisk).toContain('Attention is O(n^2)');
  });

  it('returns count 0 and empty content when no findings match', async () => {
    await clearFindings();
    const result = await exportFindings({ format: 'markdown' });
    expect(result.count).toBe(0);
  });

  it('creates parent directories for filePath if needed', async () => {
    await seed();
    const filePath = path.join(tempBase, 'nested', 'dir', 'export.json');
    const result = await exportFindings({ format: 'json', filePath });
    expect(result.filePath).toBe(filePath);
    expect(fsSync.existsSync(filePath)).toBe(true);
  });

  // --- handler integration ---

  it('findingsExportHandler returns markdown inline by default', async () => {
    await seed();
    const out = await findingsExportHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('# Findings Export');
    expect(out).toContain('Attention is O(n^2)');
  });

  it('findingsExportHandler returns json when format=json', async () => {
    await seed();
    const out = await findingsExportHandler({ format: 'json' }, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('findingsExportHandler writes to filePath and reports path', async () => {
    await seed();
    const filePath = path.join(tempBase, 'out.csv');
    const out = await findingsExportHandler({ format: 'csv', filePath }, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Findings Exported');
    expect(out).toContain(filePath);
    expect(fsSync.existsSync(filePath)).toBe(true);
  });

  it('findingsExportHandler reports empty when no findings', async () => {
    await clearFindings();
    const out = await findingsExportHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('No findings');
  });

  it('findingsExportHandler respects tag filter', async () => {
    await seed();
    const out = await findingsExportHandler({ format: 'json', tag: 'experiment' }, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    const parsed = JSON.parse(out);
    expect(parsed.length).toBe(1);
    expect(parsed[0].tags).toContain('experiment');
  });
});
