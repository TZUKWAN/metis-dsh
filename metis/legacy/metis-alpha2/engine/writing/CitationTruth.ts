import { z } from 'zod';
import { AcademicCitationStyleSchema, type AcademicCitationStyle } from './DeliverableProfile.js';

export const CitationAstKindSchema = z.enum(['author_year', 'numeric', 'latex', 'bibtex', 'doi']);

export const CitationAstNodeSchema = z.strictObject({
  kind: CitationAstKindSchema,
  raw: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  keys: z.array(z.string().min(1)).default([]),
  authors: z.array(z.string().min(1)).optional(),
  year: z.number().int().min(1000).max(2999).optional(),
  doi: z.string().min(1).optional(),
});

export type CitationAstNode = z.infer<typeof CitationAstNodeSchema>;

export const CitationTruthAttestationSchema = z.strictObject({
  sourceId: z.string().min(1),
  citationKeys: z.array(z.string().min(1)).min(1),
  identifierType: z.enum(['doi', 'arxiv', 'isbn', 'url', 'other']),
  identifier: z.string().min(1),
  locator: z.string().min(1),
  triangulation: z.enum(['VERIFIED', 'INCONSISTENT', 'NOT_FOUND', 'PARTIAL']),
  passport: z.enum(['verified', 'stale', 'missing']),
  retraction: z.enum(['clear', 'retracted', 'expression_of_concern', 'unknown']),
  journalIntegrity: z.enum(['trusted', 'warning', 'blocked', 'unknown']),
  checkedAt: z.number().int().positive(),
});

export type CitationTruthAttestation = z.infer<typeof CitationTruthAttestationSchema>;

export interface CitationSourceIdentity {
  id: string;
  projectId: string;
  identifierType: CitationTruthAttestation['identifierType'];
  identifier: string;
  deletedAt: number | null;
}

