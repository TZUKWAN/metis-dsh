import { describe, it, expect } from 'vitest';
import { runExportGates } from '../ExportGate.js';
import type { ResearchExportRecord } from '../../export/ResearchExportBuilder.js';
import type { ExportScope } from '../../runtime/ExportRuntimeContract.js';

function rec(id: string, content: string, fields: { key: string; value: string }[] = []): ResearchExportRecord {
  return {
    id, title: `Record ${id}`, content,
    sensitivity: 'none',
    fields: fields.map((f) => ({ key: f.key, value: f.value, sensitivity: 'none' })),
    images: [],
  };
}

function map(scope: ExportScope, records: ResearchExportRecord[]): Map<ExportScope, ResearchExportRecord[]> {
  const m = new Map<ExportScope, ResearchExportRecord[]>();
  m.set(scope, records);
  return m;
}

describe('ExportGate', () => {
  it('privacy gate BLOCKS export when sensitive fields remain with non-local profile', () => {
    const records = map('project', [rec('r1', 'content')]);
    const result = runExportGates(records, 'public-share', true);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.gate === 'privacy' && i.severity === 'error')).toBe(true);
  });

  it('privacy gate passes with sensitive fields and private-local profile', () => {
    const records = map('project', [rec('r1', 'content')]);
    const result = runExportGates(records, 'private-local', true);
    expect(result.passed).toBe(true);
  });

  it('privacy gate passes with no sensitive fields and public profile', () => {
    const records = map('project', [rec('r1', 'content')]);
    const result = runExportGates(records, 'public-share', false);
    expect(result.passed).toBe(true);
  });

  it('citation gate warns on unresolved citation references', () => {
    const records = map('project', [
      rec('r1', 'As shown in [cite:s1], the method works.'),
    ]);
    const result = runExportGates(records, 'public-share', false);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.gate === 'citation' && i.severity === 'error')).toBe(true);
  });

  it('number gate warns on numeric claims without evidence', () => {
    const records = map('project', [
      rec('r1', 'The accuracy improved by 25% over the baseline.'),
    ]);
    const result = runExportGates(records, 'public-share', false);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.gate === 'number' && i.severity === 'error')).toBe(true);
  });

  it('evidence gate warns when audit exists but no evidence', () => {
    const m = new Map<ExportScope, ResearchExportRecord[]>();
    m.set('audit', [rec('a1', 'audit log entry')]);
    const result = runExportGates(m, 'public-share', false);
    expect(result.issues.some((i) => i.gate === 'evidence')).toBe(true);
  });

  it('all gates pass on clean data', () => {
    const m = new Map<ExportScope, ResearchExportRecord[]>();
    m.set('project', [rec('r1', 'Clean content without issues.')]);
    m.set('evidence', [rec('e1', 'Supporting evidence.')]);
    const result = runExportGates(m, 'public-share', false);
    expect(result.passed).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('figure gate warns on figure references without artifacts', () => {
    const records = map('project', [
      rec('r1', 'As shown in Figure 1, the results are clear.'),
    ]);
    const result = runExportGates(records, 'public-share', false);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.gate === 'figure' && i.severity === 'error')).toBe(true);
  });

  it.each([
    'Research shows 73% success (Doe, 2024). DOI:10.9999/fabricated.123',
    String.raw`The result follows from \cite{totally-fake-2024}.`,
    'The result follows from [12].',
  ])('blocks every unresolved citation syntax: %s', (content) => {
    const result = runExportGates(map('artifact', [rec('r1', content)]), 'public-share', false);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.gate === 'citation' && issue.severity === 'error')).toBe(true);
  });

  it('accepts a resolved author-year citation only with a complete truth attestation', () => {
    const records = new Map<ExportScope, ResearchExportRecord[]>();
    records.set('project', [rec('r1', 'The result is established (Smith, 2024).')]);
    records.set('citations', [rec('source-1', 'Smith. Exact Evidence Title. 2024.', [
      { key: 'citationKeys', value: 'Smith, 2024' },
      { key: 'authors', value: 'Alice Smith' },
      { key: 'year', value: '2024' },
      { key: 'identifierType', value: 'doi' },
      { key: 'identifier', value: '10.1234/example' },
      { key: 'locator', value: 'p. 14' },
      { key: 'triangulation', value: 'VERIFIED' },
      { key: 'passport', value: 'verified' },
      { key: 'retraction', value: 'clear' },
      { key: 'journalIntegrity', value: 'trusted' },
      { key: 'checkedAt', value: String(Date.now()) },
    ])]);
    expect(runExportGates(records, 'public-share', false)).toEqual({ passed: true, issues: [] });
  });

  it.each([
    ['triangulation', 'INCONSISTENT'],
    ['passport', 'missing'],
    ['retraction', 'retracted'],
    ['journalIntegrity', 'unknown'],
    ['locator', ''],
  ])('blocks a citation with invalid %s truth', (key, value) => {
    const fields = new Map<string, string>([
      ['citationKeys', 'smith2024'],
      ['identifierType', 'doi'],
      ['identifier', '10.1234/example'],
      ['locator', 'p. 14'],
      ['triangulation', 'VERIFIED'],
      ['passport', 'verified'],
      ['retraction', 'clear'],
      ['journalIntegrity', 'trusted'],
      ['checkedAt', String(Date.now())],
    ]);
    fields.set(key, value);
    fields.set('bibliographyKey', 'smith2024');
    const records = new Map<ExportScope, ResearchExportRecord[]>();
    records.set('project', [rec('r1', String.raw`Result \cite{smith2024}.`)]);
    records.set('citations', [rec('source-1', 'Citation', [...fields].map(([fieldKey, fieldValue]) => ({ key: fieldKey, value: fieldValue })))]);
    const result = runExportGates(records, 'public-share', false);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.gate === 'citation_truth' && issue.severity === 'error')).toBe(true);
  });

  it('requires each numeric claim to bind a real evidence record', () => {
    const missing = runExportGates(map('project', [rec('r1', 'Accuracy improved by 25%.')]), 'public-share', false);
    expect(missing.passed).toBe(false);

    const records = new Map<ExportScope, ResearchExportRecord[]>();
    records.set('project', [rec('r1', 'Accuracy improved by 25% [evidence:e1].')]);
    records.set('evidence', [rec('e1', 'Measured accuracy delta: 25%.')]);
    expect(runExportGates(records, 'public-share', false)).toEqual({ passed: true, issues: [] });
  });

  it('detects numeric claims adjacent to Chinese text', () => {
    const result = runExportGates(map('project', [rec('r1', '成功率达73%（经复核）。')]), 'public-share', false);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.gate === 'number')).toBe(true);
  });

  it('blocks legacy/unverified artifact exports and accepts a verified profile binding', () => {
    const legacy = map('artifact', [rec('artifact-1', 'Clean prose.')]);
    expect(runExportGates(legacy, 'public-share', false).passed).toBe(false);

    const verified = map('artifact', [rec('artifact-1', 'Clean prose.', [
      { key: 'reviewStatus', value: 'verified' },
      { key: 'deliverableProfileId', value: 'sci' },
      { key: 'deliverableProfileSchemaVersion', value: '1' },
      { key: 'deliverableProfileVersion', value: '1.0.0' },
    ])]);
    expect(runExportGates(verified, 'public-share', false)).toEqual({ passed: true, issues: [] });
  });

  it('figure gate recognizes a validated image record as figure backing', () => {
    const records = new Map<ExportScope, ResearchExportRecord[]>();
    records.set('project', [rec('r1', 'As shown in Figure 1, the results are clear.')]);
    records.set('artifact', [{
      ...rec('a1', 'Embedded figure'),
      images: [{
        id: 'image-1',
        mediaType: 'image/png',
        base64Data: 'AA==',
        sha256: '0'.repeat(64),
        widthPx: 1,
        heightPx: 1,
        caption: 'Figure 1',
      }],
    }]);
    const result = runExportGates(records, 'public-share', false);
    expect(result.issues.some((i) => i.gate === 'figure')).toBe(false);
  });
});
