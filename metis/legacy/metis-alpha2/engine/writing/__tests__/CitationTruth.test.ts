import { describe, expect, it } from 'vitest';
import {
  CitationTruthAttestationSchema,
  citationAttestationMatchesSource,
  isTrustedCitationAttestation,
  parseCitationAst,
} from '../CitationTruth.js';

describe('structured citation truth', () => {
  it('parses author-year, numeric, LaTeX, BibTeX and DOI nodes without string heuristics', () => {
    const text = [
      'Prior work (Smith & Doe, 2024) agrees with [12].',
      String.raw`A separate result uses \citep{jones2023,lee2022}.`,
      '@article{smith2024, title={Evidence}, doi={10.1234/example}}',
      'See https://doi.org/10.5555/direct.1.',
    ].join('\n');
    const ast = parseCitationAst(text);
    expect(ast.map((node) => node.kind)).toEqual(expect.arrayContaining([
      'author_year', 'numeric', 'latex', 'bibtex', 'doi',
    ]));
    expect(ast.find((node) => node.kind === 'latex')?.keys).toEqual(['jones2023', 'lee2022']);
    expect(ast.find((node) => node.kind === 'bibtex')?.keys).toEqual(['smith2024']);
  });

  it('binds an attestation to the actual persisted source identity', () => {
    const attestation = CitationTruthAttestationSchema.parse({
      sourceId: 'source-1', citationKeys: ['smith2024'], identifierType: 'doi',
      identifier: 'https://doi.org/10.1234/EXAMPLE', locator: 'p. 1', triangulation: 'VERIFIED',
      passport: 'verified', retraction: 'clear', journalIntegrity: 'trusted', checkedAt: Date.now(),
    });
    expect(citationAttestationMatchesSource(attestation, {
      id: 'source-1', projectId: 'project-1', identifierType: 'doi', identifier: '10.1234/example', deletedAt: null,
    })).toBe(true);
    expect(citationAttestationMatchesSource(attestation, {
      id: 'source-1', projectId: 'project-1', identifierType: 'doi', identifier: '10.1234/other', deletedAt: null,
    })).toBe(false);
  });

  it('requires locator, verified passport/triangulation, clear retraction and trusted venue', () => {
    const trusted = CitationTruthAttestationSchema.parse({
      sourceId: 'source-1',
      citationKeys: ['smith2024', '12'],
      identifierType: 'doi',
      identifier: '10.1234/example',
      locator: 'p. 14',
      triangulation: 'VERIFIED',
      passport: 'verified',
      retraction: 'clear',
      journalIntegrity: 'trusted',
      checkedAt: Date.now(),
    });
    expect(isTrustedCitationAttestation(trusted)).toEqual({ ok: true, reasons: [] });
    expect(isTrustedCitationAttestation({ ...trusted, retraction: 'retracted' }).ok).toBe(false);
    expect(isTrustedCitationAttestation({ ...trusted, locator: '' }).ok).toBe(false);
    expect(isTrustedCitationAttestation({ ...trusted, triangulation: 'INCONSISTENT' }).ok).toBe(false);
    expect(isTrustedCitationAttestation({ ...trusted, journalIntegrity: 'unknown' }).ok).toBe(false);
  });
});
