import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeFundingTemplate,
  canonicalizeFundingTemplateValue,
} from '../../engine/personalization/FundingTemplateAnalyzer.js';
import {
  FundingTemplateAgentStructureSchema,
  FundingTemplateDiffViewSchema,
  FundingTemplateSummarySchema,
  FundingTemplateVersionViewSchema,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import type { FundingTemplatePackage } from '../../engine/runtime/FundingTemplateContract.js';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';
import {
  mapFundingTemplateRepositoryFailure,
  projectFundingTemplateAgentStructure,
  projectFundingTemplateDiff,
  projectFundingTemplateSummary,
  projectFundingTemplateVersion,
} from '../../electron/FundingTemplateRuntimeProjection.js';

let root = '';
let clock = 1_900_040_000_000;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'metis-funding-projection-'));
  clock = 1_900_040_000_000;
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makePackage(version: number): FundingTemplatePackage {
  const analyzed = analyzeFundingTemplate({
    templateId: 'user:projection-template',
    templateVersion: version,
    createdAt: 1_900_039_000_000 + version,
    document: {
      contractVersion: 1,
      documentId: 'projection-observation',
      sourceFormat: 'pdf',
      sourceDigest: digest(`projection-source-${version}`),
      extractedAt: 1_900_039_000_000 + version,
      extractor: { name: 'projection-test', version: '1.0.0' },
      pageCount: 1,
      pages: [{
        pageNumber: 1, widthPt: 595, heightPt: 842,
        observedMarginsPt: { top: 72, right: 72, bottom: 72, left: 72 },
      }],
      styles: [{
        styleId: 'body', fontFamily: 'Source Han Serif SC', fontSizePt: 11,
        fontWeight: 'normal', italic: false, alignment: 'left', lineSpacingPt: 18,
        paragraphBeforePt: 0, paragraphAfterPt: 6,
      }],
      blocks: [
        {
          kind: 'paragraph', blockId: 'heading', pageNumber: 1, ordinal: 0,
          bounds: { x: 72, y: 60, width: 450, height: 24 },
          text: `Research basis private heading ${version}`, contentRole: 'template_label', styleId: 'body',
        },
        {
          kind: 'paragraph', blockId: 'field', pageNumber: 1, ordinal: 1,
          bounds: { x: 72, y: 100, width: 300, height: 18 },
          text: `Private applicant field ${version}`, contentRole: 'template_label', styleId: 'body',
        },
        {
          kind: 'paragraph', blockId: 'instruction', pageNumber: 1, ordinal: 2,
          bounds: { x: 72, y: 130, width: 300, height: 18 },
          text: `Required maximum ${5000 + version} words`, contentRole: 'instruction', styleId: 'body',
        },
      ],
    },
  });
  if (!analyzed.ok) throw new Error(analyzed.code);
  return analyzed.template;
}

function recordWithTwoVersions() {
  const repository = new FundingTemplateRepository(root, { now: () => clock++ });
  const first = repository.saveVersion({
    ownerId: 'owner-projection', projectId: 'project-projection', template: makePackage(1),
    expectedTemplateRevision: 0, expectedActiveVersion: null, expectedActiveDigest: null,
  });
  if (!first.ok) throw new Error(first.code);
  const second = repository.saveVersion({
    ownerId: first.value.ownerId, projectId: first.value.projectId, template: makePackage(2),
    expectedTemplateRevision: first.value.revision,
    expectedActiveVersion: first.value.activeVersion,
    expectedActiveDigest: first.value.versions[0]!.packageDigest,
  });
  if (!second.ok) throw new Error(second.code);
  return second.value;
}

