import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EXPORT_RUNTIME_LIMITS,
  ExportDisplayNameSchema,
  ExportIssueSchema,
  ExportRedactionOptionsSchema,
  TrustedExportRequestSchema,
  createExportFailure,
  type ExportFailure,
  type ExportIssue,
  type ExportPrivacyProfile,
  type ExportRedactionOptions,
  type TrustedExportRequest,
  type ExportScope,
} from '../runtime/ExportRuntimeContract.js';
import { renderDocx } from './renderers/DocxRenderer.js';
import {
  RESEARCH_IMAGE_LIMITS,
  SUPPORTED_RESEARCH_IMAGE_MEDIA_TYPES,
  validateResearchImagePayload,
} from './renderers/ImageSupport.js';
import { runExportGates } from '../writing/ExportGate.js';

export const RESEARCH_EXPORT_BUILDER_LIMITS = Object.freeze({
  recordsPerScope: 2_000,
  recordIdChars: 256,
  titleChars: 1_000,
  contentChars: 1_000_000,
  fieldsPerRecord: 128,
  fieldKeyChars: 128,
  fieldValueChars: 1_000_000,
  totalInputChars: 16_000_000,
  outputFiles: 8,
  outputCharsPerFile: 64_000_000,
} as const);

// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]+/giu;
const AUTHORIZATION = /\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/giu;
const COMMON_KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s<>:"|?*]+/gu;
const POSIX_PROFILE_PATH = /\/(?:home|Users|tmp|var|etc)\/[^\s]+/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;

export const ExportSensitivitySchema = z.enum([
  'none',
  'personal',
  'secret',
  'absolute-path',
  'raw-transcript',
  'model-prompt',
  'tool-arguments',
]);

const SafeMultilineTextSchema = z.string()
  .max(RESEARCH_EXPORT_BUILDER_LIMITS.fieldValueChars)
  .refine((value) => !UNSAFE_MULTILINE_CONTROLS.test(value), {
    message: 'Snapshot text contains unsafe control characters',
  });

function safeSingleLine(maxLength: number) {
  return z.string()
    .min(1)
    .max(maxLength)
    .refine((value) => !UNSAFE_SINGLE_LINE_CONTROLS.test(value), {
      message: 'Snapshot label contains unsafe control characters',
    });
}

export const ResearchExportFieldSchema = z.strictObject({
  key: safeSingleLine(RESEARCH_EXPORT_BUILDER_LIMITS.fieldKeyChars),
  value: SafeMultilineTextSchema,
  sensitivity: ExportSensitivitySchema.default('none'),
});

export const ResearchExportImageSchema = z.strictObject({
  id: safeSingleLine(RESEARCH_EXPORT_BUILDER_LIMITS.recordIdChars),
  /** Main-authoritative zero-based artifact media order. */
  ordinal: z.number().int().min(0).max(15).optional(),
  mediaType: z.enum(SUPPORTED_RESEARCH_IMAGE_MEDIA_TYPES),
  /** Base64-encoded binary image data. */
  base64Data: z.string().max(4 * 1024 * 1024),
  /** SHA-256 of the decoded binary (hex). */
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  /** Main-derived intrinsic dimensions, verified again against the bytes. */
  widthPx: z.number().int().min(1).max(RESEARCH_IMAGE_LIMITS.widthPx),
  heightPx: z.number().int().min(1).max(RESEARCH_IMAGE_LIMITS.heightPx),
  caption: safeSingleLine(RESEARCH_EXPORT_BUILDER_LIMITS.titleChars),
}).superRefine((value, context) => {
  const validation = validateResearchImagePayload(value);
  if (!validation.ok) {
    context.addIssue({
      code: 'custom',
      message: validation.reason,
      path: ['base64Data'],
    });
  }
});

