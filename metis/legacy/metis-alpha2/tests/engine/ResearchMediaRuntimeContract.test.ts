import { describe, expect, it } from 'vitest';
import { ArtifactManifestSchema } from '../../engine/artifacts/ArtifactManifest.js';
import {
  ResearchMediaAttachRequestSchema,
  decodeResearchMediaAttachResult,
} from '../../engine/runtime/ResearchMediaRuntimeContract.js';
import { ResearchArtifactVersionRequestSchema } from '../../engine/runtime/ResearchRuntimeContract.js';

const CAPABILITY_ID = `fc_${'a'.repeat(32)}`;

function attachRequest() {
  return {
    projectId: 'project_media_contract',
    sourceId: 'source_media_contract',
    capabilityId: CAPABILITY_ID,
    caption: 'Figure 1: contract-safe media',
    ordinal: 0,
  };
}

function versionRequest() {
  return {
    operation: 'save_version',
    projectId: 'project_media_contract',
    artifactId: 'artifact_media_contract',
    expectedVersion: null,
    title: 'Contract artifact',
    artifactType: 'report',
    reviewStatus: 'draft',
    inputs: [],
    capabilityId: 'research_editor',
    method: 'save exact version',
    citedSourceIds: [],
    rendererKind: 'markdown',
    contentRef: null,
    media: [{
      sourceId: 'source_media_contract',
      caption: 'Figure 1: contract-safe media',
      ordinal: 0,
    }],
    inputHash: null,
    content: 'Artifact content',
    createdBy: 'user',
    branchFromVersion: null,
  };
}

describe('MEDIA-303 renderer media boundary', () => {
  it('accepts only capability/source/caption/order and rejects path or trusted intrinsic fields', () => {
    expect(ResearchMediaAttachRequestSchema.safeParse(attachRequest()).success).toBe(true);
    for (const untrusted of [
      { filePath: 'C:\\Users\\researcher\\secret.png' },
      { resolvedPath: '/home/researcher/secret.png' },
      { sha256: '0'.repeat(64) },
      { mediaType: 'image/png' },
      { byteLength: 68 },
      { widthPx: 1, heightPx: 1 },
      { base64Data: 'AA==' },
      { owner: { webContentsId: 1, mainFrameProcessId: 2, mainFrameRoutingId: 3 } },
      { ownerKey: '1:2:3' },
    ]) {
      expect(ResearchMediaAttachRequestSchema.safeParse({
        ...attachRequest(),
        ...untrusted,
      }).success).toBe(false);
    }
  });

  it('rejects trusted media fields in save-version renderer requests', () => {
    expect(ResearchArtifactVersionRequestSchema.safeParse(versionRequest()).success).toBe(true);
    expect(ResearchArtifactVersionRequestSchema.safeParse({
      ...versionRequest(),
      media: [{
        ...versionRequest().media[0],
        sha256: '0'.repeat(64),
        mediaType: 'image/png',
        widthPx: 1,
        heightPx: 1,
        filePath: 'C:\\secret.png',
      }],
    }).success).toBe(false);
  });

  it('fails closed rather than forwarding an attach response containing a path or base64', () => {
    const unsafe = {
      success: true,
      code: 'research_media_attached',
      media: {
        sourceId: 'source_media_contract',
        caption: 'Figure 1: contract-safe media',
        ordinal: 0,
        displayName: 'figure.png',
        mediaType: 'image/png',
        byteLength: 68,
        sha256: '0'.repeat(64),
        widthPx: 1,
        heightPx: 1,
        filePath: 'C:\\secret.png',
        base64Data: 'AA==',
      },
    };
    expect(decodeResearchMediaAttachResult(unsafe)).toEqual({
      success: false,
      code: 'research_media_unavailable',
    });
  });

  it('keeps legacy manifests media-free when the optional field is absent', () => {
    const parsed = ArtifactManifestSchema.safeParse({
      id: 'artifact_legacy',
      projectId: 'project_media_contract',
      title: 'Legacy artifact',
      artifactType: 'report',
      reviewStatus: 'draft',
      inputs: [],
      generatedBy: { capabilityId: 'legacy_builder', method: 'legacy save' },
      citedSourceIds: [],
      renderer: { kind: 'markdown' },
      reviewTrail: [],
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.hasOwn(parsed.data, 'media')).toBe(false);
  });
});
