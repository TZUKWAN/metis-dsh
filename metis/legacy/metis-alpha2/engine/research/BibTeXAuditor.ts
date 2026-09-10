/**
 * BibTeX Auditor — parse .bib files, scan LaTeX citation usage, and audit
 * reference integrity.
 *
 * Inspired by science-agent (andyed/science-agent) and claude-scholar
 * check-refs. Detects orphan citations, duplicate keys, missing identifiers,
 * and verifies DOIs / arXiv IDs against academic indexes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { triangulateDoi, type TriangulationResult } from './CitationTriangulator.js';
import { resolveArxiv, type ArxivMetadata } from './ArxivResolver.js';

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
  raw: string;
}

export interface BibEntryAudit {
  key: string;
  type: string;
  title: string;
  authors: string;
  year: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  cited: boolean;
  status: 'verified' | 'not_found' | 'missing_id' | 'error';
  indexResult?: TriangulationResult | ArxivMetadata;
  issues: string[];
}

export interface BibTeXAuditResult {
  summary: {
    entryCount: number;
    citedCount: number;
    orphanBibEntries: number;
    orphanCitations: number;
    duplicateKeys: number;
    duplicateDois: number;
    missingIdentifierCount: number;
    verifiedCount: number;
    notFoundCount: number;
    errorCount: number;
  };
  entries: BibEntryAudit[];
  orphanBibEntries: string[];
  orphanCitations: string[];
  duplicateKeys: string[];
  duplicateDois: string[];
  recommendations: string[];
}

function normalizeDoi(value: string): string | undefined {
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  const match = cleaned.match(/^(?:https?:\/\/doi\.org\/)?(10\.\d{4,}\/.+)$/i);
  return match?.[1] ?? undefined;
}

function extractArxivId(entry: BibEntry): string | undefined {
  const eprint = entry.fields.eprint?.trim();
  if (eprint) {
    const prefix = entry.fields.archiveprefix?.toLowerCase() ?? '';
    if (prefix === 'arxiv' || /^\d{4}\.\d{4,}/.test(eprint) || /arxiv\.org/.test(entry.fields.url ?? '')) {
      return eprint;
    }
  }
  const url = entry.fields.url?.trim() ?? '';
  const match = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,}v?\d*)/i);
  return match?.[1];
}

/**
 * Parse a BibTeX string into structured entries.
 *
 * Handles nested braces in field values.
 */
export function parseBibTeX(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let i = 0;

  while (i < text.length) {
    const atPos = text.indexOf('@', i);
    if (atPos === -1) break;

    // Find entry type
    const bracePos = text.indexOf('{', atPos);
    if (bracePos === -1) break;

    const type = text.slice(atPos + 1, bracePos).trim().toLowerCase();
    if (!type || type.startsWith('comment') || type.startsWith('string') || type.startsWith('preamble')) {
      // Skip non-entry blocks by finding the matching brace
      i = skipBlock(text, bracePos);
      continue;
    }

    // Find key (between { and first comma)
    const firstComma = text.indexOf(',', bracePos);
    if (firstComma === -1) {
      i = bracePos + 1;
      continue;
    }

    const key = text.slice(bracePos + 1, firstComma).trim();

    // Extract body until matching closing brace
    const bodyStart = firstComma + 1;
    const { end: bodyEnd, body } = extractBalancedBody(text, bodyStart);
    if (body === null) {
      i = bodyStart;
      continue;
    }

    const fields = parseFields(body);
    entries.push({ key, type, fields, raw: text.slice(atPos, bodyEnd + 1) });
    i = bodyEnd + 1;
  }

  return entries;
}

function skipBlock(text: string, startBrace: number): number {
  let depth = 1;
  let i = startBrace + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return i;
}

