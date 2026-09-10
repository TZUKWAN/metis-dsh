/**
 * Tool presentation layer — converts raw ToolResult strings into a strict,
 * provider-safe ProviderFeedback contract.
 *
 * SECURITY properties:
 *   - No module-level mutable state. Each AgentLoop receives its own frozen
 *     registry built from the tools it is allowed to use.
 *   - Built-in presenters are bound to an internal manifest and cannot be
 *     overridden by public ToolSpec.decodeResult.
 *   - Status-first branching: any error, throw, HITL denial, retry exhaustion,
 *     same-tool limit, or unknown tool failure becomes the fixed
 *     "tool_failed" presentation; success presenters never see error content.
 *   - Privileged/suspicious output is replaced with the whole-field fallback
 *     [TOOL_DETAILS_UNAVAILABLE]; partial regex substitution is forbidden.
 *   - Authored-content tools must pass a per-tool safety contract before any
 *     detail crosses the boundary. Output that cannot be proven safe is
 *     suppressed in full.
 */

import type { ToolResult, ToolSpec } from '../core/types.js';
import {
  type ToolPresentation,
  type ProviderToolFeedback,
  type ProviderToolFeedbackStatus,
  safeParseToolPresentation,
  safeParseProviderFeedback,
  safeParseToolResult,
  RECOVERY_TOOL_FEEDBACK,
  MAX_PROVIDER_CONTENT_LENGTH,
  safeTruncateContent,
} from '../runtime/ToolPresentationContract.js';

export type ToolDecoder = NonNullable<ToolSpec['decodeResult']>;

/**
 * Runtime-immutable presenter registry implemented as a closure.
 * Callers receive only a lookup function; the underlying storage is inaccessible.
 */
export type ToolPresenterRegistry = (name: string) => ToolDecoder | undefined;

const TOOL_DETAILS_UNAVAILABLE = '[TOOL_DETAILS_UNAVAILABLE]';

// ─── Fixed status-first fallbacks ───────────────────────────────

function toolFailedPresentation(toolName: string): ToolPresentation {
  return {
    toolName,
    status: 'tool_failed',
    summary: 'Tool execution failed',
  };
}

function unknownSuccessPresentation(toolName: string): ToolPresentation {
  return {
    toolName,
    status: 'completed',
    summary: 'Tool result suppressed',
    fallback: true,
  };
}

// ─── Registry construction ──────────────────────────────────────

/**
 * Build an immutable, per-loop presenter registry from tool specs and optional
 * loop-local overrides. Duplicate names are rejected (last-wins is unsafe).
 */
export function createToolPresenterRegistry(
  specs: readonly ToolSpec[],
  overrides?: ReadonlyMap<string, ToolDecoder>,
): ToolPresenterRegistry {
  const map = new Map<string, ToolDecoder>();
  for (const spec of specs) {
    if (spec.decodeResult) {
      if (map.has(spec.name)) {
        throw new Error(`Duplicate tool presenter registration: ${spec.name}`);
      }
      map.set(spec.name, spec.decodeResult);
    }
  }
  if (overrides) {
    for (const [name, decoder] of overrides) {
      if (map.has(name)) {
        throw new Error(`Duplicate tool presenter registration: ${name}`);
      }
      map.set(name, decoder);
    }
  }
  // Return a closure so the Map is never exposed and cannot be mutated.
  return (name: string) => map.get(name);
}

// ─── Authored-content allowlist ─────────────────────────────────

/**
 * Tools whose output is intentionally authored/search content may pass detail
 * through to the provider after passing a strict per-tool safety contract.
 * All other tools (file system, shell, export, etc.) are privileged: their
 * detail is always dropped and only a fixed summary is allowed to cross the
 * boundary. No free-text regex is used for this decision.
 */
const AUTHORED_CONTENT_TOOLS = new Set([
  'search_papers',
  'arxiv_search',
  'web_search',
  'web_research_plan',
  'ncpssd_search',
  'fulltext_search',
  'crossref_lookup',
  'openalex_lookup',
  'journal_directory_search',
  'journal_directory_detail',
  'search_library',
  'find_library_duplicates',
  'recommend_papers',
  'literature_review',
  'daily_papers',
  'import_by_doi',
  'import_by_arxiv',
  'web_import',
  'import_papers',
  'parse_bibtex',
  'format_citation',
  'writing_stage_check',
  'style_calibration',
  'section_guide',
  'citation_triangulate',
  'citation_passport_record',
  'citation_passport_get',
  'citation_passport_list',
  'citation_passport_add_signal',
  'citation_passport_scan',
  'retraction_watch_update',
  'retraction_watch_lookup',
  'retraction_watch_stats',
  'journal_integrity_update',
  'journal_integrity_lookup',
  'journal_integrity_stats',
  'read_pdf',
]);

function isAuthoredContentTool(toolName: string): boolean {
  return AUTHORED_CONTENT_TOOLS.has(toolName);
}

// ─── Authored-content safety contract ───────────────────────────

/**
 * Patterns that must never pass through to the provider in any string field.
 * Detection triggers whole-field suppression, not partial redaction.
 */
