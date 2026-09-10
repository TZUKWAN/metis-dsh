/**
 * Tests for BibTeXAuditor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../engine/research/CitationTriangulator.js', () => ({
  triangulateDoi: vi.fn(),
}));

vi.mock('../../engine/research/ArxivResolver.js', () => ({
  resolveArxiv: vi.fn(),
}));

import { parseBibTeX, auditBibTeX, scanLaTeXCitations } from '../../engine/research/BibTeXAuditor.js';
import { triangulateDoi } from '../../engine/research/CitationTriangulator.js';
import { resolveArxiv } from '../../engine/research/ArxivResolver.js';

const sampleBibtex = `
@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John and Doe, Jane},
  year = {2020},
  journal = {Journal of Examples},
  doi = {10.1234/great},
}

@article{jones2021,
  title = {Another Paper},
  author = {Jones, Alice},
  year = {2021},
  journal = {Examples Letters},
  doi = {10.1234/another},
}

@article{duplicate,
  title = {Duplicate Key Paper},
  author = {Bob},
  year = {2022},
  doi = {10.1234/great},
}

@article{duplicate,
  title = {Same Key Again},
  author = {Charlie},
  year = {2022},
  doi = {10.1234/dup},
}

@article{noid,
  title = {No Identifier},
  author = {Unknown},
  year = {2023},
}
`;

describe('parseBibTeX', () => {
  it('parses basic entries', () => {
    const entries = parseBibTeX(sampleBibtex);
    expect(entries).toHaveLength(5);
    expect(entries[0]?.key).toBe('smith2020');
    expect(entries[0]?.fields.title).toBe('A Great Paper');
    expect(entries[0]?.fields.doi).toBe('10.1234/great');
  });

  it('handles nested braces in field values', () => {
    const bib = `@article{nest, title = {A {nested} title}, author = {Name}, year = {2024}}`;
    const entries = parseBibTeX(bib);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fields.title).toBe('A {nested} title');
  });
});

describe('scanLaTeXCitations', () => {
  it('extracts keys from common cite commands', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-tex-scan-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'main.tex'),
      '\\cite{smith2020,jones2021} and \\citep[see][page 1]{noid}.',
      'utf-8',
    );

    const keys = await scanLaTeXCitations(tmpDir);
    expect(keys.has('smith2020')).toBe(true);
    expect(keys.has('jones2021')).toBe(true);
    expect(keys.has('noid')).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe('auditBibTeX', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(triangulateDoi).mockResolvedValue({
      doi: '10.1234/great',
      normalizedDoi: '10.1234/great',
      existsIn: ['crossref', 'openalex'],
      missingIn: [],
      titleConsensus: 'full',
      yearConsensus: 'full',
      authorConsensus: 'full',
      overall: 'VERIFIED',
      records: [],
      warnings: [],
    });
    vi.mocked(resolveArxiv).mockResolvedValue(null);
  });

  it('detects duplicate keys and duplicate DOIs', async () => {
    const result = await auditBibTeX({ bibtex: sampleBibtex });
    expect(result.duplicateKeys).toContain('duplicate');
    expect(result.duplicateDois).toContain('10.1234/great');
    expect(result.summary.duplicateKeys).toBeGreaterThan(0);
    expect(result.summary.duplicateDois).toBeGreaterThan(0);
  });

  it('detects orphan bib entries and orphan citations', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-bib-audit-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const texDir = path.join(tmpDir, 'tex');
    await fs.mkdir(texDir, { recursive: true });
    await fs.writeFile(path.join(texDir, 'main.tex'), '\\cite{smith2020,unknownkey}', 'utf-8');

    const result = await auditBibTeX({ bibtex: sampleBibtex, texDir });

    expect(result.orphanBibEntries).toContain('jones2021');
    expect(result.orphanCitations).toContain('unknownkey');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('flags entries missing identifiers', async () => {
    const result = await auditBibTeX({ bibtex: sampleBibtex });
    const noId = result.entries.find((e) => e.key === 'noid');
    expect(noId?.status).toBe('missing_id');
    expect(noId?.issues.some((i) => i.includes('Missing'))).toBe(true);
  });

  it('marks verified DOIs', async () => {
    const result = await auditBibTeX({ bibtex: sampleBibtex });
    const smith = result.entries.find((e) => e.key === 'smith2020');
    expect(smith?.status).toBe('verified');
    expect(result.summary.verifiedCount).toBeGreaterThanOrEqual(1);
  });

  it('marks not_found when triangulation fails', async () => {
    vi.mocked(triangulateDoi).mockResolvedValue({
      doi: '10.1234/another',
      normalizedDoi: '10.1234/another',
      existsIn: [],
      missingIn: ['crossref', 'openalex', 'semantic_scholar'],
      titleConsensus: 'none',
      yearConsensus: 'none',
      authorConsensus: 'none',
      overall: 'NOT_FOUND',
      records: [],
      warnings: [],
    });

    const result = await auditBibTeX({ bibtex: sampleBibtex });
    const jones = result.entries.find((e) => e.key === 'jones2021');
    expect(jones?.status).toBe('not_found');
  });
});