function normalizeSourceIdentifier(type: CitationTruthAttestation['identifierType'], value: string): string {
  const trimmed = value.trim();
  if (type === 'doi') {
    return trimmed.replace(/^https?:\/\/doi\.org\//iu, '').replace(/^doi:\s*/iu, '').toLowerCase();
  }
  if (type === 'arxiv') {
    return trimmed.replace(/^arxiv:\s*/iu, '').replace(/v\d+$/iu, '').toLowerCase();
  }
  if (type === 'isbn') return trimmed.replace(/[^0-9Xx]/gu, '').toUpperCase();
  if (type === 'url') {
    try {
      const url = new URL(trimmed);
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }
  return trimmed.toLowerCase();
}

export function citationAttestationMatchesSource(
  attestation: CitationTruthAttestation,
  source: CitationSourceIdentity,
): boolean {
  const sourceIdentifier = normalizeSourceIdentifier(source.identifierType, source.identifier);
  return source.deletedAt === null
    && source.id === attestation.sourceId
    && source.identifierType === attestation.identifierType
    && sourceIdentifier !== ''
    && sourceIdentifier === normalizeSourceIdentifier(attestation.identifierType, attestation.identifier);
}

function collectMatches(
  text: string,
  regex: RegExp,
  build: (match: RegExpExecArray) => Omit<CitationAstNode, 'raw' | 'start' | 'end'>,
): CitationAstNode[] {
  const nodes: CitationAstNode[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const raw = match[0];
    nodes.push(CitationAstNodeSchema.parse({
      ...build(match),
      raw,
      start: match.index,
      end: match.index + raw.length,
    }));
    if (raw.length === 0) regex.lastIndex += 1;
  }
  regex.lastIndex = 0;
  return nodes;
}

function normalizedKey(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/** Parse citation-bearing syntax into bounded, position-preserving nodes. */
export function parseCitationAst(text: string): CitationAstNode[] {
  const nodes: CitationAstNode[] = [];
  nodes.push(...collectMatches(
    text,
    /\\(?:cite|citep|citet|autocite|parencite|textcite)\*?(?:\[[^\]]*\]){0,2}\{([^{}]+)\}/giu,
    (match) => ({ kind: 'latex', keys: (match[1] ?? '').split(',').map(normalizedKey).filter(Boolean) }),
  ));
  nodes.push(...collectMatches(
    text,
    /@(article|book|inproceedings|incollection|phdthesis|mastersthesis|techreport|misc)\s*\{\s*([^,\s]+)[\s\S]*?\n?\}/giu,
    (match) => ({ kind: 'bibtex', keys: match[2] ? [normalizedKey(match[2])] : [] }),
  ));
  nodes.push(...collectMatches(
    text,
    /(?<![A-Z0-9])(?:https?:\/\/doi\.org\/|doi\s*:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]*[A-Z0-9])(?=[\s\]}),.;:]|$)/giu,
    (match) => ({ kind: 'doi', keys: [String(match[1]).toLowerCase()], doi: String(match[1]).toLowerCase() }),
  ));
  nodes.push(...collectMatches(
    text,
    /[（(]([^()（）\n]{1,160}?)[,，]\s*((?:19|20)\d{2}[a-z]?)[)）]/giu,
    (match) => ({
      kind: 'author_year',
      keys: [`${normalizedKey(match[1] ?? '')}, ${match[2] ?? ''}`],
      authors: (match[1] ?? '').split(/\s*(?:&|and|与|和)\s*/iu).map(normalizedKey).filter(Boolean),
      year: Number.parseInt(match[2] ?? '', 10),
    }),
  ));
  nodes.push(...collectMatches(
    text,
    /(?<![\p{L}\p{N}])([\p{L}][\p{L}'’-]{0,79})\s*[（(]\s*((?:19|20)\d{2}[a-z]?)\s*[)）]/giu,
    (match) => ({
      kind: 'author_year',
      keys: [`${normalizedKey(match[1] ?? '')}, ${match[2] ?? ''}`],
      authors: match[1] ? [normalizedKey(match[1])] : [],
      year: Number.parseInt(match[2] ?? '', 10),
    }),
  ));
  nodes.push(...collectMatches(
    text,
    /[［[]((?:\d+\s*(?:[-–,，]\s*\d+)*))[\]］]/gu,
    (match) => ({
      kind: 'numeric',
      keys: (match[1] ?? '').split(/\s*[,，]\s*/u).flatMap((part) => {
        const range = part.match(/^(\d+)\s*[-–]\s*(\d+)$/u);
        if (!range) return [part.trim()];
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end < start || end - start > 100) return [part.trim()];
        return Array.from({ length: end - start + 1 }, (_, index) => String(start + index));
      }).filter(Boolean),
    }),
  ));
  return nodes.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function isTrustedCitationAttestation(
  value: unknown,
  options: { now?: number; maxAgeMs?: number } = {},
): { ok: boolean; reasons: string[] } {
  const parsed = CitationTruthAttestationSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reasons: ['invalid_attestation'] };
  const attestation = parsed.data;
  const reasons: string[] = [];
  if (attestation.triangulation !== 'VERIFIED') reasons.push('triangulation_not_verified');
  if (attestation.passport !== 'verified') reasons.push('passport_not_verified');
  if (attestation.retraction !== 'clear') reasons.push('retraction_not_clear');
  if (attestation.journalIntegrity !== 'trusted') reasons.push('journal_integrity_not_trusted');
  if (!attestation.locator.trim()) reasons.push('locator_missing');
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  if (attestation.checkedAt > now + 60_000 || now - attestation.checkedAt > maxAgeMs) reasons.push('attestation_stale');
  return { ok: reasons.length === 0, reasons };
}

export interface CitationAuthor {
  family: string;
  given: string;
}

export interface AcademicCitationInput {
  authors: CitationAuthor[];
  year: number;
  title: string;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  type: 'journal_article' | 'book' | 'chapter' | 'thesis' | 'report' | 'web';
}

function initialParts(given: string): string[] {
  return given
    .replace(/[.]/gu, ' ')
    .split(/[\s-]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase());
}

function enDashPages(pages?: string): string | undefined {
  return pages?.replace(/\s*-\s*/gu, '–');
}

function hyphenPages(pages?: string): string | undefined {
  return pages?.replace(/\s*[–-]\s*/gu, '-');
}