export const ResearchExportRecordSchema = z.strictObject({
  id: safeSingleLine(RESEARCH_EXPORT_BUILDER_LIMITS.recordIdChars),
  title: safeSingleLine(RESEARCH_EXPORT_BUILDER_LIMITS.titleChars),
  content: z.string()
    .max(RESEARCH_EXPORT_BUILDER_LIMITS.contentChars)
    .refine((value) => !UNSAFE_MULTILINE_CONTROLS.test(value), {
      message: 'Snapshot content contains unsafe control characters',
    }),
  sensitivity: ExportSensitivitySchema.default('none'),
  fields: z.array(ResearchExportFieldSchema)
    .max(RESEARCH_EXPORT_BUILDER_LIMITS.fieldsPerRecord)
    .default([]),
  images: z.array(ResearchExportImageSchema)
    .max(16)
    .default([]),
});

const ScopeRecordsSchema = z.array(ResearchExportRecordSchema)
  .max(RESEARCH_EXPORT_BUILDER_LIMITS.recordsPerScope);

export const ResearchExportArtifactBindingSchema = z.strictObject({
  artifactId: TrustedExportRequestSchema.shape.artifactId,
  artifactVersion: TrustedExportRequestSchema.shape.artifactVersion,
  artifactManifestDigest: TrustedExportRequestSchema.shape.artifactManifestDigest,
});

export const ResearchExportSnapshotSchema = z.strictObject({
  /** Trusted main-side binding. Builder rejects missing or mismatched bindings. */
  artifactBinding: ResearchExportArtifactBindingSchema.optional(),
  project: ScopeRecordsSchema.default([]),
  artifact: ScopeRecordsSchema.default([]),
  citations: ScopeRecordsSchema.default([]),
  evidence: ScopeRecordsSchema.default([]),
  audit: ScopeRecordsSchema.default([]),
});

export type ExportSensitivity = z.infer<typeof ExportSensitivitySchema>;
export type ResearchExportField = z.infer<typeof ResearchExportFieldSchema>;
export type ResearchExportRecord = z.infer<typeof ResearchExportRecordSchema>;
/** Input form allows schema defaults (fields/images/scopes) to be omitted by adapters. */
export type ResearchExportSnapshot = z.input<typeof ResearchExportSnapshotSchema>;
type ParsedResearchExportSnapshot = z.output<typeof ResearchExportSnapshotSchema>;

export const SecureExportOutputFileSchema = z.strictObject({
  relativeName: ExportDisplayNameSchema,
  mediaType: z.enum([
    'text/markdown',
    'text/csv',
    'application/json',
    'text/html',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf',
  ]),
  content: z.string().max(RESEARCH_EXPORT_BUILDER_LIMITS.outputCharsPerFile),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  /** When 'html', content is an intermediate HTML payload that the
   *  SecureExportService must convert to the declared mediaType via
   *  Electron printToPDF in the main process (required for CJK). */
  intermediateFormat: z.enum(['none', 'html']).default('none'),
});

export const SecureExportPlanSchema = z.strictObject({
  schemaVersion: z.literal(2),
  exportId: TrustedExportRequestSchema.shape.exportId,
  projectId: TrustedExportRequestSchema.shape.projectId,
  artifactId: TrustedExportRequestSchema.shape.artifactId,
  format: TrustedExportRequestSchema.shape.format,
  scopes: TrustedExportRequestSchema.shape.scopes,
  privacyProfile: TrustedExportRequestSchema.shape.privacyProfile,
  redaction: ExportRedactionOptionsSchema,
  requestedAt: TrustedExportRequestSchema.shape.requestedAt,
  privacyApplied: z.literal(true),
  containsSensitiveFields: z.boolean(),
  artifactVersion: z.number().int().min(1),
  artifactManifestDigest: TrustedExportRequestSchema.shape.artifactManifestDigest,
  provenance: z.strictObject({
    rendererVersion: z.string(),
    artifactId: TrustedExportRequestSchema.shape.artifactId,
    artifactVersion: z.number().int().min(1),
    sourceManifestDigest: TrustedExportRequestSchema.shape.artifactManifestDigest,
    gateIssues: z.array(z.strictObject({
      gate: z.string(),
      severity: z.enum(['warning', 'error']),
      message: z.string(),
    })),
  }),
  files: z.array(SecureExportOutputFileSchema)
    .min(1)
    .max(RESEARCH_EXPORT_BUILDER_LIMITS.outputFiles),
  issues: z.array(ExportIssueSchema).max(32),
}).superRefine((value, context) => {
  if (value.artifactId !== value.provenance.artifactId) {
    context.addIssue({
      code: 'custom',
      message: 'Artifact ID does not match provenance',
      path: ['provenance', 'artifactId'],
    });
  }
  if (value.artifactVersion !== value.provenance.artifactVersion) {
    context.addIssue({
      code: 'custom',
      message: 'Artifact version does not match provenance',
      path: ['provenance', 'artifactVersion'],
    });
  }
  if (value.artifactManifestDigest !== value.provenance.sourceManifestDigest) {
    context.addIssue({
      code: 'custom',
      message: 'Artifact manifest digest does not match provenance',
      path: ['provenance', 'sourceManifestDigest'],
    });
  }
});

