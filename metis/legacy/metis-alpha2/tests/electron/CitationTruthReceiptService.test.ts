import { describe, expect, it } from 'vitest';
import type { ArtifactManifest } from '../../engine/artifacts/ArtifactManifest.js';
import type { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { Project, Source } from '../../engine/persistence/researchModel.js';
import { ResearchArtifactVersionRequestSchema } from '../../engine/runtime/ResearchRuntimeContract.js';
import type { CitationTruthResolutionRequest } from '../../engine/writing/CitationTruthResolver.js';
import {
  CitationTruthReceiptService,
  type CitationReferenceValidator,
} from '../../electron/CitationTruthReceiptService.js';

const NOW = 1_800_000_000_000;

function project(): Project {
  return {
    id: 'project-1', title: 'Project', originalIntent: '', researchQuestion: '', lifecycle: 'draft',
    methodology: '', discipline: '', metadata: {}, createdAt: NOW - 10_000, updatedAt: NOW - 1_000,
    archivedAt: null, version: 1, source: 'test', deletedAt: null,
  };
}

function source(): Source {
  return {
    id: 'source-1', projectId: 'project-1', kind: 'paper', title: 'Exact title',
    authors: ['Alice Smith'], year: 2024, venue: 'Trusted Journal', identifier: '10.1234/exact',
    identifierType: 'doi', filePath: null, externalUrl: null, tags: [],
    metadata: { deliverableSourceKind: 'peer_reviewed', issn: '1234-5678' },
    sourceVersionHash: 'source-version-1', provenance: { origin: 'test' },
    createdAt: NOW - 10_000, updatedAt: NOW - 1_000, deletedAt: null,
  };
}

function repository(current: { project: Project; source: Source }): ResearchRepository {
  return {
    getProject: (id: string) => id === current.project.id && current.project.deletedAt === null ? current.project : undefined,
    getSource: (id: string) => id === current.source.id && current.source.deletedAt === null ? current.source : undefined,
  } as unknown as ResearchRepository;
}

function validator(observed: Array<Record<string, unknown>>, exists = true): CitationReferenceValidator {
  return {
    validateDoi: async (value, options) => {
      observed.push({ value, options });
      return {
        reference: value, type: 'doi', exists, retracted: false, validatedAt: NOW,
        metadata: { title: 'Exact title', authors: ['Alice Smith'], year: 2024 },
        consistency: { titleMatch: true, authorMatch: true, yearMatch: true, overallMatch: true },
      };
    },
    validateArxiv: async () => ({
      reference: '', type: 'arxiv', exists: false, retracted: false, validatedAt: NOW,
    }),
  };
}

async function resolver(request: CitationTruthResolutionRequest) {
  return {
    sourceId: request.sourceId,
    citationKeys: request.citationKeys,
    identifierType: request.identifierType,
    identifier: request.identifier,
    locator: request.locator,
    triangulation: 'VERIFIED' as const,
    passport: 'verified' as const,
    retraction: 'clear' as const,
    journalIntegrity: 'trusted' as const,
    checkedAt: request.now ?? NOW,
  };
}

function manifest(receipts: NonNullable<ArtifactManifest['citationTruthReceipts']>): ArtifactManifest {
  return {
    id: 'artifact-1', projectId: 'project-1', title: 'Artifact', artifactType: 'manuscript',
    reviewStatus: 'verified', inputs: [{ kind: 'source', id: 'source-1' }],
    generatedBy: { capabilityId: 'writing', method: 'main-validated' }, citedSourceIds: ['source-1'],
    citationTruthReceipts: receipts, renderer: { kind: 'markdown' }, reviewTrail: [], version: 2,
    createdAt: NOW - 1_000, updatedAt: NOW,
  };
}

describe('main-issued CitationTruthReceipt', () => {
  it('binds expected metadata, project/artifact/version/content/current source and a main HMAC', async () => {
    const current = { project: project(), source: source() };
    const observed: Array<Record<string, unknown>> = [];
    const service = new CitationTruthReceiptService(Buffer.alloc(32, 7), {
      validator: validator(observed), resolver, now: () => NOW, ttlMs: 60_000,
    });
    const receipts = await service.issueReceipts(repository(current), {
      projectId: 'project-1', artifactId: 'artifact-1', artifactVersion: 2,
      content: 'Immutable content', citedSourceIds: ['source-1'],
      citations: [{ sourceId: 'source-1', locator: 'p. 9' }],
    });
    expect(receipts).toHaveLength(1);
    expect(observed).toEqual([{
      value: '10.1234/exact',
      options: { expectedTitle: 'Exact title', expectedAuthors: ['Alice Smith'], expectedYear: 2024 },
    }]);
    const trustedManifest = manifest(receipts!);
    expect(service.verifyManifestCurrent(repository(current), trustedManifest, 'Immutable content', NOW).ok).toBe(true);
    const restarted = new CitationTruthReceiptService(Buffer.alloc(32, 7), {
      validator: validator([]), resolver, now: () => NOW, ttlMs: 60_000,
    });
    expect(restarted.verifyManifestCurrent(repository(current), trustedManifest, 'Immutable content', NOW).ok).toBe(true);

    expect(service.verifyManifestCurrent(repository(current), { ...trustedManifest, projectId: 'other' }, 'Immutable content', NOW).ok).toBe(false);
    expect(service.verifyManifestCurrent(repository(current), { ...trustedManifest, version: 3 }, 'Immutable content', NOW).ok).toBe(false);
    expect(service.verifyManifestCurrent(repository(current), trustedManifest, 'Changed content', NOW).ok).toBe(false);
    expect(service.verifyManifestCurrent(repository(current), trustedManifest, 'Immutable content', NOW + 60_000).ok).toBe(false);

    const forged = structuredClone(trustedManifest);
    forged.citationTruthReceipts![0]!.signature = '0'.repeat(64);
    expect(service.verifyManifestCurrent(repository(current), forged, 'Immutable content', NOW).ok).toBe(false);
  });

  it('invalidates a receipt when the current source is deleted or any identity/metadata changes', async () => {
    const current = { project: project(), source: source() };
    const service = new CitationTruthReceiptService(Buffer.alloc(32, 8), {
      validator: validator([]), resolver, now: () => NOW, ttlMs: 60_000,
    });
    const receipts = await service.issueReceipts(repository(current), {
      projectId: 'project-1', artifactId: 'artifact-1', artifactVersion: 2,
      content: 'Content', citedSourceIds: ['source-1'], citations: [{ sourceId: 'source-1', locator: 'p. 1' }],
    });
    const trustedManifest = manifest(receipts!);
    current.source.title = 'Mutated title';
    expect(service.verifyManifestCurrent(repository(current), trustedManifest, 'Content', NOW).ok).toBe(false);
    current.source = source();
    current.source.deletedAt = NOW;
    expect(service.verifyManifestCurrent(repository(current), trustedManifest, 'Content', NOW).ok).toBe(false);
  });

  it('re-runs the validator/resolver at export and fails closed when the live reference disappears', async () => {
    const current = { project: project(), source: source() };
    let exists = true;
    const dynamicValidator: CitationReferenceValidator = {
      validateDoi: async (value) => ({
        reference: value, type: 'doi', exists, retracted: false, validatedAt: NOW,
        metadata: { title: 'Exact title', authors: ['Alice Smith'], year: 2024 },
        consistency: { titleMatch: true, authorMatch: true, yearMatch: true, overallMatch: true },
      }),
      validateArxiv: async () => ({ reference: '', type: 'arxiv', exists: false, retracted: false, validatedAt: NOW }),
    };
    const service = new CitationTruthReceiptService(Buffer.alloc(32, 9), {
      validator: dynamicValidator, resolver, now: () => NOW, ttlMs: 60_000,
    });
    const receipts = await service.issueReceipts(repository(current), {
      projectId: 'project-1', artifactId: 'artifact-1', artifactVersion: 2,
      content: 'Content', citedSourceIds: ['source-1'], citations: [{ sourceId: 'source-1', locator: 'p. 1' }],
    });
    exists = false;
    expect((await service.verifyAndRevalidateManifest(repository(current), manifest(receipts!), 'Content', NOW)).ok).toBe(false);
  });

  it('does not issue a receipt for an existing DOI whose expected metadata mismatches', async () => {
    const current = { project: project(), source: source() };
    const mismatching: CitationReferenceValidator = {
      validateDoi: async (value) => ({
        reference: value, type: 'doi', exists: true, retracted: false, validatedAt: NOW,
        metadata: { title: 'Different title', authors: ['Other Author'], year: 1999 },
        consistency: { titleMatch: false, authorMatch: false, yearMatch: false, overallMatch: false },
      }),
      validateArxiv: async () => ({ reference: '', type: 'arxiv', exists: false, retracted: false, validatedAt: NOW }),
    };
    const service = new CitationTruthReceiptService(Buffer.alloc(32, 10), {
      validator: mismatching, resolver, now: () => NOW, ttlMs: 60_000,
    });
    expect(await service.issueReceipts(repository(current), {
      projectId: 'project-1', artifactId: 'artifact-1', artifactVersion: 2,
      content: 'Content', citedSourceIds: ['source-1'], citations: [{ sourceId: 'source-1', locator: 'p. 1' }],
    })).toBeNull();
  });

  it('renderer DTO cannot submit either legacy truth or a forged receipt', () => {
    const base = {
      operation: 'save_version', projectId: 'project-1', artifactId: 'artifact-1', expectedVersion: 1,
      title: 'Artifact', artifactType: 'manuscript', reviewStatus: 'draft', inputs: [], capabilityId: 'writing',
      method: 'renderer', citedSourceIds: [], rendererKind: 'markdown', contentRef: null, content: 'draft',
    };
    expect(ResearchArtifactVersionRequestSchema.safeParse({ ...base, citationTruth: [] }).success).toBe(false);
    expect(ResearchArtifactVersionRequestSchema.safeParse({ ...base, citationTruthReceipts: [] }).success).toBe(false);
    expect(ResearchArtifactVersionRequestSchema.safeParse({ ...base, deliverableCompliance: {} }).success).toBe(false);
  });
});
