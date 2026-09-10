import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SecureExportPlanSchema,
  type SecureExportPlan,
} from '../engine/export/ResearchExportBuilder.js';
import {
  createExportFailure,
  type ExportFailure,
  type ExportIssue,
  type ExportPreview,
  type ExportSuccess,
} from '../engine/runtime/ExportRuntimeContract.js';

export const SECURE_EXPORT_LIMITS = Object.freeze({
  files: 32,
  perFileBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  manifestBytes: 1 * 1024 * 1024,
} as const);

const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]+/iu;
const AUTHORIZATION = /\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/iu;
const COMMON_KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/u;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s<>:"|?*]+/u;
const POSIX_PROFILE_PATH = /\/(?:home|Users|tmp|var|etc)\/[^\s]+/u;

export interface MainSideExportDestination {
  /** Canonical folder path resolved from an opaque destination capability. */
  resolvedDirectory: string;
}

/**
 * Dependency-injectable PDF renderer for testing.
 * In production, SecureExportService uses Electron printToPDF internally.
 */
export interface PdfRenderDependency {
  renderHtmlToPdf(html: string): Promise<Buffer>;
}

export type SecureExportServiceResult =
  | {
      ok: true;
      publicResult: ExportSuccess;
      /** Main-process-only final bundle directory. Never return across IPC. */
      resolvedDirectory: string;
    }
  | {
      ok: false;
      publicResult: ExportFailure;
    };

interface ManifestFile {
  displayName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const PDF_MINIMUM_BYTES = 100;
const PDF_EOF_SEARCH_BYTES = 2_048;

export function validatePdfBuffer(content: Buffer): boolean {
  if (content.byteLength < PDF_MINIMUM_BYTES) return false;
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))) return false;
  const prefix = content.subarray(0, Math.min(content.length, 256)).toString('utf8').trimStart();
  if (/^<!doctype\s+html|^<html\b/iu.test(prefix)) return false;
  if (!content.includes(Buffer.from(' obj', 'ascii'))) return false;
  if (!content.includes(Buffer.from('startxref', 'ascii'))) return false;
  const tailStart = Math.max(0, content.length - PDF_EOF_SEARCH_BYTES);
  const tail = content.subarray(tailStart);
  const eof = tail.lastIndexOf(Buffer.from('%%EOF', 'ascii'));
  if (eof < 0) return false;
  const trailing = tail.subarray(eof + 5);
  return [...trailing].every((byte) => (
    byte === 0x00
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0c
    || byte === 0x0d
    || byte === 0x20
  ));
}