export type SecureExportOutputFile = z.infer<typeof SecureExportOutputFileSchema>;
export type SecureExportPlan = z.infer<typeof SecureExportPlanSchema>;

export type ResearchExportBuildResult =
  | { ok: true; plan: SecureExportPlan }
  | { ok: false; failure: ExportFailure };

const SCOPE_ORDER: readonly ExportScope[] = [
  'project',
  'artifact',
  'citations',
  'evidence',
  'audit',
];

function effectiveRedaction(
  profile: ExportPrivacyProfile,
  requested: ExportRedactionOptions,
): ExportRedactionOptions {
  if (profile === 'private-local') return requested;
  return {
    stripSecrets: true,
    stripAbsolutePaths: true,
    stripPersonalData: true,
    pseudonymizeParticipants: true,
    omitRawTranscripts: true,
    omitModelPrompts: true,
    omitToolArguments: true,
  };
}

function redactText(
  value: string,
  options: ExportRedactionOptions,
): { value: string; changed: boolean } {
  let output = value;
  output = output.replace(SECRET_ASSIGNMENT, '[redacted-secret]');
  output = output.replace(AUTHORIZATION, '[redacted-authorization]');
  output = output.replace(COMMON_KEY_PREFIX, '[redacted-secret]');
  if (options.stripAbsolutePaths) {
    output = output.replace(WINDOWS_PATH, '[redacted-path]');
    output = output.replace(POSIX_PROFILE_PATH, '[redacted-path]');
  }
  if (options.stripPersonalData) {
    output = output.replace(EMAIL, '[redacted-email]');
    output = output.replace(PHONE, '[redacted-phone]');
  }
  return { value: output, changed: output !== value };
}

function shouldOmit(
  sensitivity: ExportSensitivity,
  options: ExportRedactionOptions,
): boolean {
  return sensitivity === 'secret'
    || (sensitivity === 'absolute-path' && options.stripAbsolutePaths)
    || (sensitivity === 'raw-transcript' && options.omitRawTranscripts)
    || (sensitivity === 'model-prompt' && options.omitModelPrompts)
    || (sensitivity === 'tool-arguments' && options.omitToolArguments);
}