function extractBalancedBody(text: string, start: number): { end: number; body: string | null } {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return { end: i, body: null };
  // i now points one past the closing brace
  return { end: i - 1, body: text.slice(start, i - 1) };
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;

  while (i < body.length) {
    // Skip whitespace and commas
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    if (i >= body.length) break;

    // Read field name
    const nameStart = i;
    while (i < body.length && /[a-zA-Z0-9_\-:]/.test(body[i]!)) i++;
    const name = body.slice(nameStart, i).trim().toLowerCase();
    if (!name) break;

    // Skip whitespace and equals
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length || body[i] !== '=') break;
    i++;
    while (i < body.length && /\s/.test(body[i]!)) i++;

    // Read value
    let value: string;
    if (i >= body.length) break;

    if (body[i] === '{') {
      const { end, body: inner } = extractBalancedBody(body, i + 1);
      if (inner === null) break;
      value = inner;
      i = end + 1;
    } else if (body[i] === '"') {
      i++;
      const quoteEnd = body.indexOf('"', i);
      if (quoteEnd === -1) break;
      value = body.slice(i, quoteEnd);
      i = quoteEnd + 1;
    } else {
      const tokenEnd = body.indexOf(',', i);
      value = tokenEnd === -1 ? body.slice(i).trim() : body.slice(i, tokenEnd).trim();
      i = tokenEnd === -1 ? body.length : tokenEnd;
    }

    fields[name] = collapseWhitespace(value);

    // Skip trailing whitespace and optional comma
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i < body.length && body[i] === ',') i++;
  }

  return fields;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Scan LaTeX files in a directory and return all citation keys used.
 */