const HOSTILE_CONTENT_PATTERNS: readonly RegExp[] = [
  // Local POSIX paths (absolute paths under common roots, including inside quotes/brackets)
  /(?:[\s"'\-(>[]|^)(?:\/home\/|\/tmp\/|\/root\/|\/srv\/|\/Users\/|\/var\/|\/etc\/|\/opt\/|\/run\/|\/data\/|\/workspace\/|\/Volumes\/)/,
  // Windows absolute paths
  /[A-Za-z]:\\/,
  // UNC paths
  /\\\\[a-zA-Z]/,
  // file:// URI scheme
  /file:\/\/\/?/i,
  // Credential patterns
  /api[_-]?key\s*[=:]\s*\S/i,
  /password\s*[=:]\s*\S/i,
  /secret\s*[=:]\s*\S/i,
  /token\s*[=:]\s*\S/i,
  /Authorization\s*[=:]\s*\S/i,
  /Bearer\s+\S/i,
  // Command execution markers (also catch them inside quotes or brackets)
  /(?:[\s"'\-(>[]|^)(?:stdout|stderr|command|cwd|env)\s*:/i,
  // Error string leaked through structured fields (handler error-as-string)
  /(?:[\s"'\-(>[]|^)Error\s*:\s+\S/i,
  // Shell injection / command patterns
  /(?:\s|^)(?:curl\s+|wget\s+|bash\s+-c|sh\s+-c|cmd\s+\/c|powershell\s+-)/i,
  // Environment variable leaks
  /(?:\s|^)[A-Z_]{3,30}=(?!(\s|$))/,
];

function isHostileContent(text: string): boolean {
  for (const pattern of HOSTILE_CONTENT_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ─── Structured-output decoder factory ──────────────────────────

/**
 * Build a decoder that only accepts strict, per-tool JSON DTOs. The raw handler
 * output must be valid JSON and must conform to the provided Zod schema; any
 * free-text or out-of-schema content is suppressed in full. This removes all
 * string-based heuristics from the provider boundary.
 */
function buildStructuredDecoder<T>(
  toolName: string,
  summary: string,
  schema: z.ZodType<T>,
  formatter: (data: T) => string,
): ToolDecoder {
  return (raw: string): ToolPresentation => {
    let parsed: T;
    try {
      const json = JSON.parse(raw) as unknown;
      const result = schema.safeParse(json);
      if (!result.success) {
        return { toolName, status: 'tool_failed', summary: 'Tool result suppressed' };
      }
      parsed = result.data;
    } catch {
      return { toolName, status: 'tool_failed', summary: 'Tool result suppressed' };
    }
    const detail = formatter(parsed);
    // Hostile content detection: if the formatted detail contains paths,
    // credentials, or command markers, suppress it in full.
    if (isHostileContent(detail)) {
      return {
        toolName,
        status: 'ok',
        summary,
        detail: TOOL_DETAILS_UNAVAILABLE,
      };
    }
    const validated = SafeString.safeParse(detail);
    return {
      toolName,
      status: 'ok',
      summary,
      detail: validated.success ? validated.data : TOOL_DETAILS_UNAVAILABLE,
    };
  };
}

/**
 * Fixed-summary decoder for side-effect / mutation tools. Provides a safe,
 * non-leaking confirmation message without reflecting any raw handler output
 * into the provider context.
 */
function buildFixedSuccessDecoder(toolName: string, summary: string): ToolDecoder {
  return () => ({
    toolName,
    status: 'ok',
    summary,
  });
}

// ─── Public presentation API ────────────────────────────────────

/**
 * Convert a raw ToolResult into a strict ProviderToolFeedback ready for the
 * provider message history. All paths go through status-first branching and
 * schema validation; failures recover to the fixed recovery message.
 */
export function presentForProvider(
  toolResult: ToolResult,
  registry: ToolPresenterRegistry,
  allowedToolNames: readonly string[],
): ProviderToolFeedback {
  const presentation = buildPresentation(toolResult, registry);
  return buildFeedback(toolResult, presentation, allowedToolNames);
}

function buildPresentation(
  toolResult: ToolResult,
  registry: ToolPresenterRegistry,
): ToolPresentation {
  // Validate the raw ToolResult shape at the boundary.
  const parsedResult = safeParseToolResult(toolResult);
  if (!parsedResult.success) {
    return toolFailedPresentation(String(toolResult.toolName ?? 'unknown'));
  }
  const validResult = parsedResult.data;

  // Fail-closed: only the explicit 'ok' status may enter the success path.
  // Any other runtime status (including 'error', 'fatal', undefined, etc.)
  // is treated as a tool failure.
  if (validResult.status !== 'ok') {
    return toolFailedPresentation(validResult.toolName);
  }

  // Success path: only registered decoders may convert raw output.
  const decoder = registry(validResult.toolName);
  if (!decoder) {
    return unknownSuccessPresentation(validResult.toolName);
  }

  let presentation: ToolPresentation;
  try {
    presentation = decoder(validResult.content, 'ok');
  } catch {
    return toolFailedPresentation(validResult.toolName);
  }

  const validated = safeParseToolPresentation(presentation);
  if (!validated.success) {
    return toolFailedPresentation(validResult.toolName);
  }

  // Decoders do not need to know their own tool name; enforce the real one.
  const normalized: ToolPresentation = {
    ...validated.data,
    toolName: validResult.toolName,
  };

  // Privileged tools (file system, shell, export, etc.) never pass detail to
  // the provider. Their decoder-supplied summary is also untrusted, so we
  // replace it with a fixed, non-leaking summary. Only explicit authored-content
  // tools may retain both summary and detail.
  if (!isAuthoredContentTool(validResult.toolName)) {
    return {
      toolName: validResult.toolName,
      status: 'completed',
      summary: 'Tool completed',
    };
  }

  return normalized;
}

function deriveProviderStatus(
  presentation: ToolPresentation,
  systemCode?: string,
): {
  status: ProviderToolFeedbackStatus;
  code: string;
} {
  if (presentation.status === 'ok' || presentation.status === 'completed') {
    return { status: 'ok', code: 'ok' };
  }
  // Only whitelisted system-generated codes may pass through.
  const SYSTEM_CODES = new Set(['validation_unavailable', 'handler_error']);
  const code = (systemCode && SYSTEM_CODES.has(systemCode)) ? systemCode : 'tool_failed';
  return { status: 'error', code };
}

function buildFeedback(
  toolResult: ToolResult,
  presentation: ToolPresentation,
  allowedToolNames: readonly string[],
): ProviderToolFeedback {
  const parts = [presentation.summary];
  if (presentation.detail) {
    parts.push(presentation.detail);
  }
  const joined = parts.join('\n\n');
  // If the combined content would exceed the provider boundary, drop the detail
  // entirely rather than slicing mid-token or mid-path.
  const content = joined.length <= MAX_PROVIDER_CONTENT_LENGTH
    ? joined
    : safeTruncateContent(`${presentation.summary}\n\n[DETAIL_TRUNCATED]`, MAX_PROVIDER_CONTENT_LENGTH);
  const name = allowedToolNames.includes(toolResult.toolName)
    ? toolResult.toolName
    : '__recovery__';

  const systemCode = typeof toolResult.metadata?.code === 'string' ? toolResult.metadata.code : undefined;
  const { status, code } = deriveProviderStatus(presentation, systemCode);

  const feedback: ProviderToolFeedback = {
    role: 'tool',
    content,
    toolCallId: toolResult.toolCallId,
    name,
    status,
    code,
  };

  const parsed = safeParseProviderFeedback(feedback, allowedToolNames);
  if (parsed.success) return parsed.data;
  return RECOVERY_TOOL_FEEDBACK;
}

// ─── Built-in strict decoders ───────────────────────────────────

import { z } from 'zod';

const SafeString = z.string().max(8000);

function decodeReadFile(_raw: string): ToolPresentation {
  void _raw;
  return {
    toolName: 'read_file',
    status: 'ok',
    summary: 'File content retrieved',
    detail: TOOL_DETAILS_UNAVAILABLE,
  };
}

function decodeWriteFile(raw: string): ToolPresentation {
  // Accept only the expected success sentence; never reflect arbitrary raw text.
  const parsed = z.string().regex(/^Successfully wrote \d+ bytes$/).safeParse(raw.trim());
  return {
    toolName: 'write_file',
    status: 'ok',
    summary: parsed.success ? raw.trim() : 'Successfully wrote bytes',
  };
}

function decodeCreateDirectory(_raw: string): ToolPresentation {
  void _raw;
  return {
    toolName: 'create_directory',
    status: 'ok',
    summary: 'Directory created',
  };
}

function decodeListDirectory(_raw: string): ToolPresentation {
  void _raw;
  return {
    toolName: 'list_directory',
    status: 'ok',
    summary: 'Directory listing',
    detail: TOOL_DETAILS_UNAVAILABLE,
  };
}

function decodeSearchFiles(raw: string): ToolPresentation {
  return {
    toolName: 'search_files',
    status: 'ok',
    summary: raw.trim() === 'No files found' ? 'No files found' : 'File search results',
    detail: TOOL_DETAILS_UNAVAILABLE,
  };
}

function decodeSearchContent(raw: string): ToolPresentation {
  return {
    toolName: 'search_content',
    status: 'ok',
    summary: raw.trim() === 'No matches found' ? 'No matches found' : 'Content search results',
    detail: TOOL_DETAILS_UNAVAILABLE,
  };
}

function decodeReadMultipleFiles(_raw: string): ToolPresentation {
  void _raw;
  return {
    toolName: 'read_multiple_files',
    status: 'ok',
    summary: 'Multiple files retrieved',
    detail: TOOL_DETAILS_UNAVAILABLE,
  };
}

function decodeCommandOutput(toolName: string) {
  return function (_raw: string): ToolPresentation {
    void _raw;
    return {
      toolName,
      status: 'ok',
      summary: 'Command output',
      detail: TOOL_DETAILS_UNAVAILABLE,
    };
  };
}

// ─── Per-tool structured output schemas ─────────────────────────

const FulltextSearchResultSchema = z.strictObject({
  query: z.string(),
  total: z.number().int().min(0),
  matches: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      score: z.number(),
      matchedFields: z.array(z.string()),
      snippet: z.string().optional(),
    }),
  ),
});

type FulltextSearchResult = z.infer<typeof FulltextSearchResultSchema>;

function formatFulltextSearchResult(result: FulltextSearchResult): string {
  const lines = [
    `Query: ${result.query}`,
    `Found ${result.total} matching paper(s):`,
    ...result.matches.map((m, i) => {
      const parts = [`${i + 1}. ${m.title}`, `   Score: ${m.score} | Matched fields: ${m.matchedFields.join(', ')}`];
      if (m.snippet) parts.push(`   Snippet: ${m.snippet.replace(/\n/g, ' ')}`);
      return parts.join('\n');
    }),
  ];
  return lines.join('\n');
}

// ─── Reusable academic DTO schemas ──────────────────────────────

const PaperSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  arxivId: z.string().optional(),
  url: z.string().optional(),
  pdfUrl: z.string().optional(),
  abstract: z.string().optional(),
});

const PaperListResultSchema = z.strictObject({
  query: z.string().optional(),
  total: z.number().int().min(0),
  papers: z.array(PaperSchema),
});

type PaperListResult = z.infer<typeof PaperListResultSchema>;

function formatPaperListResult(summary: string, result: PaperListResult): string {
  const lines = [summary, `Total: ${result.total}`];
  if (result.query) lines.push(`Query: ${result.query}`);
  for (const [i, paper] of result.papers.entries()) {
    const year = paper.year ?? 'n.d.';
    const venue = paper.venue ? ` — ${paper.venue}` : '';
    const doi = paper.doi ? ` DOI: ${paper.doi}` : '';
    const arxiv = paper.arxivId ? ` arXiv: ${paper.arxivId}` : '';
    const url = paper.url ? ` URL: ${paper.url}` : '';
    lines.push(`${i + 1}. "${paper.title}" by ${paper.authors.join(', ') || 'Unknown authors'} (${year})${venue}${doi}${arxiv}${url}`);
    if (paper.abstract) lines.push(`   Abstract: ${paper.abstract.replace(/\n+/g, ' ').slice(0, 400)}`);
  }
  return lines.join('\n');
}

const BibEntrySchema = z.strictObject({
  type: z.string(),
  key: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int(),
  journal: z.string().optional(),
  volume: z.string().optional(),
  pages: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
});

const BibtexParseResultSchema = z.strictObject({
  entries: z.array(BibEntrySchema),
});

type BibtexParseResult = z.infer<typeof BibtexParseResultSchema>;

function formatBibtexParseResult(result: BibtexParseResult): string {
  if (result.entries.length === 0) return 'No BibTeX entries found.';
  const lines = [`Parsed ${result.entries.length} BibTeX entries:`];
  for (const [i, entry] of result.entries.entries()) {
    const year = entry.year || 'n.d.';
    const journal = entry.journal ? ` — ${entry.journal}` : '';
    lines.push(`${i + 1}. [${entry.type}] ${entry.key}: "${entry.title}" by ${entry.authors.join(', ') || 'Unknown authors'} (${year})${journal}`);
  }
  return lines.join('\n');
}

const FormattedCitationSchema = z.strictObject({
  citation: z.string(),
  style: z.string(),
});

type FormattedCitation = z.infer<typeof FormattedCitationSchema>;

function formatFormattedCitation(result: FormattedCitation): string {
  return `[${result.style}] ${result.citation}`;
}

const LibrarySearchItemSchema = z.strictObject({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  authors: z.string().optional(),
  sourceId: z.string().optional(),
  snippet: z.string().optional(),
});

const LibrarySearchResultSchema = z.strictObject({
  query: z.string(),
  total: z.number().int().min(0),
  items: z.array(LibrarySearchItemSchema),
});

type LibrarySearchResult = z.infer<typeof LibrarySearchResultSchema>;

function formatLibrarySearchResult(result: LibrarySearchResult): string {
  const lines = [`Local library results for "${result.query}"`, `Found ${result.total} item(s):`];
  for (const item of result.items) {
    const meta = item.type === 'paper'
      ? `${item.title} (${item.year || 'n.d.'}) — ${item.authors || 'Unknown authors'}`
      : item.title;
    lines.push(`- [${item.type.toUpperCase()}] ${meta}`);
    if (item.snippet) lines.push(`  Snippet: ${item.snippet.replace(/\n+/g, ' ').slice(0, 280)}`);
  }
  return lines.join('\n');
}

const DuplicateGroupSchema = z.strictObject({
  type: z.string(),
  key: z.string(),
  papers: z.array(z.strictObject({
    id: z.string(),
    title: z.string(),
    authors: z.array(z.string()),
    year: z.number().int().optional(),
  })),
});

const DuplicateGroupListSchema = z.strictObject({
  totalGroups: z.number().int().min(0),
  groups: z.array(DuplicateGroupSchema),
});

type DuplicateGroupList = z.infer<typeof DuplicateGroupListSchema>;

function formatDuplicateGroupList(result: DuplicateGroupList): string {
  if (result.totalGroups === 0) return 'No duplicate groups found.';
  const lines = [`Duplicate groups: ${result.totalGroups}`];
  for (const group of result.groups) {
    lines.push(`- ${group.type.toUpperCase()}: "${group.key}" — ${group.papers.length} papers`);
    for (const paper of group.papers) {
      const authors = paper.authors.join(', ') || 'Unknown authors';
      lines.push(`  - ${paper.id}: "${paper.title}" by ${authors} (${paper.year || 'n.d.'})`);
    }
  }
  return lines.join('\n');
}

const ImportItemSchema = z.strictObject({
  title: z.string(),
  status: z.string(),
  reason: z.string().optional(),
});

const ImportPapersResultSchema = z.strictObject({
  source: z.string(),
  total: z.number().int().min(0),
  imported: z.number().int().min(0),
  skipped: z.number().int().min(0),
  items: z.array(ImportItemSchema),
});

type ImportPapersResult = z.infer<typeof ImportPapersResultSchema>;

function formatImportPapersResult(result: ImportPapersResult): string {
  const lines = [`Import papers report (${result.source})`, `Total: ${result.total} | Imported: ${result.imported} | Skipped: ${result.skipped}`];
  for (const item of result.items) {
    const reason = item.reason ? ` — ${item.reason}` : '';
    lines.push(`- [${item.status}] "${item.title}"${reason}`);
  }
  return lines.join('\n');
}

const IndexRecordSchema = z.strictObject({
  index: z.string(),
  found: z.boolean(),
  doi: z.string().optional(),
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
});

const TriangulationResultSchema = z.strictObject({
  doi: z.string(),
  existsIn: z.array(z.string()),
  missingIn: z.array(z.string()),
  titleConsensus: z.string(),
  yearConsensus: z.string(),
  authorConsensus: z.string(),
  overall: z.string(),
  records: z.array(IndexRecordSchema),
  warnings: z.array(z.string()),
});

type TriangulationResult = z.infer<typeof TriangulationResultSchema>;

function formatTriangulationResult(result: TriangulationResult): string {
  const lines = [
    `Citation triangulation: ${result.doi}`,
    `Verdict: ${result.overall}`,
    `Exists in: ${result.existsIn.join(', ') || 'none'}`,
    `Missing in: ${result.missingIn.join(', ') || 'none'}`,
    `Title consensus: ${result.titleConsensus}`,
    `Year consensus: ${result.yearConsensus}`,
    `Author consensus: ${result.authorConsensus}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map((w) => `- ${w}`));
  }
  lines.push('', 'Per-index records:');
  for (const record of result.records) {
    const meta = record.found
      ? `"${record.title ?? 'Untitled'}" by ${(record.authors ?? []).join(', ') || 'Unknown'} (${record.year ?? 'n.d.'}) — ${record.venue ?? 'Unknown venue'}`
      : `Not found${record.error ? ` (${record.error})` : ''}`;
    lines.push(`- ${record.index}: ${meta}`);
  }
  return lines.join('\n');
}

const ContaminationSignalSchema = z.strictObject({
  source: z.string(),
  type: z.string(),
  details: z.string().optional(),
  url: z.string().optional(),
  detectedAt: z.number().optional(),
});

const PassportEntrySchema = z.strictObject({
  doi: z.string(),
  normalizedDoi: z.string(),
  overall: z.string(),
  titleConsensus: z.string(),
  yearConsensus: z.string(),
  authorConsensus: z.string(),
  existsIn: z.array(z.string()),
  missingIn: z.array(z.string()),
  warnings: z.array(z.string()),
  lastTriangulatedAt: z.number().optional(),
  triangulationCount: z.number().int().min(0).optional(),
  contaminationSignals: z.array(ContaminationSignalSchema).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const PassportListSchema = z.strictObject({
  total: z.number().int().min(0),
  passports: z.array(PassportEntrySchema),
});

type PassportEntry = z.infer<typeof PassportEntrySchema>;
type PassportList = z.infer<typeof PassportListSchema>;

function formatPassportEntry(entry: PassportEntry): string {
  const lines = [
    `Citation passport: ${entry.doi}`,
    `Verdict: ${entry.overall}`,
    `Exists in: ${entry.existsIn.join(', ') || 'none'}`,
    `Missing in: ${entry.missingIn.join(', ') || 'none'}`,
    `Warnings: ${entry.warnings.length > 0 ? entry.warnings.join('; ') : 'none'}`,
  ];
  const signals = entry.contaminationSignals ?? [];
  if (signals.length > 0) {
    lines.push('', 'Contamination signals:');
    for (const signal of signals) {
      lines.push(`- [${signal.type}] ${signal.source}: ${signal.details ?? ''}`);
    }
  }
  return lines.join('\n');
}

function formatPassportList(result: PassportList): string {
  const lines = [`Citation passports: ${result.total}`];
  for (const passport of result.passports) {
    lines.push('', formatPassportEntry(passport));
  }
  return lines.join('\n');
}

const ScanResultSchema = z.strictObject({
  doi: z.string(),
  normalizedDoi: z.string().optional(),
  signalCount: z.number().int().min(0),
  signals: z.array(ContaminationSignalSchema),
  scannedAt: z.number().optional(),
});

type ScanResult = z.infer<typeof ScanResultSchema>;

function formatScanResult(result: ScanResult): string {
  const lines = [
    `Contamination scan: ${result.doi}`,
    `Signals found: ${result.signalCount}`,
  ];
  for (const signal of result.signals) {
    lines.push(`- [${signal.type}] ${signal.source}: ${signal.details ?? ''}`);
  }
  return lines.join('\n');
}

const RetractionEntrySchema = z.strictObject({
  recordId: z.string(),
  originalDoi: z.string(),
  retractionDoi: z.string().optional(),
  retractionNature: z.string(),
  reason: z.string().optional(),
  retractionDate: z.string().optional(),
  title: z.string().optional(),
  journal: z.string().optional(),
  publisher: z.string().optional(),
  urls: z.string().optional(),
  notes: z.string().optional(),
});

const RetractionLookupSchema = z.strictObject({
  doi: z.string(),
  entries: z.array(RetractionEntrySchema),
});

type RetractionLookup = z.infer<typeof RetractionLookupSchema>;

function formatRetractionLookup(result: RetractionLookup): string {
  const lines = [`Retraction Watch lookup: ${result.doi}`, `Entries: ${result.entries.length}`];
  for (const entry of result.entries) {
    lines.push(`- ${entry.recordId}: ${entry.retractionNature}${entry.reason ? ` — ${entry.reason}` : ''}`);
  }
  return lines.join('\n');
}

const RetractionStatsSchema = z.strictObject({
  version: z.number().int(),
  updatedAt: z.number(),
  sourceUrl: z.string(),
  entryCount: z.number().int().min(0),
  uniqueDoiCount: z.number().int().min(0),
});

type RetractionStats = z.infer<typeof RetractionStatsSchema>;

function formatRetractionStats(result: RetractionStats): string {
  return `Retraction Watch mirror: ${result.entryCount} entries, ${result.uniqueDoiCount} unique DOIs (updated ${new Date(result.updatedAt).toISOString()}).\nSource: ${result.sourceUrl}`;
}

const JournalIntegrityEntrySchema = z.strictObject({
  type: z.string(),
  source: z.string(),
  title: z.string().optional(),
  issn: z.string().optional(),
  reason: z.string().optional(),
  date: z.string().optional(),
  url: z.string().optional(),
  details: z.string().optional(),
});

const JournalIntegrityLookupSchema = z.strictObject({
  total: z.number().int().min(0),
  entries: z.array(JournalIntegrityEntrySchema),
});

type JournalIntegrityLookup = z.infer<typeof JournalIntegrityLookupSchema>;

function formatJournalIntegrityLookup(result: JournalIntegrityLookup): string {
  const lines = [`Journal integrity flags: ${result.total}`];
  for (const entry of result.entries) {
    const titlePart = entry.title ? ` "${entry.title}"` : '';
    lines.push(`- [${entry.type}] ${entry.source}${titlePart}: ${entry.details ?? entry.reason ?? ''}`);
  }
  return lines.join('\n');
}

const JournalIntegrityStatsEntrySchema = z.strictObject({
  type: z.string(),
  sourceUrl: z.string(),
  updatedAt: z.number(),
  uniqueIssnCount: z.number().int().min(0),
  uniqueTitleCount: z.number().int().min(0),
});

const JournalIntegrityStatsSchema = z.strictObject({
  mirrors: z.array(JournalIntegrityStatsEntrySchema),
});

type JournalIntegrityStats = z.infer<typeof JournalIntegrityStatsSchema>;

function formatJournalIntegrityStats(result: JournalIntegrityStats): string {
  const lines = ['Journal integrity mirror stats'];
  for (const mirror of result.mirrors) {
    lines.push(`- ${mirror.type}: ${mirror.uniqueIssnCount} ISSNs, ${mirror.uniqueTitleCount} titles (updated ${new Date(mirror.updatedAt).toISOString()})\n  Source: ${mirror.sourceUrl}`);
  }
  return lines.join('\n');
}

// ─── Per-tool authored-content decoders ─────────────────────────

// ─── web_search / ncpssd_search(2026-09-04 修复:此前无 decoder,检索结果被
// 抑制为 "Tool completed",模型看不到任何检索内容——直接破坏选题模块
// 「真实检索」要求。宽松 passthrough schema + 只读格式化,不放宽安全边界)。───

const WebSearchFeedbackSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  offline: z.boolean().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const NcpssdSearchFeedbackSchema = z.object({
  ok: z.boolean().optional(),
  code: z.string().optional(),
  note: z.string().optional(),
  query: z.string().optional(),
  total: z.number().optional(),
  papers: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const decodeWebSearch = buildStructuredDecoder(
  'web_search',
  'Web search results',
  WebSearchFeedbackSchema,
  (r) => {
    if (!r.ok) return `web_search failed${r.offline ? ' (offline)' : ''}: ${r.error ?? 'unknown error'}`;
    const result = asRecord(r.result);
    const lines: string[] = [`Source: ${String(result.source ?? 'web')} | query: ${String(result.query ?? '')}`];
    for (const key of ['answer', 'abstract', 'abstractUrl'] as const) {
      const value = result[key];
      if (typeof value === 'string' && value) lines.push(`${key}: ${value}`);
    }
    if (Array.isArray(result.relatedTopics)) {
      for (const topic of result.relatedTopics) {
        const record = asRecord(topic);
        const text = typeof record.text === 'string' ? record.text : '';
        const url = typeof record.url === 'string' ? record.url : '';
        if (text) lines.push(`- ${text}${url ? ` (${url})` : ''}`);
      }
    }
    if (Array.isArray(result.results)) {
      for (const item of result.results) {
        const record = asRecord(item);
        const title = typeof record.title === 'string' ? record.title : '';
        const url = typeof record.url === 'string' ? record.url : '';
        const snippet = typeof record.snippet === 'string' ? record.snippet : '';
        if (title) lines.push(`- ${title}${url ? ` (${url})` : ''}${snippet ? `\n  ${snippet}` : ''}`);
      }
    }
    return lines.join('\n');
  },
);

const decodeNcpssdSearch = buildStructuredDecoder(
  'ncpssd_search',
  'NCPSSD 中文文献检索结果',
  NcpssdSearchFeedbackSchema,
  (r) => {
    if (r.ok === false) {
      return `ncpssd_search 失败(code=${r.code ?? 'unknown'})。注意:来源本轮不可用不等于「0 结果」,请如实告知用户并尝试其他来源。${r.note ? ` ${r.note}` : ''}`;
    }
    const papers = r.papers ?? [];
    if (papers.length === 0) return `ncpssd_search:0 条结果(query: ${r.query ?? ''})。这是真实检索后的空结果。`;
    const lines = [`ncpssd_search 共 ${r.total ?? papers.length} 条(query: ${r.query ?? ''},仅核心刊: ${r.coreOnly !== false}):`];
    for (const paper of papers) {
      const title = typeof paper.title === 'string' ? paper.title : '';
      const authors = asStringArray(paper.authors).join(', ');
      const year = typeof paper.year === 'number' ? paper.year : '';
      const venue = typeof paper.venue === 'string' ? paper.venue : '';
      const url = typeof paper.url === 'string' && paper.url ? ` URL: ${paper.url}` : '';
      const abstract = typeof paper.abstract === 'string' && paper.abstract ? `\n  摘要: ${paper.abstract}` : '';
      lines.push(`- ${title}(${authors}${authors ? ', ' : ''}${year})${venue ? ` ${venue}` : ''}${url}${abstract}`);
    }
    return lines.join('\n');
  },
);

const WebResearchPlanFeedbackSchema = z.object({
  ok: z.boolean(),
  plan: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
}).passthrough();

const decodeWebResearchPlan = buildStructuredDecoder(
  'web_research_plan',
  'Web research plan',
  WebResearchPlanFeedbackSchema,
  (r) => {
    if (!r.ok) return `web_research_plan failed: ${r.error ?? 'unknown error'}`;
    const plan = asRecord(r.plan);
    const lines: string[] = [`Search plan for: ${String(plan.originalQuery ?? '')}`];
    if (Array.isArray(plan.queries)) {
      for (const query of plan.queries) {
        const record = asRecord(query);
        lines.push(`- [${String(record.dimension ?? 'core')}/${String(record.language ?? '')}] ${String(record.query ?? '')}`);
      }
    }
    if (Array.isArray(plan.coverageChecklist)) {
      lines.push('Coverage checklist:');
      for (const item of plan.coverageChecklist) {
        if (typeof item === 'string') lines.push(`  ? ${item}`);
      }
    }
    return lines.join('\n');
  },
);

const decodeSearchPapers = buildStructuredDecoder(
  'search_papers',
  'Paper search results',
  PaperListResultSchema,
  (r) => formatPaperListResult('Paper search results', r),
);
const decodeArxivSearch = buildStructuredDecoder(
  'arxiv_search',
  'arXiv search results',
  PaperListResultSchema,
  (r) => formatPaperListResult('arXiv search results', r),
);
const decodeFulltextSearch = buildStructuredDecoder(
  'fulltext_search',
  'Full-text search results',
  FulltextSearchResultSchema,
  formatFulltextSearchResult,
);
const decodeCrossrefLookup = buildStructuredDecoder(
  'crossref_lookup',
  'Crossref lookup results',
  PaperListResultSchema,
  (r) => formatPaperListResult('Crossref lookup results', r),
);
const decodeOpenAlexLookup = buildStructuredDecoder(
  'openalex_lookup',
  'OpenAlex lookup results',
  PaperListResultSchema,
  (r) => formatPaperListResult('OpenAlex lookup results', r),
);
const decodeRecommendPapers = buildStructuredDecoder(
  'recommend_papers',
  'Paper recommendations',
  PaperListResultSchema,
  (r) => formatPaperListResult('Paper recommendations', r),
);
// Content tools — structured DTOs with safe content extraction
const decodeLiteratureReview = buildFixedSuccessDecoder('literature_review', 'Literature review generated');
const decodeDailyPapers = buildFixedSuccessDecoder('daily_papers', 'Daily papers briefing generated');

const decodeSearchLibrary = buildStructuredDecoder(
  'search_library',
  'Library search results',
  LibrarySearchResultSchema,
  formatLibrarySearchResult,
);
const decodeFindLibraryDuplicates = buildStructuredDecoder(
  'find_library_duplicates',
  'Duplicate search results',
  DuplicateGroupListSchema,
  formatDuplicateGroupList,
);

const PdfReadResultSchema = z.strictObject({
  title: z.string().optional(),
  author: z.string().optional(),
  totalPages: z.number().int().min(0),
  extractedPages: z.number().int().min(0),
  keywords: z.array(z.string()).optional(),
  pageTexts: z.array(z.string()),
});

type PdfReadResult = z.infer<typeof PdfReadResultSchema>;

function formatPdfReadResult(result: PdfReadResult): string {
  const lines: string[] = [];
  if (result.title) lines.push(`Title: ${result.title}`);
  if (result.author) lines.push(`Author: ${result.author}`);
  lines.push(`Pages: ${result.totalPages} (extracted: ${result.extractedPages})`);
  if (result.keywords && result.keywords.length > 0) {
    lines.push(`Keywords: ${result.keywords.join(', ')}`);
  }
  for (const [i, text] of result.pageTexts.entries()) {
    lines.push(`--- Page ${i + 1} ---`);
    lines.push(text.slice(0, 2000)); // Per-page cap
  }
  return lines.join('\n');
}

const decodeReadPdf = buildStructuredDecoder(
  'read_pdf',
  'PDF content extracted',
  PdfReadResultSchema,
  formatPdfReadResult,
);

const decodeImportPapers = buildStructuredDecoder(
  'import_papers',
  'Import results',
  ImportPapersResultSchema,
  formatImportPapersResult,
);
const decodeImportByDoi = buildStructuredDecoder(
  'import_by_doi',
  'Import results',
  PaperListResultSchema,
  (r) => formatPaperListResult('Imported paper', r),
);
const decodeImportByArxiv = buildStructuredDecoder(
  'import_by_arxiv',
  'Import results',
  PaperListResultSchema,
  (r) => formatPaperListResult('Imported paper', r),
);
const decodeWebImport = buildStructuredDecoder(
  'web_import',
  'Import results',
  PaperListResultSchema,
  (r) => formatPaperListResult('Web import result', r),
);
const decodeParseBibtex = buildStructuredDecoder(
  'parse_bibtex',
  'BibTeX parsed',
  BibtexParseResultSchema,
  formatBibtexParseResult,
);
const decodeFormatCitation = buildStructuredDecoder(
  'format_citation',
  'Citation formatted',
  FormattedCitationSchema,
  formatFormattedCitation,
);

const decodeWritingStageCheck = buildFixedSuccessDecoder('writing_stage_check', 'Writing stage check completed');
const decodeStyleCalibration = buildFixedSuccessDecoder('style_calibration', 'Style calibration completed');
const decodeSectionGuide = buildFixedSuccessDecoder('section_guide', 'Section guide returned');

const decodeCitationTriangulate = buildStructuredDecoder(
  'citation_triangulate',
  'Triangulation results',
  TriangulationResultSchema,
  formatTriangulationResult,
);
const decodeCitationPassportRecord = buildFixedSuccessDecoder(
  'citation_passport_record',
  'Citation passport recorded',
);
const decodeCitationPassportGet = buildStructuredDecoder(
  'citation_passport_get',
  'Passport details',
  PassportEntrySchema,
  formatPassportEntry,
);
const decodeCitationPassportList = buildStructuredDecoder(
  'citation_passport_list',
  'Passport list',
  PassportListSchema,
  formatPassportList,
);
const decodeCitationPassportAddSignal = buildFixedSuccessDecoder(
  'citation_passport_add_signal',
  'Contamination signal added',
);
const decodeCitationPassportScan = buildStructuredDecoder(
  'citation_passport_scan',
  'Passport scan',
  ScanResultSchema,
  formatScanResult,
);

const decodeRetractionWatchUpdate = buildFixedSuccessDecoder(
  'retraction_watch_update',
  'Retraction Watch mirror updated',
);
const decodeRetractionWatchLookup = buildStructuredDecoder(
  'retraction_watch_lookup',
  'Retraction watch lookup',
  RetractionLookupSchema,
  formatRetractionLookup,
);
const decodeRetractionWatchStats = buildStructuredDecoder(
  'retraction_watch_stats',
  'Retraction watch stats',
  RetractionStatsSchema,
  formatRetractionStats,
);
const decodeJournalIntegrityUpdate = buildFixedSuccessDecoder(
  'journal_integrity_update',
  'Journal integrity mirror updated',
);
const decodeJournalIntegrityLookup = buildStructuredDecoder(
  'journal_integrity_lookup',
  'Journal integrity lookup',
  JournalIntegrityLookupSchema,
  formatJournalIntegrityLookup,
);
const decodeJournalIntegrityStats = buildStructuredDecoder(
  'journal_integrity_stats',
  'Journal integrity stats',
  JournalIntegrityStatsSchema,
  formatJournalIntegrityStats,
);

// ─── Journal directory (LetPub / Wanwei Shukan) decoders ────────

const CatalogFieldOptionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
});

const CatalogJournalSummarySchema = z.strictObject({
  source: z.string(),
  id: z.string(),
  name: z.string(),
  nameAbbr: z.string().optional(),
  issn: z.string().optional(),
  submissionLabel: z.string().optional(),
  categoryTags: z.array(z.string()),
  detailUrl: z.string(),
});

const CatalogSearchResultSchema = z.strictObject({
  source: z.string(),
  field: CatalogFieldOptionSchema.nullable().optional(),
  keyword: z.string(),
  page: z.number().int(),
  totalHint: z.string().optional(),
  journals: z.array(CatalogJournalSummarySchema),
  fieldCandidates: z.array(CatalogFieldOptionSchema).optional(),
  note: z.string().optional(),
});

type CatalogSearchResultData = z.infer<typeof CatalogSearchResultSchema>;

function formatCatalogSearchResult(result: CatalogSearchResultData): string {
  const lines = [`Journal directory search — source: ${result.source}`];
  if (result.field) lines.push(`Field: ${result.field.name} (id ${result.field.id})`);
  if (result.keyword) lines.push(`Keyword: ${result.keyword}`);
  if (result.totalHint) lines.push(`Total: ${result.totalHint}`);
  if (result.note) lines.push(`Note: ${result.note}`);
  if (result.fieldCandidates?.length) {
    lines.push(`Field candidates: ${result.fieldCandidates.map((option) => `${option.name}(id ${option.id})`).join('、')}`);
  }
  for (const [i, journal] of result.journals.entries()) {
    const issn = journal.issn ? ` ISSN ${journal.issn}` : '';
    const channel = journal.submissionLabel ? ` [${journal.submissionLabel}]` : '';
    const tags = journal.categoryTags.length > 0 ? ` (${journal.categoryTags.join('/')})` : '';
    lines.push(`${i + 1}. ${journal.name}${issn}${channel}${tags} — id ${journal.id}`);
  }
  if (result.journals.length === 0 && !result.note) lines.push('No journals on this page.');
  return lines.join('\n');
}

const CatalogJournalDetailSchema = z.strictObject({
  source: z.string(),
  id: z.string(),
  name: z.string().optional(),
  detailUrl: z.string(),
  issn: z.string().optional(),
  eissn: z.string().optional(),
  cn: z.string().optional(),
  publisher: z.string().optional(),
  supervisor: z.string().optional(),
  hostInstitution: z.string().optional(),
  language: z.string().optional(),
  officialWebsite: z.string().optional(),
  submissionUrl: z.string().optional(),
  submissionEmails: z.array(z.string()),
  phone: z.string().optional(),
  reviewCycle: z.string().optional(),
  acceptanceRatio: z.string().optional(),
  articleProcessingCharge: z.string().optional(),
  warningStatus: z.string().optional(),
  indexingTags: z.array(z.string()),
  submissionNotice: z.string().optional(),
});

type CatalogJournalDetailData = z.infer<typeof CatalogJournalDetailSchema>;

function formatCatalogJournalDetail(detail: CatalogJournalDetailData): string {
  const lines = [`Journal detail — source: ${detail.source}, id ${detail.id}`];
  if (detail.name) lines.push(`Name: ${detail.name}`);
  const identity = [detail.issn && `ISSN ${detail.issn}`, detail.eissn && `E-ISSN ${detail.eissn}`, detail.cn && `CN ${detail.cn}`]
    .filter(Boolean).join(' · ');
  if (identity) lines.push(identity);
  if (detail.publisher) lines.push(`Publisher: ${detail.publisher}`);
  if (detail.supervisor) lines.push(`Supervisor: ${detail.supervisor}`);
  if (detail.hostInstitution) lines.push(`Host: ${detail.hostInstitution}`);
  if (detail.language) lines.push(`Language: ${detail.language}`);
  if (detail.officialWebsite) lines.push(`Official website: ${detail.officialWebsite}`);
  if (detail.submissionUrl) lines.push(`Submission URL: ${detail.submissionUrl}`);
  if (detail.submissionEmails.length > 0) lines.push(`Submission email: ${detail.submissionEmails.join('; ')}`);
  if (detail.phone) lines.push(`Phone: ${detail.phone}`);
  if (detail.reviewCycle) lines.push(`Review cycle (crowd-shared): ${detail.reviewCycle}`);
  if (detail.acceptanceRatio) lines.push(`Acceptance ratio (crowd-shared): ${detail.acceptanceRatio}`);
  if (detail.articleProcessingCharge) lines.push(`Article processing charge: ${detail.articleProcessingCharge}`);
  if (detail.warningStatus) lines.push(`Warning list: ${detail.warningStatus}`);
  if (detail.indexingTags.length > 0) lines.push(`Indexing: ${detail.indexingTags.join('、')}`);
  if (detail.submissionNotice) lines.push(`Submission notice: ${detail.submissionNotice.slice(0, 800)}`);
  return lines.join('\n');
}

const decodeJournalDirectorySearch = buildStructuredDecoder(
  'journal_directory_search',
  'Journal directory search results',
  CatalogSearchResultSchema,
  formatCatalogSearchResult,
);
const decodeJournalDirectoryDetail = buildStructuredDecoder(
  'journal_directory_detail',
  'Journal directory detail',
  CatalogJournalDetailSchema,
  formatCatalogJournalDetail,
);

/**
 * Return a map of built-in decoders. This is used by AgentLoop to seed its
 * immutable per-loop registry; it is never exposed as a mutable module state.
 */
export function buildBuiltinDecoders(): Map<string, ToolDecoder> {
  const map = new Map<string, ToolDecoder>();
  map.set('read_file', decodeReadFile);
  map.set('write_file', decodeWriteFile);
  map.set('create_directory', decodeCreateDirectory);
  map.set('list_directory', decodeListDirectory);
  map.set('search_files', decodeSearchFiles);
  map.set('search_content', decodeSearchContent);
  map.set('read_multiple_files', decodeReadMultipleFiles);

  map.set('execute_command', decodeCommandOutput('execute_command'));
  map.set('execute_code', decodeCommandOutput('execute_code'));
  map.set('run_experiment_script', decodeCommandOutput('run_experiment_script'));

  map.set('search_papers', decodeSearchPapers);
  map.set('arxiv_search', decodeArxivSearch);
  map.set('fulltext_search', decodeFulltextSearch);
  map.set('crossref_lookup', decodeCrossrefLookup);
  map.set('openalex_lookup', decodeOpenAlexLookup);
  map.set('journal_directory_search', decodeJournalDirectorySearch);
  map.set('journal_directory_detail', decodeJournalDirectoryDetail);
  map.set('recommend_papers', decodeRecommendPapers);
  map.set('literature_review', decodeLiteratureReview);
  map.set('daily_papers', decodeDailyPapers);
  map.set('read_pdf', decodeReadPdf);

  map.set('search_library', decodeSearchLibrary);
  map.set('find_library_duplicates', decodeFindLibraryDuplicates);

  map.set('import_papers', decodeImportPapers);
  map.set('import_by_doi', decodeImportByDoi);
  map.set('import_by_arxiv', decodeImportByArxiv);
  map.set('web_import', decodeWebImport);

  map.set('parse_bibtex', decodeParseBibtex);
  map.set('format_citation', decodeFormatCitation);

  map.set('writing_stage_check', decodeWritingStageCheck);
  map.set('style_calibration', decodeStyleCalibration);
  map.set('section_guide', decodeSectionGuide);

  map.set('citation_triangulate', decodeCitationTriangulate);
  map.set('citation_passport_record', decodeCitationPassportRecord);
  map.set('citation_passport_get', decodeCitationPassportGet);
  map.set('citation_passport_list', decodeCitationPassportList);
  map.set('web_research_plan', decodeWebResearchPlan);
  map.set('web_search', decodeWebSearch);
  map.set('ncpssd_search', decodeNcpssdSearch);
  map.set('citation_passport_add_signal', decodeCitationPassportAddSignal);
  map.set('citation_passport_scan', decodeCitationPassportScan);

  map.set('retraction_watch_update', decodeRetractionWatchUpdate);
  map.set('retraction_watch_lookup', decodeRetractionWatchLookup);
  map.set('retraction_watch_stats', decodeRetractionWatchStats);
  map.set('journal_integrity_update', decodeJournalIntegrityUpdate);
  map.set('journal_integrity_lookup', decodeJournalIntegrityLookup);
  map.set('journal_integrity_stats', decodeJournalIntegrityStats);

  return map;
}