function intermediateDisplayName(relativeName: string): string {
  const suffix = '.preview.html';
  const base = relativeName.toLowerCase().endsWith('.pdf')
    ? relativeName.slice(0, -4)
    : relativeName;
  return `${base.slice(0, Math.max(1, 240 - suffix.length))}${suffix}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function fixedFailure(issue: ExportIssue): SecureExportServiceResult {
  return { ok: false, publicResult: createExportFailure(issue) };
}

function containsDisallowedSensitiveText(plan: SecureExportPlan, content: string): boolean {
  if (SECRET_ASSIGNMENT.test(content) || AUTHORIZATION.test(content) || COMMON_KEY_PREFIX.test(content)) {
    return true;
  }
  return plan.redaction.stripAbsolutePaths
    && (WINDOWS_PATH.test(content) || POSIX_PROFILE_PATH.test(content));
}

function resolveChild(directory: string, relativeName: string): string | null {
  if (path.basename(relativeName) !== relativeName || relativeName === 'manifest.json') return null;
  const resolved = path.resolve(directory, relativeName);
  const relative = path.relative(directory, resolved);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative)
    ? resolved
    : null;
}

export class SecureExportService {
  private readonly pdfDeps?: PdfRenderDependency;

  constructor(pdfDeps?: PdfRenderDependency) {
    this.pdfDeps = pdfDeps;
  }

  /**
   * Convert an HTML payload to PDF using Electron's printToPDF (main-only).
   * This is the ONLY PDF rendering path — it provides full Unicode/CJK
   * support via Chromium's text shaping engine.
   *
   * If Electron is not available (e.g. in a pure Node test environment),
   * or if the injected pdfDeps fail, this method throws and the caller
   * must fail-closed.
   */
  private async renderPdfFromHtml(html: string): Promise<Buffer> {
    // Prefer injected dependency (for testing)
    if (this.pdfDeps) {
      return this.pdfDeps.renderHtmlToPdf(html);
    }

    // Dynamic import of electron — only works in the main process
    let electronModule: typeof import('electron');
    try {
      electronModule = await import('electron');
    } catch {
      throw new Error(
        'PDF rendering requires Electron main process (printToPDF). '
        + 'Electron module is not available in this environment.',
      );
    }

    const { BrowserWindow } = electronModule;
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
      },
    });

    try {
      // Load HTML via data URL to avoid touching the filesystem
      const encodedHtml = encodeURIComponent(html);
      await win.loadURL(`data:text/html;charset=utf-8,${encodedHtml}`);
      const pdfData = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      return Buffer.from(pdfData);
    } finally {
      win.destroy();
    }
  }
  preview(rawPlan: unknown): ExportPreview | ExportFailure {
    const parsed = SecureExportPlanSchema.safeParse(rawPlan);
    if (!parsed.success) {
      return createExportFailure({ code: 'export_invalid_request', severity: 'error' });
    }
    const plan = parsed.data;
    if (plan.containsSensitiveFields && plan.privacyProfile !== 'private-local') {
      return createExportFailure({ code: 'export_privacy_blocked', severity: 'error' });
    }
    if (plan.files.length > SECURE_EXPORT_LIMITS.files) {
      return createExportFailure({ code: 'export_limit_exceeded', severity: 'error' });
    }

    const names = new Set<string>();
    const entries: ExportPreview['entries'] = [];
    let totalBytes = 0;
    let previewKind: ExportPreview['previewKind'] | null = null;
    for (const file of plan.files) {
      if (
        names.has(file.relativeName)
        || path.basename(file.relativeName) !== file.relativeName
        || file.relativeName === 'manifest.json'
        || containsDisallowedSensitiveText(plan, file.content)
      ) {
        return createExportFailure({ code: 'export_privacy_blocked', severity: 'error' });
      }
      names.add(file.relativeName);
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : Buffer.from(file.content, 'utf8');
      if (content.byteLength < 1 || content.byteLength > SECURE_EXPORT_LIMITS.perFileBytes) {
        return createExportFailure({ code: 'export_limit_exceeded', severity: 'error' });
      }
      totalBytes += content.byteLength;
      if (totalBytes > SECURE_EXPORT_LIMITS.totalBytes) {
        return createExportFailure({ code: 'export_limit_exceeded', severity: 'error' });
      }
      const role = file.intermediateFormat === 'html'
        ? 'html-intermediate' as const
        : 'deterministic-candidate' as const;
      if (previewKind !== null && previewKind !== role) {
        return createExportFailure({ code: 'export_invalid_request', severity: 'error' });
      }
      previewKind = role;
      entries.push({
        displayName: role === 'html-intermediate'
          ? intermediateDisplayName(file.relativeName)
          : file.relativeName,
        mediaType: role === 'html-intermediate' ? 'text/html' : file.mediaType,
        byteLength: content.byteLength,
        sha256: sha256(content),
        role,
      });
    }
    if (previewKind === null) {
      return createExportFailure({ code: 'export_invalid_request', severity: 'error' });
    }
    return {
      success: true,
      code: 'export_preview_ready',
      exportId: plan.exportId,
      format: plan.format,
      artifactId: plan.artifactId,
      artifactVersion: plan.artifactVersion,
      artifactManifestDigest: plan.artifactManifestDigest,
      previewKind,
      entries,
      issues: plan.issues,
    };
  }

  async write(
    rawPlan: unknown,
    destination: MainSideExportDestination,
  ): Promise<SecureExportServiceResult> {
    const preview = this.preview(rawPlan);
    if (!preview.success) return { ok: false, publicResult: preview };
    const parsed = SecureExportPlanSchema.safeParse(rawPlan);
    if (!parsed.success) {
      return fixedFailure({ code: 'export_invalid_request', severity: 'error' });
    }
    const plan = parsed.data;
    if (plan.containsSensitiveFields && plan.privacyProfile !== 'private-local') {
      return fixedFailure({ code: 'export_privacy_blocked', severity: 'error' });
    }
    if (
      typeof destination?.resolvedDirectory !== 'string'
      || !path.isAbsolute(destination.resolvedDirectory)
    ) {
      return fixedFailure({ code: 'export_destination_unavailable', severity: 'error' });
    }

    let stagingDirectory: string | null = null;
    try {
      const destinationDirectory = await fs.promises.realpath(destination.resolvedDirectory);
      if (!(await fs.promises.stat(destinationDirectory)).isDirectory()) {
        return fixedFailure({ code: 'export_destination_unavailable', severity: 'error' });
      }
      if (plan.files.length > SECURE_EXPORT_LIMITS.files) {
        return fixedFailure({ code: 'export_limit_exceeded', severity: 'error' });
      }

      const storageId = randomBytes(18).toString('base64url');
      stagingDirectory = path.join(destinationDirectory, `.metis-export-${storageId}.tmp`);
      const finalDirectory = path.join(destinationDirectory, `metis-export-${storageId}`);
      await fs.promises.mkdir(stagingDirectory, { mode: 0o700 });

      const names = new Set<string>();
      const manifestFiles: ManifestFile[] = [];
      let totalBytes = 0;
      for (const file of plan.files) {
        if (names.has(file.relativeName)) {
          throw new Error('duplicate export file');
        }
        names.add(file.relativeName);
        const outputPath = resolveChild(stagingDirectory, file.relativeName);
        if (!outputPath || containsDisallowedSensitiveText(plan, file.content)) {
          return fixedFailure({ code: 'export_privacy_blocked', severity: 'error' });
        }

        // Determine the raw payload
        const rawPayload = file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64')
          : Buffer.from(file.content, 'utf8');

        // If this is an HTML intermediate (for PDF), convert via Electron
        let content: Buffer;
        if (file.intermediateFormat === 'html') {
          try {
            const htmlContent = rawPayload.toString('utf8');
            content = await this.renderPdfFromHtml(htmlContent);
          } catch {
            // Fail-closed: PDF rendering error → no file written
            return fixedFailure({ code: 'export_render_failed', severity: 'error' });
          }
        } else {
          content = rawPayload;
        }

        if (file.mediaType === 'application/pdf' && !validatePdfBuffer(content)) {
          return fixedFailure({ code: 'export_render_failed', severity: 'error' });
        }

        if (content.byteLength < 1 || content.byteLength > SECURE_EXPORT_LIMITS.perFileBytes) {
          return fixedFailure({ code: 'export_limit_exceeded', severity: 'error' });
        }
        totalBytes += content.byteLength;
        if (totalBytes > SECURE_EXPORT_LIMITS.totalBytes) {
          return fixedFailure({ code: 'export_limit_exceeded', severity: 'error' });
        }
        await fs.promises.writeFile(outputPath, content, { flag: 'wx', mode: 0o600 });
        manifestFiles.push({
          displayName: file.relativeName,
          mediaType: file.mediaType,
          byteLength: content.byteLength,
          sha256: sha256(content),
        });
      }

      const manifest = stableJson({
        schemaVersion: 2,
        exportId: plan.exportId,
        projectId: plan.projectId,
        format: plan.format,
        scopes: plan.scopes,
        privacyProfile: plan.privacyProfile,
        redaction: plan.redaction,
        containsSensitiveFields: plan.containsSensitiveFields,
        requestedAt: plan.requestedAt,
        artifactId: plan.artifactId,
        artifactVersion: plan.artifactVersion,
        artifactManifestDigest: plan.artifactManifestDigest,
        provenance: plan.provenance,
        files: manifestFiles,
        issues: plan.issues,
      });
      const manifestBytes = Buffer.from(manifest, 'utf8');
      if (
        manifestBytes.byteLength > SECURE_EXPORT_LIMITS.manifestBytes
        || totalBytes + manifestBytes.byteLength > SECURE_EXPORT_LIMITS.totalBytes
      ) {
        return fixedFailure({ code: 'export_limit_exceeded', severity: 'error' });
      }
      await fs.promises.writeFile(
        path.join(stagingDirectory, 'manifest.json'),
        manifestBytes,
        { flag: 'wx', mode: 0o600 },
      );
      await fs.promises.rename(stagingDirectory, finalDirectory);
      stagingDirectory = null;

      return {
        ok: true,
        publicResult: {
          success: true,
          code: 'export_complete',
          exportId: plan.exportId,
          format: plan.format,
          artifactId: plan.artifactId,
          artifactVersion: plan.artifactVersion,
          artifactManifestDigest: plan.artifactManifestDigest,
          files: manifestFiles,
          manifestSha256: sha256(manifestBytes),
          issues: plan.issues,
        },
        resolvedDirectory: finalDirectory,
      };
    } catch {
      return fixedFailure({ code: 'export_write_failed', severity: 'error' });
    } finally {
      if (stagingDirectory) {
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