export async function scanLaTeXCitations(texDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const files = await fs.readdir(texDir, { recursive: true });
  const texFiles = files.filter((f) => f.toLowerCase().endsWith('.tex'));

  const citeRegex = /\\(?:cite[pt]?|citeauthor|citeyear|parencite|textcite|footcite|autocite|citealp|citealt)\*?\s*(?:\[[^\]]*\])?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

  for (const rel of texFiles) {
    const filePath = path.join(texDir, rel);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = citeRegex.exec(content)) !== null) {
        const keyList = match[1] ?? '';
        for (const key of keyList.split(',')) {
          const trimmed = key.trim();
          if (trimmed) keys.add(trimmed);
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return keys;
}

/**
 * Audit a BibTeX collection against optional LaTeX citation usage.
 */
export async function auditBibTeX(options: {
  bibtex?: string;
  filePath?: string;
  texDir?: string;
}): Promise<BibTeXAuditResult> {
  const source = options.bibtex ?? (options.filePath ? await fs.readFile(options.filePath, 'utf-8') : '');
  if (!source.trim()) {
    return emptyResult('No BibTeX content provided.');
  }

  const entries = parseBibTeX(source);
  const usedKeys = options.texDir ? await scanLaTeXCitations(options.texDir) : new Set<string>();

  const keyCounts = new Map<string, number>();
  const doiCounts = new Map<string, number>();
  const doiToKeys = new Map<string, string[]>();

  for (const entry of entries) {
    keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
    const doi = normalizeDoi(entry.fields.doi ?? '');
    if (doi) {
      doiCounts.set(doi, (doiCounts.get(doi) ?? 0) + 1);
      if (!doiToKeys.has(doi)) doiToKeys.set(doi, []);
      doiToKeys.get(doi)!.push(entry.key);
    }
  }

  const duplicateKeys = [...keyCounts.entries()].filter(([, count]) => count > 1).map(([k]) => k);
  const duplicateDois = [...doiCounts.entries()].filter(([, count]) => count > 1).map(([d]) => d);

  const orphanBibEntries = entries.filter((e) => usedKeys.size > 0 && !usedKeys.has(e.key)).map((e) => e.key);
  const orphanCitations = [...usedKeys].filter((k) => !entries.some((e) => e.key === k));

  const entryAudits: BibEntryAudit[] = [];

  for (const entry of entries) {
    const doi = normalizeDoi(entry.fields.doi ?? '');
    const arxivId = extractArxivId(entry);
    const url = entry.fields.url?.trim() || undefined;

    const audit: BibEntryAudit = {
      key: entry.key,
      type: entry.type,
      title: entry.fields.title ?? '',
      authors: entry.fields.author ?? '',
      year: entry.fields.year ?? '',
      doi,
      arxivId,
      url,
      cited: usedKeys.size === 0 || usedKeys.has(entry.key),
      status: 'missing_id',
      issues: [],
    };

    if (duplicateKeys.includes(entry.key)) {
      audit.issues.push(`Duplicate citation key: ${entry.key}`);
    }
    if (doi && duplicateDois.includes(doi)) {
      audit.issues.push(`Duplicate DOI shared with ${doiToKeys.get(doi)?.filter((k) => k !== entry.key).join(', ') ?? 'other entries'}`);
    }
    if (!doi && !arxivId && !url) {
      audit.issues.push('Missing DOI, arXiv ID, or URL');
    }
    if (!audit.cited) {
      audit.issues.push('Not cited in LaTeX source');
    }

    try {
      if (doi) {
        const result = await triangulateDoi(doi);
        audit.indexResult = result;
        if (result.overall === 'VERIFIED') {
          audit.status = 'verified';
        } else if (result.overall === 'NOT_FOUND') {
          audit.status = 'not_found';
          audit.issues.push(`DOI not found in indexes (${result.missingIn.join(', ')})`);
        } else {
          audit.status = 'error';
          audit.issues.push(`Triangulation status: ${result.overall}`);
        }
      } else if (arxivId) {
        const result = await resolveArxiv(arxivId);
        audit.indexResult = result ?? undefined;
        if (result) {
          audit.status = 'verified';
        } else {
          audit.status = 'not_found';
          audit.issues.push('arXiv ID could not be resolved');
        }
      }
    } catch (err) {
      audit.status = 'error';
      audit.issues.push(`Verification error: ${err instanceof Error ? err.message : String(err)}`);
    }

    entryAudits.push(audit);
  }

  const missingIdentifierCount = entryAudits.filter((e) => e.status === 'missing_id' && !e.issues.includes('Not cited in LaTeX source')).length;
  const verifiedCount = entryAudits.filter((e) => e.status === 'verified').length;
  const notFoundCount = entryAudits.filter((e) => e.status === 'not_found').length;
  const errorCount = entryAudits.filter((e) => e.status === 'error').length;
  const citedCount = entryAudits.filter((e) => e.cited).length;

  const recommendations: string[] = [];
  if (orphanCitations.length > 0) recommendations.push(`${orphanCitations.length} 个正文引用在 .bib 中找不到对应条目，请补充或删除。`);
  if (orphanBibEntries.length > 0) recommendations.push(`${orphanBibEntries.length} 个 .bib 条目在正文中未被引用，可考虑清理。`);
  if (duplicateKeys.length > 0) recommendations.push(`存在重复 citation key：${duplicateKeys.join(', ')}，请去重。`);
  if (duplicateDois.length > 0) recommendations.push(`存在重复 DOI，请合并对应条目。`);
  if (missingIdentifierCount > 0) recommendations.push(`${missingIdentifierCount} 个条目缺少 DOI/arXiv/URL，建议补足以通过索引验证。`);
  if (notFoundCount > 0) recommendations.push(`${notFoundCount} 个引用在索引中未找到，请核实是否虚构或拼写错误。`);

  return {
    summary: {
      entryCount: entries.length,
      citedCount,
      orphanBibEntries: orphanBibEntries.length,
      orphanCitations: orphanCitations.length,
      duplicateKeys: duplicateKeys.length,
      duplicateDois: duplicateDois.length,
      missingIdentifierCount,
      verifiedCount,
      notFoundCount,
      errorCount,
    },
    entries: entryAudits,
    orphanBibEntries,
    orphanCitations,
    duplicateKeys,
    duplicateDois,
    recommendations,
  };
}

function emptyResult(reason: string): BibTeXAuditResult {
  return {
    summary: {
      entryCount: 0,
      citedCount: 0,
      orphanBibEntries: 0,
      orphanCitations: 0,
      duplicateKeys: 0,
      duplicateDois: 0,
      missingIdentifierCount: 0,
      verifiedCount: 0,
      notFoundCount: 0,
      errorCount: 0,
    },
    entries: [],
    orphanBibEntries: [],
    orphanCitations: [],
    duplicateKeys: [],
    duplicateDois: [],
    recommendations: [reason],
  };
}

export function auditResultToPlain(result: BibTeXAuditResult): Record<string, unknown> {
  return {
    summary: result.summary,
    entries: result.entries.map((e) => ({
      key: e.key,
      type: e.type,
      title: e.title,
      authors: e.authors,
      year: e.year,
      doi: e.doi,
      arxivId: e.arxivId,
      url: e.url,
      cited: e.cited,
      status: e.status,
      issues: e.issues,
      indexResult: e.indexResult,
    })),
    orphanBibEntries: result.orphanBibEntries,
    orphanCitations: result.orphanCitations,
    duplicateKeys: result.duplicateKeys,
    duplicateDois: result.duplicateDois,
    recommendations: result.recommendations,
  };
}
