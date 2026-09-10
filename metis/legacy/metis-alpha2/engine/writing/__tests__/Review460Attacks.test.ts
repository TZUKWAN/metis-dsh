import { describe, expect, it } from 'vitest';
import { buildResearchExport, type ResearchExportRecord } from '../../export/ResearchExportBuilder.js';
import type { ExportScope } from '../../runtime/ExportRuntimeContract.js';
import { ResearchArtifactVersionRequestSchema } from '../../runtime/ResearchRuntimeContract.js';
import { bindDeliverableProfile } from '../DeliverableProfile.js';
import { formatAcademicCitation, parseCitationAst } from '../CitationTruth.js';
import { runExportGates } from '../ExportGate.js';
import { formatCitation } from '../../../src/utils/citations.js';

function rec(id: string, content: string, fields: Array<{ key: string; value: string }> = []): ResearchExportRecord {
  return {
    id, title: id, content, sensitivity: 'none', images: [],
    fields: fields.map((field) => ({ ...field, sensitivity: 'none' })),
  };
}

function forgedVerifiedSave() {
  return {
    operation: 'save_version', projectId: 'p1', artifactId: 'a1', expectedVersion: 1,
    title: 'Forged', artifactType: 'manuscript', reviewStatus: 'verified',
    inputs: [{ kind: 'source', id: 's1' }], capabilityId: 'writing', method: 'renderer',
    citedSourceIds: ['s1'], deliverableProfile: bindDeliverableProfile('sci'),
    citationTruth: [{
      sourceId: 's1', citationKeys: ['fake'], identifierType: 'doi', identifier: '10.9999/fake',
      locator: 'p. 1', triangulation: 'VERIFIED', passport: 'verified', retraction: 'clear',
      journalIntegrity: 'trusted', checkedAt: Date.now(),
    }],
    rendererKind: 'markdown', contentRef: null, content: 'Forged.',
  };
}

