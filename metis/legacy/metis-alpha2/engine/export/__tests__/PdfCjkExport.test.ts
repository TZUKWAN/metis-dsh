/**
 * DEEPSEEK-301 (fix round) — PDF intermediate format + SecureExportService fail-closed.
 *
 * Verifies:
 * - ResearchExportBuilder produces HTML intermediate for PDF (with CJK content)
 * - SecureExportService fails honestly when Electron is not available
 * - SecureExportService succeeds when a PDF render dependency is injected (mock)
 * - No fake .pdf file is written on failure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildResearchExport } from '../../export/ResearchExportBuilder.js';
import { SecureExportService, type PdfRenderDependency } from '../../../electron/SecureExportService.js';

function makeRequest(format: string) {
  return {
    exportId: 'ex_' + 'a'.repeat(32),
    projectId: 'proj_cjk_001',
    artifactId: 'artifact_cjk_001',
    destinationCapabilityId: 'fc_' + 'b'.repeat(32),
    displayName: '中文学术导出',
    scopes: ['project', 'evidence'],
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
    artifactVersion: 7,
    artifactManifestDigest: 'd'.repeat(64),
  };
}

function makeCjkSnapshot() {
  const snapshot = {
    artifactBinding: {
      artifactId: 'artifact_cjk_001',
      artifactVersion: 7,
      artifactManifestDigest: 'd'.repeat(64),
    },
    project: [{
      id: 'rec1',
      title: '深度学习研究',
      content: '本文研究了自然语言处理中的深度学习方法。\n中文测试内容：准确率95% [evidence:ev-cjk]，召回率88% [evidence:ev-cjk]。',
      sensitivity: 'none',
      fields: [{ key: '作者', value: '张三', sensitivity: 'none' }],
    }],
    artifact: [{
      id: 'artifact_cjk_001',
      title: 'Verified CJK artifact',
      content: 'Verified artifact content.',
      sensitivity: 'none',
      fields: [
        { key: 'reviewStatus', value: 'verified', sensitivity: 'none' },
        { key: 'deliverableProfileId', value: 'sci', sensitivity: 'none' },
        { key: 'deliverableProfileSchemaVersion', value: '1', sensitivity: 'none' },
        { key: 'deliverableProfileVersion', value: '1.0.0', sensitivity: 'none' },
      ],
    }],
    citations: [],
    evidence: [],
    audit: [],
  };
  return {
    ...snapshot,
    project: [snapshot.project[0]!],
    evidence: [{
      id: 'ev-cjk',
      title: 'Verified CJK metrics',
      content: 'Accuracy and recall measurements.',
      sensitivity: 'none' as const,
      fields: [],
    }],
  };
}

describe('PDF CJK intermediate format', () => {
  it('ResearchExportBuilder produces HTML intermediate for PDF with CJK content', () => {
    const result = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.format).toBe('pdf');
    const file = result.plan.files[0]!;
    expect(file.intermediateFormat).toBe('html');
    expect(file.mediaType).toBe('application/pdf');
    expect(file.relativeName).toMatch(/\.pdf$/);
    // Content is HTML (intermediate)
    expect(file.content).toContain('<!DOCTYPE html>');
    // CJK content preserved in the HTML
    expect(file.content).toContain('深度学习研究');
    expect(file.content).toContain('中文测试内容');
  });

  it('PDF plan uses electron-printToPDF provenance', () => {
    const result = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.provenance.rendererVersion).toBe('electron-printToPDF-v1');
  });

  it('preview reports an HTML intermediate and never export_complete or final PDF metadata', () => {
    const buildResult = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;
    const preview = new SecureExportService().preview(buildResult.plan);
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(preview.code).toBe('export_preview_ready');
    if (preview.code !== 'export_preview_ready') return;
    expect(preview.previewKind).toBe('html-intermediate');
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      role: 'html-intermediate',
      mediaType: 'text/html',
    });
    expect(preview.entries[0]!.displayName).toMatch(/\.preview\.html$/u);
    expect('manifestSha256' in preview).toBe(false);
    expect('files' in preview).toBe(false);
  });

  it('preview rejects a plan whose artifact binding is inconsistent with provenance', () => {
    const buildResult = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;
    const tampered = {
      ...buildResult.plan,
      artifactManifestDigest: 'e'.repeat(64),
    };
    const preview = new SecureExportService().preview(tampered);
    expect(preview.success).toBe(false);
    if (!preview.success) {
      expect(preview.issues[0]?.code).toBe('export_invalid_request');
    }
  });
});

describe('SecureExportService PDF fail-closed (no Electron)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-pdf-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('write() fails honestly when Electron is unavailable and no deps injected', async () => {
    const buildResult = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;

    const service = new SecureExportService(); // no deps → Electron unavailable in test
    const result = await service.write(buildResult.plan, { resolvedDirectory: tmpDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.publicResult.success).toBe(false);
    // Verify no .pdf file was written
    const entries = await fs.readdir(tmpDir);
    const pdfFiles = entries.filter((e) => e.endsWith('.pdf'));
    expect(pdfFiles.length).toBe(0);
    // Also verify no staging directory was left behind
    const staging = entries.filter((e) => e.includes('.metis-export'));
    expect(staging.length).toBe(0);
  });

  it('write() succeeds when PdfRenderDependency is injected (mock)', async () => {
    const buildResult = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;

    // Mock PDF renderer that returns a valid PDF byte sequence
    const mockPdfDeps: PdfRenderDependency = {
      async renderHtmlToPdf(html: string): Promise<Buffer> {
        // Verify CJK content is in the HTML
        expect(html).toContain('深度学习研究');
        // Return a minimal valid PDF
        return Buffer.from(
          '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF',
          'latin1',
        );
      },
    };

    const service = new SecureExportService(mockPdfDeps);
    const result = await service.write(buildResult.plan, { resolvedDirectory: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicResult.success).toBe(true);
    expect(result.publicResult.format).toBe('pdf');
    expect(result.publicResult.artifactId).toBe('artifact_cjk_001');
    expect(result.publicResult.artifactVersion).toBe(7);
    expect(result.publicResult.artifactManifestDigest).toBe('d'.repeat(64));
    expect(result.publicResult.files).toHaveLength(1);
    const pdfFile = result.publicResult.files[0]!;
    expect(pdfFile.byteLength).toBeGreaterThan(0);
    expect(pdfFile.sha256).toMatch(/^[a-f0-9]{64}$/);

    // Verify actual PDF file was written
    const entries = await fs.readdir(tmpDir);
    const exportDirs = entries.filter((e) => e.startsWith('metis-export-'));
    expect(exportDirs.length).toBe(1);
    const exportDir = path.join(tmpDir, exportDirs[0]!);
    const filesInExport = await fs.readdir(exportDir);
    const pdfFiles = filesInExport.filter((f) => f.endsWith('.pdf'));
    expect(pdfFiles.length).toBe(1);
    const pdfBytes = await fs.readFile(path.join(exportDir, pdfFiles[0]!));
    const header = pdfBytes.subarray(0, 8).toString('ascii');
    expect(header).toMatch(/^%PDF-1\./);
    expect(pdfBytes.subarray(Math.max(0, pdfBytes.length - 32)).toString('ascii')).toContain('%%EOF');
    const manifest = JSON.parse(await fs.readFile(path.join(exportDir, 'manifest.json'), 'utf8')) as {
      artifactId: string;
      artifactVersion: number;
      artifactManifestDigest: string;
      provenance: { artifactVersion: number; sourceManifestDigest: string };
    };
    expect(manifest.artifactId).toBe('artifact_cjk_001');
    expect(manifest.artifactVersion).toBe(7);
    expect(manifest.artifactManifestDigest).toBe('d'.repeat(64));
    expect(manifest.provenance.artifactVersion).toBe(7);
    expect(manifest.provenance.sourceManifestDigest).toBe('d'.repeat(64));
  });

  it.each([
    ['HTML bytes', Buffer.from(`<!DOCTYPE html><html><body>${'x'.repeat(200)}</body></html>`, 'utf8')],
    ['missing EOF', Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${'x'.repeat(100)}\nstartxref\n0\n`, 'ascii')],
    ['short garbage', Buffer.from('%PDF-x %%EOF', 'ascii')],
    ['random garbage', Buffer.alloc(256, 0x41)],
  ])('write() rejects renderer output containing %s and removes staging', async (_label, invalidBytes) => {
    const buildResult = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;
    const service = new SecureExportService({
      async renderHtmlToPdf() { return invalidBytes; },
    });
    const result = await service.write(buildResult.plan, { resolvedDirectory: tmpDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.publicResult.issues[0]?.code).toBe('export_render_failed');
    }
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('write() fail-closed when injected renderer throws', async () => {
    const buildResult = buildResearchExport(makeRequest('pdf'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;

    const failingDeps: PdfRenderDependency = {
      async renderHtmlToPdf(): Promise<Buffer> {
        throw new Error('Chromium printToPDF crashed');
      },
    };

    const service = new SecureExportService(failingDeps);
    const result = await service.write(buildResult.plan, { resolvedDirectory: tmpDir });

    expect(result.ok).toBe(false);
    // Verify no file was written
    const entries = await fs.readdir(tmpDir);
    const staging = entries.filter((e) => e.includes('.metis-export'));
    expect(staging.length).toBe(0);
  });
});

describe('SecureExportService DOCX (binary, base64)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-docx-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('write() produces real DOCX file with PK signature', async () => {
    const buildResult = buildResearchExport(makeRequest('docx'), makeCjkSnapshot());
    expect(buildResult.ok).toBe(true);
    if (!buildResult.ok) return;

    const service = new SecureExportService();
    const result = await service.write(buildResult.plan, { resolvedDirectory: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicResult.success).toBe(true);
    expect(result.publicResult.format).toBe('docx');

    // Verify file was written
    const entries = await fs.readdir(tmpDir);
    const exportDirs = entries.filter((e) => e.startsWith('metis-export-'));
    expect(exportDirs.length).toBe(1);
    const exportDir = path.join(tmpDir, exportDirs[0]!);
    const filesInExport = await fs.readdir(exportDir);
    const docxFiles = filesInExport.filter((f) => f.endsWith('.docx'));
    expect(docxFiles.length).toBe(1);
    const docxBytes = await fs.readFile(path.join(exportDir, docxFiles[0]!));
    expect(docxBytes[0]).toBe(0x50); // P
    expect(docxBytes[1]).toBe(0x4b); // K
  });
});
