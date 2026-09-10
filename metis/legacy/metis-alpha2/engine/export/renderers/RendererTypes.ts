/**
 * Shared types for the export renderers.
 *
 * Each renderer converts sanitized research-export records into a specific
 * binary or text format (DOCX, PDF, HTML). The renderers are pure functions
 * that never touch the filesystem — they return bytes, and the caller
 * (SecureExportService) handles persistence.
 */

import type {
  ExportScope,
  TrustedExportRequest,
} from '../../runtime/ExportRuntimeContract.js';
import type { ResearchExportRecord } from '../ResearchExportBuilder.js';

export interface RenderInput {
  request: TrustedExportRequest;
  records: ReadonlyMap<ExportScope, ResearchExportRecord[]>;
}

export interface RenderSuccess {
  ok: true;
  bytes: Uint8Array;
  mediaType: string;
  extension: string;
}

export interface RenderFailure {
  ok: false;
  error: string;
}

export type RenderResult = RenderSuccess | RenderFailure;

/**
 * A renderer converts sanitized records into a specific output format.
 * Implementations must be deterministic and fail-closed: if rendering
 * cannot produce a valid file, return `{ ok: false }` rather than
 * writing a corrupt or placeholder file.
 */
export interface ResearchRenderer {
  render(input: RenderInput): RenderResult;
}

// ── Shared scope metadata ─────────────────────────────────────────

export const SCOPE_ORDER: readonly ExportScope[] = [
  'project',
  'artifact',
  'citations',
  'evidence',
  'audit',
];

export const SCOPE_TITLES: Readonly<Record<ExportScope, string>> = {
  project: 'Project Summary',
  artifact: 'Research Artifacts',
  citations: 'Citations & References',
  evidence: 'Evidence Appendix',
  audit: 'Audit Trail',
};

// ── XML escaping ──────────────────────────────────────────────────

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── HTML escaping ─────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── PDF string escaping ───────────────────────────────────────────

export function escapePdfString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// ── Markdown line splitting ───────────────────────────────────────

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Collect all records for the requested scopes, in canonical order.
 */
export function collectScopedRecords(
  input: RenderInput,
): { scope: ExportScope; records: readonly ResearchExportRecord[] }[] {
  const result: { scope: ExportScope; records: readonly ResearchExportRecord[] }[] = [];
  for (const scope of SCOPE_ORDER) {
    if (!input.request.scopes.includes(scope)) continue;
    result.push({ scope, records: input.records.get(scope) ?? [] });
  }
  return result;
}
