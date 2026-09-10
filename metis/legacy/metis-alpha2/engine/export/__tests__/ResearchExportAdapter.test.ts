import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../../persistence/researchModel.js';
import {
  buildExportSnapshot,
  canonicalArtifactManifestDigest,
  resolveTrustedArtifactExportBinding,
} from '../../../electron/ResearchExportAdapter.js';
import { bindDeliverableProfile } from '../../writing/DeliverableProfile.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshot(): ProjectSnapshot {
  const manifest = {
    id: 'artifact-1',
    projectId: 'project-1',
    title: 'Bound manuscript',
    artifactType: 'manuscript',
    reviewStatus: 'draft',
    inputs: [],
    generatedBy: { capabilityId: 'writing', method: 'manual' },
    citedSourceIds: [],
    renderer: { kind: 'markdown' },
    reviewTrail: [],
    version: 2,
    createdAt: 1,
    updatedAt: 2,
  };
  const content = 'Immutable artifact version two';
  return {
    project: {
      id: 'project-1',
      title: 'Project',
      originalIntent: 'Intent',
      researchQuestion: 'Question',
      lifecycle: 'draft',
      methodology: 'Method',
      discipline: 'History',
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      version: 1,
      source: 'user',
      deletedAt: null,
    },
    sources: [],
    evidence: [],
    noteCodes: [],
    claims: [],
    claimEvidenceLinks: [],
    artifacts: [{
      id: 'artifact-1',
      projectId: 'project-1',
      title: 'Bound manuscript',
      artifactType: 'manuscript',
      reviewStatus: 'draft',
      contentRef: null,
      inputHash: null,
      provenance: {},
      metadata: {},
      version: 3,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    }, {
      id: 'artifact-other',
      projectId: 'project-1',
      title: 'Other artifact',
      artifactType: 'report',
      reviewStatus: 'draft',
      contentRef: null,
      inputHash: null,
      provenance: {},
      metadata: {},
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    }],
    artifactVersions: [{
      artifactId: 'artifact-1',
      version: 2,
      manifest,
      content,
      contentHash: sha256(content),
      thumbnailRef: null,
      createdAt: 2,
      createdBy: 'user',
      branchFromVersion: null,
    }],
    runs: [],
    checkpoints: [],
    decisions: [],
    capturedAt: 3,
  };
}

describe('ResearchExportAdapter trusted artifact binding', () => {
  it('canonicalizes manifest object key order before hashing', () => {
    expect(canonicalArtifactManifestDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalArtifactManifestDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('resolves an immutable repository artifact/version and verifies its content hash', () => {
    const project = snapshot();
    const binding = resolveTrustedArtifactExportBinding(project, 'artifact-1', 2);
    expect(binding).not.toBeNull();
    expect(binding).toMatchObject({
      artifactId: 'artifact-1',
      artifactVersion: 2,
    });
    expect(binding?.artifactManifestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects missing versions, cross-project manifests, and corrupted content hashes', () => {
    const project = snapshot();
    expect(resolveTrustedArtifactExportBinding(project, 'artifact-1', 99)).toBeNull();
    project.artifactVersions[0]!.manifest = {
      ...project.artifactVersions[0]!.manifest,
      projectId: 'other-project',
    };
    expect(resolveTrustedArtifactExportBinding(project, 'artifact-1', 2)).toBeNull();
    const corrupted = snapshot();
    corrupted.artifactVersions[0]!.contentHash = '0'.repeat(64);
    expect(resolveTrustedArtifactExportBinding(corrupted, 'artifact-1', 2)).toBeNull();
  });

  it('builds an export snapshot containing only the exact selected artifact version', () => {
    const project = snapshot();
    const binding = resolveTrustedArtifactExportBinding(project, 'artifact-1', 2);
    expect(binding).not.toBeNull();
    if (!binding) return;
    const exported = buildExportSnapshot(project, binding);
    expect(exported.artifactBinding).toEqual(binding);
    expect(exported.artifact).toHaveLength(1);
    expect(exported.artifact?.[0]?.id).toBe('artifact-1');
    expect(exported.artifact?.[0]?.content).toBe('Immutable artifact version two');
    expect(exported.artifact?.[0]?.fields).toContainEqual({
      key: 'version',
      value: '2',
      sensitivity: 'none',
    });
  });

  it('projects manifest-bound citation truth into the main-side export snapshot', () => {
    const project = snapshot();
    const attestation = {
      sourceId: 'source-1', citationKeys: ['source-1'], identifierType: 'doi' as const, identifier: '10.1234/example',
      locator: 'p. 4', triangulation: 'VERIFIED' as const, passport: 'verified' as const, retraction: 'clear' as const,
      journalIntegrity: 'trusted' as const, checkedAt: Date.now(),
    };
    project.sources.push({
      id: 'source-1', projectId: 'project-1', kind: 'paper', title: 'Trusted source', authors: ['Alice Smith'],
      year: 2024, venue: 'Journal', identifier: '10.1234/example', identifierType: 'doi', filePath: null,
      externalUrl: 'https://doi.org/10.1234/example', tags: [], metadata: {}, sourceVersionHash: null,
      provenance: {}, createdAt: 1, updatedAt: 2, deletedAt: null,
    });
    const version = project.artifactVersions[0]!;
    version.content = 'Claim [cite:source-1].';
    version.contentHash = sha256(version.content);
    version.manifest = {
      ...version.manifest,
      citedSourceIds: ['source-1'],
      deliverableProfile: bindDeliverableProfile('sci'),
    };
    const binding = resolveTrustedArtifactExportBinding(project, 'artifact-1', 2);
    expect(binding).not.toBeNull();
    const exported = buildExportSnapshot(project, binding!, [], {
      receiptVerified: true,
      profileEnforced: true,
      attestations: [attestation],
    });
    expect(exported.citations?.[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'triangulation', value: 'VERIFIED' }),
      expect.objectContaining({ key: 'passport', value: 'verified' }),
      expect.objectContaining({ key: 'retraction', value: 'clear' }),
      expect.objectContaining({ key: 'journalIntegrity', value: 'trusted' }),
      expect.objectContaining({ key: 'locator', value: 'p. 4' }),
    ]));
  });

  it('never promotes manifest-authored truth without an explicit main trust evaluation', () => {
    const project = snapshot();
    const version = project.artifactVersions[0]!;
    version.manifest = {
      ...version.manifest,
      reviewStatus: 'verified',
      deliverableProfile: bindDeliverableProfile('sci'),
      citationTruth: [{
        sourceId: 'forged', citationKeys: ['forged'], identifierType: 'doi', identifier: '10.9999/forged',
        locator: 'p. 1', triangulation: 'VERIFIED', passport: 'verified', retraction: 'clear',
        journalIntegrity: 'trusted', checkedAt: Date.now(),
      }],
    };
    const binding = resolveTrustedArtifactExportBinding(project, 'artifact-1', 2)!;
    const exported = buildExportSnapshot(project, binding);
    expect(exported.artifact?.[0]?.fields).toContainEqual({
      key: 'reviewStatus', value: 'draft', sensitivity: 'none',
    });
    expect((exported.citations ?? []).some((record) => (
      (record.fields ?? []).some((field) => field.key === 'passport')
    ))).toBe(false);
  });
});