function pseudonym(id: string): string {
  return `Participant-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

function sensitivityRemains(
  sensitivity: ExportSensitivity,
  options: ExportRedactionOptions,
): boolean {
  return (sensitivity === 'personal' && !options.stripPersonalData)
    || (sensitivity === 'absolute-path' && !options.stripAbsolutePaths)
    || (sensitivity === 'raw-transcript' && !options.omitRawTranscripts)
    || (sensitivity === 'model-prompt' && !options.omitModelPrompts)
    || (sensitivity === 'tool-arguments' && !options.omitToolArguments);
}

function sanitizeRecord(
  record: ResearchExportRecord,
  options: ExportRedactionOptions,
): { record: ResearchExportRecord | null; changed: boolean; sensitiveRemaining: boolean } {
  if (shouldOmit(record.sensitivity, options)) {
    return { record: null, changed: true, sensitiveRemaining: false };
  }

  let changed = false;
  const personal = record.sensitivity === 'personal' && options.stripPersonalData;
  const personalLabel = options.pseudonymizeParticipants
    ? pseudonym(record.id)
    : '[redacted-personal-data]';
  const id = personal ? personalLabel : redactText(record.id, options).value;
  const title = personal ? personalLabel : redactText(record.title, options).value;
  if (id !== record.id) changed = true;
  if (title !== record.title) changed = true;
  const contentRedaction = redactText(personal ? '[redacted-personal-data]' : record.content, options);
  changed ||= contentRedaction.changed || personal;

  const fields: ResearchExportField[] = [];
  let sensitiveRemaining = sensitivityRemains(record.sensitivity, options);
  for (const field of [...record.fields].sort((left, right) => (
    left.key < right.key ? -1 : left.key > right.key ? 1
      : left.value < right.value ? -1 : left.value > right.value ? 1 : 0
  ))) {
    if (shouldOmit(field.sensitivity, options)) {
      changed = true;
      continue;
    }
    const fieldPersonal = field.sensitivity === 'personal' && options.stripPersonalData;
    const redacted = redactText(fieldPersonal ? '[redacted-personal-data]' : field.value, options);
    changed ||= fieldPersonal || redacted.changed;
    const fieldSensitivityRemains = sensitivityRemains(field.sensitivity, options);
    sensitiveRemaining ||= fieldSensitivityRemains;
    fields.push({
      ...field,
      value: redacted.value,
      sensitivity: fieldSensitivityRemains ? field.sensitivity : 'none',
    });
  }

  // Images pass through (they're already validated binary data; the
  // sensitivity check on the record already decided whether to omit
  // the entire record).
  const images = record.images ?? [];

  return {
    record: {
      id,
      title,
      content: contentRedaction.value,
      sensitivity: sensitiveRemaining ? record.sensitivity : 'none',
      fields,
      images,
    },
    changed,
    sensitiveRemaining,
  };
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

function csvCell(value: string): string {
  const safe = /^[\t\r\n ]*[=+@-]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/gu, '""')}"`;
}

function baseName(value: string): string {
  const lastDot = value.lastIndexOf('.');
  return lastDot > 0 ? value.slice(0, lastDot) : value;
}

function outputName(displayName: string, extension: string): string {
  const maximumBaseChars = EXPORT_RUNTIME_LIMITS.displayNameChars - extension.length;
  return `${baseName(displayName).slice(0, maximumBaseChars)}${extension}`;
}

function buildMarkdown(
  request: TrustedExportRequest,
  records: ReadonlyMap<ExportScope, ResearchExportRecord[]>,
): SecureExportOutputFile {
  const lines = [`# ${request.displayName}`, ''];
  for (const scope of SCOPE_ORDER) {
    if (!request.scopes.includes(scope)) continue;
    lines.push(`## ${scope}`, '');
    for (const record of records.get(scope) ?? []) {
      lines.push(`### ${record.title}`, '', record.content, '');
      for (const field of record.fields) lines.push(`- ${field.key}: ${field.value}`);
      if (record.fields.length > 0) lines.push('');
    }
  }
  lines.push(
    '---',
    '',
    `Artifact version: ${request.artifactVersion}`,
    `Artifact ID: ${request.artifactId}`,
    `Artifact manifest SHA-256: ${request.artifactManifestDigest}`,
    '',
  );
  return {
    relativeName: outputName(request.displayName, '.md'),
    mediaType: 'text/markdown',
    content: `${lines.join('\n').trimEnd()}\n`,
    encoding: 'utf8',
    intermediateFormat: 'none',
  };
}