function normalizeDoi(doi?: string): string | undefined {
  return doi?.trim().replace(/^https?:\/\/doi\.org\//iu, '').replace(/^doi:\s*/iu, '');
}

function sentence(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
}

export function formatAcademicCitation(
  input: AcademicCitationInput,
  style: AcademicCitationStyle,
): string {
  AcademicCitationStyleSchema.parse(style);
  const doi = normalizeDoi(input.doi);
  const pagesDash = enDashPages(input.pages);
  const pagesHyphen = hyphenPages(input.pages);
  if (style === 'apa') {
    const authors = input.authors.map((author) => `${author.family}, ${initialParts(author.given).map((initial) => `${initial}.`).join(' ')}`);
    const authorText = authors.length <= 1 ? (authors[0] ?? 'Unknown') : `${authors.slice(0, -1).join(', ')}, & ${authors.at(-1)}`;
    const journal = input.containerTitle
      ? `${input.containerTitle}${input.volume ? `, ${input.volume}${input.issue ? `(${input.issue})` : ''}` : ''}${pagesDash ? `, ${pagesDash}` : ''}.`
      : input.publisher ? `${input.publisher}.` : '';
    return sentence([`${authorText} (${input.year}).`, `${input.title}.`, journal, doi ? `https://doi.org/${doi}` : input.url]);
  }
  if (style === 'chicago') {
    const [first, ...rest] = input.authors;
    const authorText = first
      ? [`${first.family}, ${first.given}`, ...rest.map((author) => `${author.given} ${author.family}`)].join(rest.length ? ', and ' : '')
      : 'Unknown';
    const journal = input.containerTitle
      ? `${input.containerTitle}${input.volume ? ` ${input.volume}` : ''}${input.issue ? `, no. ${input.issue}` : ''} (${input.year})${pagesDash ? `: ${pagesDash}` : ''}.`
      : `${input.publisher ?? ''} (${input.year}).`;
    return sentence([`${authorText}.`, `“${input.title}.”`, journal, doi ? `https://doi.org/${doi}.` : input.url ? `${input.url}.` : undefined]);
  }
  if (style === 'ieee') {
    const authors = input.authors.map((author) => `${initialParts(author.given).map((initial) => `${initial}.`).join(' ')} ${author.family}`.trim());
    const authorText = authors.length <= 1 ? (authors[0] ?? 'Unknown') : `${authors.slice(0, -1).join(', ')} and ${authors.at(-1)}`;
    const details = [
      input.containerTitle,
      input.volume ? `vol. ${input.volume}` : undefined,
      input.issue ? `no. ${input.issue}` : undefined,
      pagesDash ? `pp. ${pagesDash}` : undefined,
      String(input.year),
      doi ? `doi: ${doi}` : undefined,
    ].filter(Boolean).join(', ');
    return `${authorText}, “${input.title},” ${details}.`;
  }
  if (style === 'vancouver') {
    const authors = input.authors.map((author) => `${author.family} ${initialParts(author.given).join('')}`);
    const details = `${input.year}${input.volume ? `;${input.volume}${input.issue ? `(${input.issue})` : ''}` : ''}${pagesHyphen ? `:${pagesHyphen}` : ''}.`;
    return sentence([`${authors.join(', ')}.`, `${input.title}.`, input.containerTitle ? `${input.containerTitle}.` : undefined, details, doi ? `doi:${doi}.` : input.url]);
  }
  const authors = input.authors.map((author) => `${author.family.toUpperCase()} ${initialParts(author.given).join(' ')}`);
  const typeCode = input.type === 'journal_article' ? 'J' : input.type === 'book' ? 'M' : input.type === 'thesis' ? 'D' : input.type === 'report' ? 'R' : input.type === 'chapter' ? 'A' : 'EB/OL';
  const publication = input.containerTitle
    ? `${input.containerTitle}, ${input.year}${input.volume ? `, ${input.volume}${input.issue ? `(${input.issue})` : ''}` : ''}${pagesHyphen ? `: ${pagesHyphen}` : ''}.`
    : `${input.publisher ?? ''}, ${input.year}.`;
  return sentence([`${authors.join(', ')}.`, `${input.title}[${typeCode}].`, publication, doi ? `DOI:${doi}.` : input.url]);
}
