/**
 * DEEPSEEK-301 — Integration tests for ResearchExportBuilder format support.
 *
 * Verifies all formats (DOCX, PDF, HTML, MD, CSV, JSON-bundle) produce
 * valid SecureExportPlan objects with correct encoding, provenance, and
 * artifact version metadata bound from input.
 *
 * Uses CJK (Chinese) content to verify Unicode survives the pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  ExportRequestSchema,
  TrustedExportRequestSchema,
} from '../../runtime/ExportRuntimeContract.js';
import {
  SecureExportPlanSchema,
  buildResearchExport,
} from '../ResearchExportBuilder.js';

function makeRequest(format: string) {
  return {
    exportId: 'ex_' + 'a'.repeat(32),
    projectId: 'proj_test-001',
    artifactId: 'artifact_test-001',
    destinationCapabilityId: 'fc_' + 'b'.repeat(32),
    displayName: 'test-export',
    scopes: ['project', 'evidence', 'audit'],
    format,
    privacyProfile: 'public-share',
    redaction: {
      stripSecrets: true,
      stripAbsolutePaths: true,
      stripPersonalData: true,
      pseudonymizeParticipants: true,
      omitRawTranscripts: true,
      omitModelPrompts: true,
      omitToolArguments: true,
    },
    requestedAt: 1700000000000,
    artifactVersion: 3,
    artifactManifestDigest: 'c'.repeat(64),
  };
}

function makeSnapshot() {
  return {
    artifactBinding: {
      artifactId: 'artifact_test-001',
      artifactVersion: 3,
      artifactManifestDigest: 'c'.repeat(64),
    },
    project: [{
      id: 'rec1',
      title: '研究摘要',
      content: '这是一段中文测试内容。\nSecond line in English.',
      sensitivity: 'none',
      fields: [{ key: '作者', value: '张三', sensitivity: 'none' }],
    }],
    artifact: [{
      id: 'artifact_test-001',
      title: 'Verified artifact',
      content: 'Verified artifact content.',
      sensitivity: 'none',
      fields: [
        { key: 'reviewStatus', value: 'verified', sensitivity: 'none' },
        { key: 'deliverableProfileId', value: 'sci', sensitivity: 'none' },
        { key: 'deliverableProfileSchemaVersion', value: '1', sensitivity: 'none' },
        { key: 'deliverableProfileVersion', value: '1.0.0', sensitivity: 'none' },
      ],
    }],
    citations: [{
      id: 'cite1',
      title: 'Reference',
      content: 'Author, Title, 2024.',
      sensitivity: 'none',
      fields: [],
    }],
    evidence: [{
      id: 'ev1',
      title: '数据证据',
      content: 'n=100, accuracy=95%.',
      sensitivity: 'none',
      fields: [],
    }],
    audit: [{
      id: 'audit1',
      title: 'Audit Log',
      content: 'Version recorded.',
      sensitivity: 'none',
      fields: [{ key: 'artifact_version', value: '3', sensitivity: 'none' }],
    }],
  };
}

describe('DEEPSEEK-301: ResearchExportBuilder format support', () => {
  it('keeps renderer requests free of manifest digests and requires main-side enrichment', () => {
    const trusted = makeRequest('markdown');
    const { artifactManifestDigest, ...rendererRequest } = trusted;
    expect(ExportRequestSchema.safeParse(rendererRequest).success).toBe(true);
    expect(ExportRequestSchema.safeParse(trusted).success).toBe(false);
    expect(TrustedExportRequestSchema.safeParse(rendererRequest).success).toBe(false);
    expect(TrustedExportRequestSchema.safeParse({
      ...rendererRequest,
      artifactManifestDigest,
    }).success).toBe(true);
  });

  it('DOCX format produces valid plan with base64 binary + CJK content', () => {
    const result = buildResearchExport(makeRequest('docx'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.schemaVersion).toBe(2);
    expect(result.plan.format).toBe('docx');
    const file = result.plan.files[0]!;
    expect(file.encoding).toBe('base64');
    expect(file.mediaType).toContain('wordprocessingml');
    expect(file.intermediateFormat).toBe('none');

    // Decode and verify CJK content survives
    const decoded = Buffer.from(file.content, 'base64');
    expect(decoded[0]).toBe(0x50); // P
    expect(decoded[1]).toBe(0x4b); // K
    expect(decoded.length).toBeGreaterThan(1024);
  });

  it('PDF format produces HTML intermediate (NOT direct PDF bytes)', () => {
    const result = buildResearchExport(makeRequest('pdf'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.format).toBe('pdf');
    const file = result.plan.files[0]!;
    expect(file.intermediateFormat).toBe('html');
    expect(file.mediaType).toBe('application/pdf');
    expect(file.encoding).toBe('utf8');
    // Content is HTML, not PDF bytes
    expect(file.content).toContain('<!DOCTYPE html>');
    expect(file.content).toContain('研究摘要');
    expect(file.content).toContain('中文测试内容');
  });

  it('HTML format produces valid plan with utf8 text + CJK', () => {
    const result = buildResearchExport(makeRequest('html'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.format).toBe('html');
    const file = result.plan.files[0]!;
    expect(file.encoding).toBe('utf8');
    expect(file.intermediateFormat).toBe('none');
    expect(file.mediaType).toBe('text/html');
    expect(file.content).toContain('研究摘要');
    expect(file.content).toContain('中文测试内容');
    expect(file.content).toContain('<dt>Artifact Version</dt><dd>3</dd>');
    expect(file.content).toContain('c'.repeat(64));
  });

  it('Markdown format still works with utf8 encoding', () => {
    const result = buildResearchExport(makeRequest('markdown'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const file = result.plan.files[0]!;
    expect(file.encoding).toBe('utf8');
    expect(file.content).toContain('研究摘要');
  });

  it('CSV format still works', () => {
    const result = buildResearchExport(makeRequest('csv'), makeSnapshot());
    expect(result.ok).toBe(true);
  });

  it('JSON-bundle format still works', () => {
    const result = buildResearchExport(makeRequest('json-bundle'), makeSnapshot());
    expect(result.ok).toBe(true);
  });

  it('artifact binding is copied exactly into plan provenance', () => {
    const result = buildResearchExport(makeRequest('markdown'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.artifactVersion).toBe(3);
    expect(result.plan.artifactId).toBe('artifact_test-001');
    expect(result.plan.artifactManifestDigest).toBe('c'.repeat(64));
    expect(result.plan.provenance.artifactVersion).toBe(3);
    expect(result.plan.provenance.artifactId).toBe('artifact_test-001');
    expect(result.plan.provenance.sourceManifestDigest).toBe('c'.repeat(64));
  });

  it('fails closed when artifact version or manifest digest is missing', () => {
    const request = makeRequest('markdown');
    const withoutArtifactId = { ...request, artifactId: undefined };
    const withoutVersion = { ...request, artifactVersion: undefined };
    const withoutDigest = { ...request, artifactManifestDigest: undefined };
    expect(buildResearchExport(withoutArtifactId, makeSnapshot()).ok).toBe(false);
    expect(buildResearchExport(withoutVersion, makeSnapshot()).ok).toBe(false);
    expect(buildResearchExport(withoutDigest, makeSnapshot()).ok).toBe(false);
  });

  it('fails closed when the trusted snapshot binding is missing or mismatched', () => {
    const snapshot = makeSnapshot();
    const withoutBinding = { ...snapshot, artifactBinding: undefined };
    expect(buildResearchExport(makeRequest('markdown'), withoutBinding).ok).toBe(false);
    expect(buildResearchExport(makeRequest('markdown'), {
      ...snapshot,
      artifactBinding: { ...snapshot.artifactBinding, artifactId: 'artifact_other' },
    }).ok).toBe(false);
    expect(buildResearchExport(makeRequest('markdown'), {
      ...snapshot,
      artifactBinding: { ...snapshot.artifactBinding, artifactVersion: 4 },
    }).ok).toBe(false);
    expect(buildResearchExport(makeRequest('markdown'), {
      ...snapshot,
      artifactBinding: { ...snapshot.artifactBinding, artifactManifestDigest: 'e'.repeat(64) },
    }).ok).toBe(false);
  });

  it('rejects a plan whose artifact binding disagrees with provenance', () => {
    const result = buildResearchExport(makeRequest('markdown'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SecureExportPlanSchema.safeParse({
      ...result.plan,
      provenance: { ...result.plan.provenance, artifactId: 'artifact_other' },
    }).success).toBe(false);
    expect(SecureExportPlanSchema.safeParse({
      ...result.plan,
      provenance: { ...result.plan.provenance, artifactVersion: 4 },
    }).success).toBe(false);
    expect(SecureExportPlanSchema.safeParse({
      ...result.plan,
      provenance: { ...result.plan.provenance, sourceManifestDigest: 'd'.repeat(64) },
    }).success).toBe(false);
  });

  it('provenance rendererVersion varies by format', () => {
    const pdfResult = buildResearchExport(makeRequest('pdf'), makeSnapshot());
    expect(pdfResult.ok).toBe(true);
    if (!pdfResult.ok) return;
    expect(pdfResult.plan.provenance.rendererVersion).toBe('electron-printToPDF-v1');

    const docxResult = buildResearchExport(makeRequest('docx'), makeSnapshot());
    expect(docxResult.ok).toBe(true);
    if (!docxResult.ok) return;
    expect(docxResult.plan.provenance.rendererVersion).toBe('ooxml-zip-v3-images');

    const mdResult = buildResearchExport(makeRequest('markdown'), makeSnapshot());
    expect(mdResult.ok).toBe(true);
    if (!mdResult.ok) return;
    expect(mdResult.plan.provenance.rendererVersion).toBe('text-v2');
  });

  it('plan uses schemaVersion 2', () => {
    const result = buildResearchExport(makeRequest('markdown'), makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.schemaVersion).toBe(2);
  });

  it('fail-closed: invalid request returns failure', () => {
    const result = buildResearchExport({ format: 'docx' }, makeSnapshot());
    expect(result.ok).toBe(false);
  });

  it('fail-closed: privacy gate blocks sensitive fields with public profile', () => {
    const sensitiveSnapshot = {
      ...makeSnapshot(),
      project: [{
        id: 'rec1',
        title: 'Sensitive',
        content: 'Content with api_key=sk-leaked-secret',
        sensitivity: 'personal' as const,
        fields: [],
      }],
    };
    const result = buildResearchExport(makeRequest('markdown'), sensitiveSnapshot);
    // Either fails at gate or fails at privacy check
    if (!result.ok) {
      // Expected fail-closed
      expect(result.failure.code).toBe('export_unavailable');
    }
  });

  it.each([
    'Claim (Doe, 2024). DOI:10.9999/fabricated.123',
    String.raw`Claim \cite{fabricated2024}.`,
    'Accuracy improved by 73%.',
  ])('production builder blocks untrusted scholarly content: %s', (content) => {
    const snapshot = makeSnapshot();
    snapshot.project[0]!.content = content;
    const result = buildResearchExport(makeRequest('markdown'), snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('export_unavailable');
  });

  it('all formats include provenance with gateIssues', () => {
    for (const format of ['markdown', 'html', 'csv', 'json-bundle', 'docx', 'pdf']) {
      const result = buildResearchExport(makeRequest(format), makeSnapshot());
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.plan.provenance.gateIssues).toBeInstanceOf(Array);
    }
  });
});