describe('FundingTemplateRuntimeProjection', () => {
  it('projects strict summary and version DTOs with counts but no labels, instructions, paths, or bytes', () => {
    const record = recordWithTwoVersions();
    const summary = projectFundingTemplateSummary(record);
    const version = projectFundingTemplateVersion(record.versions[1]!);
    expect(FundingTemplateSummarySchema.safeParse(summary).success).toBe(true);
    expect(FundingTemplateVersionViewSchema.safeParse(version).success).toBe(true);
    expect(summary).toMatchObject({ templateRevision: 2, activeVersion: 2, latestVersion: 2 });
    expect(version).toMatchObject({
      templateVersion: 2,
      structure: {
        sectionCount: record.versions[1]!.template.sections.length,
        contentSlotCount: record.versions[1]!.template.contentSlots.length,
      },
    });
    const raw = JSON.stringify({ summary, version });
    expect(raw).not.toMatch(/Research basis|Private applicant|Required maximum|[A-Za-z]:\\|Uint8Array/iu);
  });

  it('projects verified normalized structure only for the Agent DTO', () => {
    const record = recordWithTwoVersions();
    const structure = projectFundingTemplateAgentStructure(record.versions[1]!);
    expect(FundingTemplateAgentStructureSchema.safeParse(structure).success).toBe(true);
    expect(structure).toMatchObject({
      family: { code: 'custom', evidenceState: 'not_observed' },
      sections: [],
      fields: expect.arrayContaining([
        expect.objectContaining({ label: 'Research basis private heading 2', canonicalField: 'research_basis' }),
        expect.objectContaining({ label: 'Private applicant field 2', canonicalField: 'applicant' }),
      ]),
      instructions: expect.arrayContaining([
        expect.objectContaining({ text: 'Required maximum 5002 words' }),
      ]),
    });
    expect(JSON.stringify(structure)).not.toMatch(/[A-Za-z]:\\|Uint8Array/iu);
  });

  it('recomputes and projects a strict adjacent diff with only hashed entity keys', () => {
    const record = recordWithTwoVersions();
    const diff = projectFundingTemplateDiff(record, 1, 2);
    expect(FundingTemplateDiffViewSchema.safeParse(diff).success).toBe(true);
    expect(diff?.changes.length).toBeGreaterThan(0);
    expect(diff?.changes.every((change) => /^[a-f0-9]{64}$/u.test(change.entityKeyDigest))).toBe(true);
    expect(JSON.stringify(diff)).not.toMatch(/source:upload|layout:page|Research basis|Private applicant/iu);
  });

  it('returns null for package digest tampering instead of projecting unverified metadata', () => {
    const record = structuredClone(recordWithTwoVersions());
    record.versions[1]!.template.contentSlots[0]!.normalizedLabel = 'tampered applicant prose';
    expect(projectFundingTemplateVersion(record.versions[1]!)).toBeNull();
    expect(projectFundingTemplateDiff(record, 1, 2)).toBeNull();
  });

  it('returns null for a digest-valid but false stored diff', () => {
    const record = structuredClone(recordWithTwoVersions());
    const stored = record.versions[1]!.diffFromPrevious!;
    stored.changes = [];
    stored.breaking = false;
    const { diffDigest: _diffDigest, ...withoutDigest } = stored;
    void _diffDigest;
    stored.diffDigest = digest(canonicalizeFundingTemplateValue(withoutDigest));
    expect(projectFundingTemplateDiff(record, 1, 2)).toBeNull();
  });

  it('maps every repository outcome into a fixed existing runtime code', () => {
    expect(mapFundingTemplateRepositoryFailure('invalid_request')).toBe('invalid_request');
    expect(mapFundingTemplateRepositoryFailure('not_found')).toBe('not_found');
    expect(mapFundingTemplateRepositoryFailure('archived')).toBe('archived');
    expect(mapFundingTemplateRepositoryFailure('cas_conflict')).toBe('cas_conflict');
    expect(mapFundingTemplateRepositoryFailure('version_conflict')).toBe('cas_conflict');
    expect(mapFundingTemplateRepositoryFailure('source_unchanged')).toBe('source_unchanged');
    expect(mapFundingTemplateRepositoryFailure('sensitive_content')).toBe('sensitive_content');
    expect(mapFundingTemplateRepositoryFailure('repository_busy')).toBe('repository_busy');
    expect(mapFundingTemplateRepositoryFailure('repository_corrupt')).toBe('repository_corrupt');
    expect(mapFundingTemplateRepositoryFailure('invalid_package')).toBe('repository_corrupt');
    expect(mapFundingTemplateRepositoryFailure('io_error')).toBe('persist_failed');
  });
});
