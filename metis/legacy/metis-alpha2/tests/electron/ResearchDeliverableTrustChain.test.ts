import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { ArtifactManifest } from '../../engine/artifacts/ArtifactManifest.js';
import type { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type {
  ArtifactVersionRecord,
  Project,
  ResearchArtifact,
  ResearchDecision,
  Source,
} from '../../engine/persistence/researchModel.js';
import {
  decodeResearchArtifactVersionRequest,
  decodeResearchCrudRequest,
  type ResearchArtifactVersionRequest,
} from '../../engine/runtime/ResearchRuntimeContract.js';
import { bindDeliverableProfile } from '../../engine/writing/DeliverableProfile.js';
import type { CitationTruthResolutionRequest } from '../../engine/writing/CitationTruthResolver.js';
import {
  CitationTruthReceiptService,
  type CitationReferenceValidator,
} from '../../electron/CitationTruthReceiptService.js';
import {
  verifyArtifactForExport,
  verifyArtifactForPersistence,
} from '../../electron/ResearchArtifactTrust.js';
import { ResearchRuntimeService } from '../../electron/ResearchRuntimeService.js';

const NOW = Date.now();
const CONTENT = [
  '# Abstract', '# Introduction', '# Methods', '# Results', '# Discussion', '# References',
].join('\n\nContent with [cite:source-1] and [cite:source-2].\n\n');
const CONTENT_DIGEST = createHash('sha256').update(CONTENT, 'utf8').digest('hex');

function source(id: string, doi: string, kind: 'peer_reviewed' | 'primary'): Source {
  return {
    id, projectId: 'project-1', kind: 'paper', title: `Title ${id}`, authors: ['Alice Smith'], year: 2024,
    venue: 'Trusted Journal', identifier: doi, identifierType: 'doi', filePath: null, externalUrl: null,
    tags: [], metadata: { deliverableSourceKind: kind }, sourceVersionHash: `hash-${id}`,
    provenance: { origin: 'test' }, createdAt: NOW - 1_000, updatedAt: NOW - 100, deletedAt: null,
  };
}

function approvals(): ResearchDecision[] {
  return ['outline', 'sources', 'draft', 'citation_audit', 'format_preview', 'release'].map((stage) => ({
    id: `decision-${stage}`, projectId: 'project-1', runId: null, targetKind: 'artifact',
    targetId: 'artifact-1', decision: 'accept', origin: 'human', beforeValue: {},
    afterValue: {
      deliverableApprovalStage: stage,
      deliverableApprovalArtifactVersion: 1,
      deliverableApprovalContentDigest: CONTENT_DIGEST,
    }, note: '', createdAt: NOW - 50, undoneAt: null,
  }));
}

async function resolver(request: CitationTruthResolutionRequest) {
  return {
    sourceId: request.sourceId, citationKeys: request.citationKeys, identifierType: request.identifierType,
    identifier: request.identifier, locator: request.locator, triangulation: 'VERIFIED' as const,
    passport: 'verified' as const, retraction: 'clear' as const, journalIntegrity: 'trusted' as const,
    checkedAt: request.now ?? NOW,
  };
}

describe('verified deliverable production service chain', () => {
  it('main recomputes profile and truth, repository verifies receipts, and deleted sources block export', async () => {
    const project: Project = {
      id: 'project-1', title: 'Project', originalIntent: '', researchQuestion: '', lifecycle: 'draft',
      methodology: '', discipline: '', metadata: {}, createdAt: NOW - 10_000, updatedAt: NOW - 1_000,
      archivedAt: null, version: 1, source: 'test', deletedAt: null,
    };
    const artifact: ResearchArtifact = {
      id: 'artifact-1', projectId: 'project-1', title: 'Draft', artifactType: 'manuscript', reviewStatus: 'draft',
      contentRef: null, inputHash: null, provenance: {}, metadata: {}, version: 1,
      createdAt: NOW - 1_000, updatedAt: NOW - 1_000, deletedAt: null,
    };
    const sources = [
      source('source-1', '10.1234/one', 'peer_reviewed'),
      source('source-2', '10.1234/two', 'primary'),
      {
        ...source('template-source', 'https://journal.example/template', 'primary'),
        kind: 'web' as const,
        identifierType: 'url' as const,
        metadata: { deliverableSourceKind: 'primary', deliverableRuleKind: 'template' },
      },
      {
        ...source('venue-rules', 'https://journal.example/rules', 'primary'),
        kind: 'web' as const,
        identifierType: 'url' as const,
        metadata: { deliverableSourceKind: 'primary', deliverableRuleKind: 'venue' },
      },
    ];
    const validator: CitationReferenceValidator = {
      validateDoi: async (value, options) => ({
        reference: value, type: 'doi', exists: true, retracted: false, validatedAt: NOW,
        metadata: { title: options.expectedTitle, authors: options.expectedAuthors, year: options.expectedYear },
        consistency: { titleMatch: true, authorMatch: true, yearMatch: true, overallMatch: true },
      }),
      validateArxiv: async () => ({ reference: '', type: 'arxiv', exists: false, retracted: false, validatedAt: NOW }),
    };
    const receiptService = new CitationTruthReceiptService(Buffer.alloc(32, 11), {
      validator, resolver, now: () => NOW, ttlMs: 60_000,
    });
    let captured: { manifest: ArtifactManifest; content: string } | undefined;
    const approvedVersion: ArtifactVersionRecord = {
      artifactId: artifact.id,
      version: 1,
      manifest: {},
      content: CONTENT,
      contentHash: CONTENT_DIGEST,
      thumbnailRef: null,
      createdAt: NOW - 100,
      createdBy: 'user',
      branchFromVersion: null,
    };
    const fake = {
      getProject: (id: string) => id === project.id && project.deletedAt === null ? project : undefined,
      getSource: (id: string) => sources.find((item) => item.id === id && item.deletedAt === null),
      listSources: () => sources.filter((item) => item.deletedAt === null),
      listDecisions: () => approvals(),
      getArtifact: (id: string) => id === artifact.id ? artifact : undefined,
      getArtifactVersion: (_artifactId: string, version?: number) => {
        if (captured && (version === undefined || version === captured.manifest.version)) {
          return {
            artifactId: captured.manifest.id,
            version: captured.manifest.version,
            manifest: captured.manifest,
            content: captured.content,
            contentHash: createHash('sha256').update(captured.content, 'utf8').digest('hex'),
            thumbnailRef: null,
            createdAt: NOW,
            createdBy: 'user' as const,
            branchFromVersion: approvedVersion.version,
          };
        }
        return version === undefined || version === approvedVersion.version ? approvedVersion : undefined;
      },
      saveArtifactVersion: (manifest: ArtifactManifest, content: string): ArtifactVersionRecord => {
        const authority = verifyArtifactForPersistence(repository, receiptService, manifest, content, NOW);
        if (!authority.receiptVerified || !authority.profileEnforced) throw new Error('untrusted');
        captured = { manifest, content };
        artifact.version = manifest.version;
        artifact.reviewStatus = manifest.reviewStatus;
        return {
          artifactId: manifest.id, version: manifest.version, manifest, content,
          contentHash: manifest.citationTruthReceipts![0]!.contentDigest, thumbnailRef: null,
          createdAt: NOW, createdBy: 'user', branchFromVersion: null,
        };
      },
    };
    const repository = fake as unknown as ResearchRepository;
    const runtime = new ResearchRuntimeService(repository, undefined, receiptService);
    const decoded = decodeResearchArtifactVersionRequest({
      operation: 'save_version', projectId: 'project-1', artifactId: 'artifact-1', expectedVersion: 1,
      title: 'Verified', artifactType: 'manuscript', reviewStatus: 'verified',
      inputs: [{ kind: 'source', id: 'source-1' }, { kind: 'source', id: 'source-2' }],
      capabilityId: 'writing', method: 'main-chain', citedSourceIds: ['source-1', 'source-2'],
      deliverableProfile: bindDeliverableProfile('sci'),
      deliverableContext: {
        templateId: 'sci-journal-author-guidelines', templateSourceId: 'template-source', contentFormat: 'markdown', citationStyle: 'apa',
        venueRuleSourceId: 'venue-rules', schoolRuleSourceId: null,
      },
      citationRequests: [{ sourceId: 'source-1', locator: 'p. 1' }, { sourceId: 'source-2', locator: 'p. 2' }],
      rendererKind: 'markdown', contentRef: null, content: CONTENT,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const changed = decodeResearchArtifactVersionRequest({
      ...decoded.value,
      content: `${CONTENT}\nUnapproved mutation.`,
    });
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      expect(await runtime.handleVersion(changed.value)).toEqual({ success: false, code: 'rejected' });
    }
    const result = await runtime.handleVersion(decoded.value as ResearchArtifactVersionRequest);
    expect(result).toMatchObject({ success: true, code: 'versioned', version: 2 });
    expect(captured?.manifest.citationTruthReceipts).toHaveLength(2);
    expect(captured?.manifest.citationTruth).toBeUndefined();
    expect(captured?.manifest.deliverableCompliance?.approvalDecisionIds).toHaveLength(6);
    const getArtifact = decodeResearchCrudRequest({
      operation: 'get', projectId: 'project-1', entityKind: 'artifact', entityId: 'artifact-1', includeDeleted: false,
    });
    expect(getArtifact.ok).toBe(true);
    if (getArtifact.ok) {
      expect(runtime.handleCrud(getArtifact.value)).toMatchObject({
        success: true,
        entity: { entityKind: 'artifact', value: { reviewStatus: 'verified' } },
      });
    }

    sources[0]!.deletedAt = NOW;
    expect(await verifyArtifactForExport(
      repository,
      receiptService,
      captured!.manifest,
      captured!.content,
      NOW,
    )).toBeNull();
    if (getArtifact.ok) {
      expect(runtime.handleCrud(getArtifact.value)).toMatchObject({
        success: true,
        entity: { entityKind: 'artifact', value: { reviewStatus: 'draft' } },
      });
    }
  });
});