function buildCsv(
  request: TrustedExportRequest,
  records: ReadonlyMap<ExportScope, ResearchExportRecord[]>,
): SecureExportOutputFile {
  const rows = [[
    'scope',
    'id',
    'title',
    'content',
    'fields_json',
    'artifact_id',
    'artifact_version',
    'artifact_manifest_sha256',
  ]];
  for (const scope of SCOPE_ORDER) {
    if (!request.scopes.includes(scope)) continue;
    for (const record of records.get(scope) ?? []) {
      rows.push([
        scope,
        record.id,
        record.title,
        record.content,
        JSON.stringify(stableValue(record.fields)),
        request.artifactId,
        String(request.artifactVersion),
        request.artifactManifestDigest,
      ]);
    }
  }
  return {
    relativeName: outputName(request.displayName, '.csv'),
    mediaType: 'text/csv',
    content: `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
    encoding: 'utf8',
    intermediateFormat: 'none',
  };
}

function buildJsonBundle(
  request: TrustedExportRequest,
  records: ReadonlyMap<ExportScope, ResearchExportRecord[]>,
): SecureExportOutputFile {
  return {
    relativeName: outputName(request.displayName, '.json'),
    mediaType: 'application/json',
    content: stableJson({
      schemaVersion: 1,
      exportId: request.exportId,
      projectId: request.projectId,
      privacyProfile: request.privacyProfile,
      requestedAt: request.requestedAt,
      artifactId: request.artifactId,
      artifactVersion: request.artifactVersion,
      artifactManifestDigest: request.artifactManifestDigest,
      scopes: Object.fromEntries(
        SCOPE_ORDER
          .filter((scope) => request.scopes.includes(scope))
          .map((scope) => [scope, records.get(scope) ?? []]),
      ),
    }),
    encoding: 'utf8',
    intermediateFormat: 'none',
  };
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scopeTitle(scope: ExportScope): string {
  const titles: Record<ExportScope, string> = {
    project: 'Project Summary',
    artifact: 'Research Artifacts',
    citations: 'Citations & References',
    evidence: 'Evidence Appendix',
    audit: 'Audit Trail',
  };
  return titles[scope];
}

function buildHtml(
  request: TrustedExportRequest,
  records: ReadonlyMap<ExportScope, ResearchExportRecord[]>,
): SecureExportOutputFile {
  const lines: string[] = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="UTF-8">',
    `<title>${escHtml(request.displayName)}</title>`,
    '<style>',
    'body{font-family:Georgia,serif;max-width:50rem;margin:2rem auto;padding:0 1.5rem;line-height:1.7}',
    'h1{border-bottom:2px solid #333;padding-bottom:.3rem}',
    'table{border-collapse:collapse;width:100%;margin:1rem 0}',
    'th,td{border:1px solid #ccc;padding:.4rem .6rem}',
    'th{background:#f0f0f0}',
    '.provenance{margin-top:3rem;border-top:1px solid #ccc;padding-top:1rem;font-size:.8rem;color:#666}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>${escHtml(request.displayName)}</h1>`,
  ];

  for (const scope of SCOPE_ORDER) {
    if (!request.scopes.includes(scope)) continue;
    if ((records.get(scope) ?? []).length === 0) continue;
    lines.push(`<h2>${escHtml(scopeTitle(scope))}</h2>`);
    for (const record of records.get(scope) ?? []) {
      lines.push(`<h3>${escHtml(record.title)}</h3>`);
      for (const para of record.content.split('\n')) {
        const trimmed = para.trim();
        if (trimmed) lines.push(`<p>${escHtml(trimmed)}</p>`);
      }
      if (record.fields.length > 0) {
        lines.push('<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>');
        for (const field of record.fields) {
          lines.push(`<tr><td>${escHtml(field.key)}</td><td>${escHtml(field.value)}</td></tr>`);
        }
        lines.push('</tbody></table>');
      }
    }
  }

  lines.push('<footer class="provenance"><dl>');
  lines.push(`<dt>Export ID</dt><dd><code>${escHtml(request.exportId)}</code></dd>`);
  lines.push(`<dt>Project ID</dt><dd><code>${escHtml(request.projectId)}</code></dd>`);
  lines.push(`<dt>Format</dt><dd>html</dd>`);
  lines.push(`<dt>Privacy Profile</dt><dd>${escHtml(request.privacyProfile)}</dd>`);
  lines.push(`<dt>Schema Version</dt><dd>2</dd>`);
  lines.push(`<dt>Artifact Version</dt><dd>${request.artifactVersion}</dd>`);
  lines.push(`<dt>Artifact ID</dt><dd><code>${escHtml(request.artifactId)}</code></dd>`);
  lines.push(`<dt>Artifact Manifest SHA-256</dt><dd><code>${escHtml(request.artifactManifestDigest)}</code></dd>`);
  lines.push('</dl></footer>');
  lines.push('</body>');
  lines.push('</html>');

  return {
    relativeName: outputName(request.displayName, '.html'),
    mediaType: 'text/html',
    content: `${lines.join('\n')}\n`,
    encoding: 'utf8',
    intermediateFormat: 'none',
  };
}