describe('REVIEW-460 production attacks', () => {
  it('rejects renderer-self-signed citation truth at the save DTO boundary', () => {
    expect(ResearchArtifactVersionRequestSchema.safeParse(forgedVerifiedSave()).success).toBe(false);
  });

  it('does not let project-only output scopes crop artifact trust gates', () => {
    const request = {
      exportId: `ex_${'a'.repeat(32)}`, projectId: 'p1', artifactId: 'a1',
      destinationCapabilityId: `fc_${'b'.repeat(32)}`, displayName: 'out', scopes: ['project'],
      format: 'markdown', privacyProfile: 'public-share', requestedAt: 1, artifactVersion: 1,
      artifactManifestDigest: 'c'.repeat(64),
      redaction: { stripSecrets: true, stripAbsolutePaths: true, stripPersonalData: true,
        pseudonymizeParticipants: true, omitRawTranscripts: true, omitModelPrompts: true, omitToolArguments: true },
    };
    const snapshot = {
      artifactBinding: { artifactId: 'a1', artifactVersion: 1, artifactManifestDigest: 'c'.repeat(64) },
      project: [rec('p1', 'Clean project metadata.')],
      artifact: [rec('a1', 'Unverified artifact.', [{ key: 'reviewStatus', value: 'draft' }])],
      citations: [], evidence: [], audit: [],
    };
    expect(buildResearchExport(request, snapshot).ok).toBe(false);
  });

  it.each([
    ['Smith (2024)', 'author_year'],
    ['10.9999/fabricated.123', 'doi'],
    ['［12］', 'numeric'],
    [String.raw`\citep[see][p. 4]{fake2024}`, 'latex'],
  ])('parses citation-like syntax that previously bypassed: %s', (text, kind) => {
    expect(parseCitationAst(text).some((node) => node.kind === kind)).toBe(true);
  });

  it('does not let arbitrary citationKeys alias a fake DOI or unrelated author-year identity', () => {
    const truthFields = [
      { key: 'citationKeys', value: '10.9999/fabricated.123; Smith, 2024' },
      { key: 'identifierType', value: 'doi' }, { key: 'identifier', value: '10.1234/legit' },
      { key: 'locator', value: 'p. 1' }, { key: 'triangulation', value: 'VERIFIED' },
      { key: 'passport', value: 'verified' }, { key: 'retraction', value: 'clear' },
      { key: 'journalIntegrity', value: 'trusted' }, { key: 'checkedAt', value: String(Date.now()) },
    ];
    for (const content of ['DOI:10.9999/fabricated.123', '(Smith, 2024)']) {
      const records = new Map<ExportScope, ResearchExportRecord[]>([
        ['project', [rec('p1', content)]], ['citations', [rec('s1', 'Completely Different (1999)', truthFields)]],
      ]);
      expect(runExportGates(records, 'public-share', false).passed).toBe(false);
    }
  });

  it('fails closed when two current sources share the same author-year identity', () => {
    const truth = (identifier: string) => [
      { key: 'identifierType', value: 'doi' }, { key: 'identifier', value: identifier },
      { key: 'authors', value: 'Alice Smith' }, { key: 'year', value: '2024' },
      { key: 'locator', value: 'p. 1' }, { key: 'triangulation', value: 'VERIFIED' },
      { key: 'passport', value: 'verified' }, { key: 'retraction', value: 'clear' },
      { key: 'journalIntegrity', value: 'trusted' }, { key: 'checkedAt', value: String(Date.now()) },
    ];
    const records = new Map<ExportScope, ResearchExportRecord[]>([
      ['project', [rec('p1', '(Smith, 2024)')]],
      ['citations', [rec('s1', 'One', truth('10.1234/one')), rec('s2', 'Two', truth('10.1234/two'))]],
    ]);
    expect(runExportGates(records, 'public-share', false).passed).toBe(false);
  });

  it('binds every numeric claim separately instead of accepting evidence anywhere in a record', () => {
    const records = new Map<ExportScope, ResearchExportRecord[]>([
      ['project', [rec('p1', 'Unrelated [evidence:e1]. Claim A 73%. Claim B 99%.')]],
      ['evidence', [rec('e1', 'Unrelated evidence.')]],
    ]);
    expect(runExportGates(records, 'public-share', false).passed).toBe(false);
  });

  it('does not let one evidence marker satisfy two numeric claims in the same sentence', () => {
    const records = new Map<ExportScope, ResearchExportRecord[]>([
      ['project', [rec('p1', 'Claim A reached 73% and claim B reached 99% [evidence:e1].')]],
      ['evidence', [rec('e1', 'Evidence for claim B only.')]],
    ]);
    expect(runExportGates(records, 'public-share', false).passed).toBe(false);
  });

  it('matches Figure 1 by exact structured identity, never Figure 10 substring', () => {
    const figure10 = { ...rec('a1', 'Figure payload.', [
      { key: 'reviewStatus', value: 'verified' }, { key: 'deliverableProfileId', value: 'sci' },
      { key: 'deliverableProfileSchemaVersion', value: '1' }, { key: 'deliverableProfileVersion', value: '1.0.0' },
    ]), images: [{ id: 'figure-10', mediaType: 'image/png' as const, base64Data: 'AA==', sha256: '0'.repeat(64), widthPx: 1, heightPx: 1, caption: 'Figure 10' }] };
    const records = new Map<ExportScope, ResearchExportRecord[]>([
      ['project', [rec('p1', 'See Figure 1.')]], ['artifact', [figure10]],
    ]);
    expect(runExportGates(records, 'public-share', false).passed).toBe(false);
  });

  it('uses main media ordinal instead of a misleading caption for figure identity', () => {
    const misleading = { ...rec('a1', 'Figure payload.'), images: [{
      id: 'image-10', ordinal: 9, mediaType: 'image/png' as const, base64Data: 'AA==',
      sha256: '0'.repeat(64), widthPx: 1, heightPx: 1, caption: 'Figure 1',
    }] };
    const records = new Map<ExportScope, ResearchExportRecord[]>([
      ['project', [rec('p1', 'See Figure 1.')]], ['artifact', [misleading]],
    ]);
    expect(runExportGates(records, 'public-share', false).passed).toBe(false);
  });

  it('uses the same exact formatter path for UI APA/Chicago/IEEE', () => {
    const paper = {
      id: 'p', title: 'Evidence and Policy', authors: ['John P. Smith', 'Jane A. Doe'], year: 2024,
      venue: 'Journal of Research', volume: '12', issue: '3', pages: '45-67', doi: '10.1234/example',
      abstract: '', tags: [], notes: '', readStatus: 'unread' as const, rating: 0, referenceIds: [], addedAt: 1,
    };
    const structured = {
      authors: [{ family: 'Smith', given: 'John P.' }, { family: 'Doe', given: 'Jane A.' }],
      year: 2024, title: paper.title, containerTitle: paper.venue, volume: '12', issue: '3', pages: '45-67',
      doi: paper.doi, type: 'journal_article' as const,
    };
    for (const style of ['apa', 'chicago', 'ieee'] as const) {
      expect(formatCitation(paper, style)).toBe(formatAcademicCitation(structured, style));
    }
  });
});