function countSnapshotChars(snapshot: ParsedResearchExportSnapshot): number {
  let total = 0;
  for (const scope of SCOPE_ORDER) {
    for (const record of snapshot[scope]) {
      total += record.id.length + record.title.length + record.content.length;
      for (const field of record.fields) total += field.key.length + field.value.length;
      for (const image of record.images) {
        total += image.id.length + image.caption.length + image.base64Data.length + image.sha256.length;
      }
    }
  }
  return total;
}

export function buildResearchExport(
  rawRequest: unknown,
  rawSnapshot: unknown,
): ResearchExportBuildResult {
  const request = TrustedExportRequestSchema.safeParse(rawRequest);
  if (!request.success) return { ok: false, failure: createExportFailure() };

  const snapshot = ResearchExportSnapshotSchema.safeParse(rawSnapshot);
  if (
    !snapshot.success
    || countSnapshotChars(snapshot.data) > RESEARCH_EXPORT_BUILDER_LIMITS.totalInputChars
  ) {
    return {
      ok: false,
      failure: createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' }),
    };
  }
  const snapshotBinding = snapshot.data.artifactBinding;
  if (
    snapshotBinding === undefined
    || snapshotBinding.artifactId !== request.data.artifactId
    || snapshotBinding.artifactVersion !== request.data.artifactVersion
    || snapshotBinding.artifactManifestDigest !== request.data.artifactManifestDigest
  ) {
    return {
      ok: false,
      failure: createExportFailure({
        code: 'export_artifact_binding_mismatch',
        severity: 'error',
      }),
    };
  }

  const options = effectiveRedaction(request.data.privacyProfile, request.data.redaction);
  const records = new Map<ExportScope, ResearchExportRecord[]>();
  // Output selection is not an authority boundary.  Security/truth gates must
  // always see the complete snapshot, otherwise a caller could omit the
  // artifact/citation/evidence scopes and export an unverified result through
  // a seemingly harmless `project`-only request.
  const gateRecords = new Map<ExportScope, ResearchExportRecord[]>();
  const issues: ExportIssue[] = [];
  let redactionApplied = false;
  let containsSensitiveFields = false;
  for (const scope of SCOPE_ORDER) {
    const sanitized: ResearchExportRecord[] = [];
    for (const record of [...snapshot.data[scope]].sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1
        : left.title < right.title ? -1 : left.title > right.title ? 1 : 0
    ))) {
      const result = sanitizeRecord(record, options);
      redactionApplied ||= result.changed;
      containsSensitiveFields ||= result.sensitiveRemaining;
      if (result.record) sanitized.push(result.record);
    }
    gateRecords.set(scope, sanitized);
    if (!request.data.scopes.includes(scope)) continue;
    if (sanitized.length === 0) {
      issues.push({ code: 'export_scope_empty', severity: 'warning', scope });
    }
    records.set(scope, sanitized);
  }
  if (redactionApplied) issues.push({ code: 'export_redaction_applied', severity: 'warning' });

  // ── Export gates (fail-closed for error severity) ──────────────
  if ((gateRecords.get('artifact') ?? []).length !== 1) {
    return {
      ok: false,
      failure: createExportFailure({ code: 'export_gate_blocked', severity: 'error' }),
    };
  }
  const gateResult = runExportGates(gateRecords, request.data.privacyProfile, containsSensitiveFields);
  if (!gateResult.passed) {
    return {
      ok: false,
      failure: createExportFailure({ code: 'export_gate_blocked', severity: 'error' }),
    };
  }

  // ── Artifact version is strict from request (no default, no guessing) ──
  const { artifactVersion, artifactManifestDigest } = request.data;
  // Convert gate warnings to export issues
  for (const gi of gateResult.issues) {
    if (gi.severity === 'warning') {
      issues.push({ code: 'export_gate_warning', severity: 'warning' });
    }
  }

  // ── Render output file(s) ─────────────────────────────────────
  let file: SecureExportOutputFile;
  switch (request.data.format) {
    case 'markdown':
      file = buildMarkdown(request.data, records);
      break;
    case 'html':
      file = buildHtml(request.data, records);
      break;
    case 'csv':
      file = buildCsv(request.data, records);
      break;
    case 'json-bundle':
      file = buildJsonBundle(request.data, records);
      break;
    case 'docx': {
      const rendered = renderDocx({ request: request.data, records });
      if (!rendered.ok) {
        return {
          ok: false,
          failure: createExportFailure({ code: 'export_render_failed', severity: 'error' }),
        };
      }
      if (
        rendered.mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || rendered.extension !== '.docx'
      ) {
        return {
          ok: false,
          failure: createExportFailure({ code: 'export_render_failed', severity: 'error' }),
        };
      }
      file = {
        relativeName: outputName(request.data.displayName, rendered.extension),
        mediaType: rendered.mediaType,
        content: Buffer.from(rendered.bytes).toString('base64'),
        encoding: 'base64',
        intermediateFormat: 'none',
      };
      break;
    }
    case 'pdf': {
      // PDF requires CJK support which is only possible via Electron
      // printToPDF in the main process. We generate an HTML intermediate
      // payload here; SecureExportService converts it to PDF on write.
      const htmlFile = buildHtml(request.data, records);
      file = {
        relativeName: outputName(request.data.displayName, '.pdf'),
        mediaType: 'application/pdf',
        content: htmlFile.content,
        encoding: 'utf8',
        intermediateFormat: 'html',
      };
      break;
    }
    default:
      return {
        ok: false,
        failure: createExportFailure({ code: 'export_format_unsupported', severity: 'error' }),
      };
  }

  const plan = SecureExportPlanSchema.safeParse({
    schemaVersion: 2,
    exportId: request.data.exportId,
    projectId: request.data.projectId,
    artifactId: request.data.artifactId,
    format: request.data.format,
    scopes: request.data.scopes,
    privacyProfile: request.data.privacyProfile,
    redaction: options,
    requestedAt: request.data.requestedAt,
    privacyApplied: true,
    containsSensitiveFields,
    artifactVersion,
    artifactManifestDigest,
    provenance: {
      rendererVersion: request.data.format === 'pdf'
        ? 'electron-printToPDF-v1'
        : request.data.format === 'docx'
          ? 'ooxml-zip-v3-images'
          : 'text-v2',
      artifactId: request.data.artifactId,
      artifactVersion,
      sourceManifestDigest: artifactManifestDigest,
      gateIssues: gateResult.issues.map((gi) => ({
        gate: gi.gate,
        severity: gi.severity,
        message: gi.message,
      })),
    },
    files: [file],
    issues,
  });
  return plan.success
    ? { ok: true, plan: plan.data }
    : {
        ok: false,
        failure: createExportFailure({ code: 'export_limit_exceeded', severity: 'error' }),
      };
}
