/**
 * Review persistence store — durable cross-session review records.
 *
 * Saves structured paper reviews to disk so that a new chat session can recall
 * what was reviewed, when, and what the verdict was. Inspired by the
 * `.review/YYYY-MM-DD-<scope>.md` pattern in andrehuang/academic-writing-agents.
 *
 * Each review is written twice:
 *   - `<dataDir>/reviews/<date>-<scope>-<id>.md`  (human-readable)
 *   - `<dataDir>/reviews/index.json`               (machine-readable index)
 *
 * Added round 305.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ReviewRecord {
  id: string;
  scope: string;          // e.g. paper title, section name, or "full-paper"
  reviewerId?: string;    // persona/agent that produced the review
  overallScore?: number;  // 1-10
  confidence?: number;    // 1-5
  summary?: string;
  strengths?: string[];
  weaknesses?: string[];
  questions?: string[];
  recommendations?: string[];
  // Free-form extras kept verbatim so callers can round-trip any review shape.
  extras?: Record<string, unknown>;
  createdAt: number;
}

export interface ReviewIndexEntry {
  id: string;
  scope: string;
  reviewerId?: string;
  overallScore?: number;
  createdAt: number;
  filename: string;
}

export interface ReviewIndex {
  version: number;
  updatedAt: number;
  reviews: ReviewIndexEntry[];
}

const INDEX_VERSION = 1;

function getDataDir(): string {
  if (process.env.METIS_DATA_DIR) return process.env.METIS_DATA_DIR;
  try {
    return path.join(process.cwd(), '.metis-data');
  } catch {
    return path.join(os.tmpdir(), 'metis-data');
  }
}

function getReviewDir(): string {
  return path.join(getDataDir(), 'reviews');
}

async function ensureReviewDir(): Promise<void> {
  await fs.mkdir(getReviewDir(), { recursive: true });
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dateStamp(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeScope(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'review';
}

function emptyIndex(): ReviewIndex {
  return { version: INDEX_VERSION, updatedAt: Date.now(), reviews: [] };
}

async function loadIndex(): Promise<ReviewIndex> {
  try {
    await ensureReviewDir();
    const raw = await fs.readFile(path.join(getReviewDir(), 'index.json'), 'utf-8');
    const parsed = JSON.parse(raw) as ReviewIndex;
    if (!parsed || !Array.isArray(parsed.reviews)) return emptyIndex();
    return { ...emptyIndex(), ...parsed, reviews: parsed.reviews };
  } catch {
    return emptyIndex();
  }
}

async function saveIndex(index: ReviewIndex): Promise<void> {
  await ensureReviewDir();
  index.updatedAt = Date.now();
  await fs.writeFile(
    path.join(getReviewDir(), 'index.json'),
    JSON.stringify(index, null, 2),
    'utf-8',
  );
}

function renderMarkdown(record: ReviewRecord): string {
  const lines: string[] = [];
  lines.push(`# Review — ${record.scope}`, '');
  lines.push(`- **ID**: ${record.id}`);
  lines.push(`- **Date**: ${dateStamp(record.createdAt)}`);
  if (record.reviewerId) lines.push(`- **Reviewer**: ${record.reviewerId}`);
  if (typeof record.overallScore === 'number') lines.push(`- **Overall score**: ${record.overallScore} / 10`);
  if (typeof record.confidence === 'number') lines.push(`- **Confidence**: ${record.confidence} / 5`);
  lines.push('');
  if (record.summary) {
    lines.push('## Summary', '', record.summary, '');
  }
  if (record.strengths && record.strengths.length > 0) {
    lines.push('## Strengths', '');
    for (const s of record.strengths) lines.push(`- ${s}`);
    lines.push('');
  }
  if (record.weaknesses && record.weaknesses.length > 0) {
    lines.push('## Weaknesses', '');
    for (const w of record.weaknesses) lines.push(`- ${w}`);
    lines.push('');
  }
  if (record.questions && record.questions.length > 0) {
    lines.push('## Questions', '');
    for (const q of record.questions) lines.push(`- ${q}`);
    lines.push('');
  }
  if (record.recommendations && record.recommendations.length > 0) {
    lines.push('## Recommendations', '');
    for (const r of record.recommendations) lines.push(`- ${r}`);
    lines.push('');
  }
  if (record.extras && Object.keys(record.extras).length > 0) {
    lines.push('## Extras', '', '```json', JSON.stringify(record.extras, null, 2), '```', '');
  }
  return lines.join('\n');
}

/**
 * Persist a review record to disk.
 * Returns the saved record (with generated id and createdAt).
 */
export async function saveReview(
  input: Omit<ReviewRecord, 'id' | 'createdAt'>,
): Promise<ReviewRecord> {
  await ensureReviewDir();
  const now = Date.now();
  const record: ReviewRecord = {
    ...input,
    id: generateId(),
    createdAt: now,
  };

  const filename = `${dateStamp(now)}-${sanitizeScope(record.scope)}-${record.id}.md`;
  await fs.writeFile(path.join(getReviewDir(), filename), renderMarkdown(record), 'utf-8');

  const index = await loadIndex();
  const entry: ReviewIndexEntry = {
    id: record.id,
    scope: record.scope,
    reviewerId: record.reviewerId,
    overallScore: record.overallScore,
    createdAt: record.createdAt,
    filename,
  };
  index.reviews.unshift(entry);
  await saveIndex(index);

  return record;
}

/**
 * List saved reviews, most recent first.
 * Optional filters: scope substring, reviewerId.
 */
export async function listReviews(options: {
  scopeContains?: string;
  reviewerId?: string;
  limit?: number;
} = {}): Promise<ReviewIndexEntry[]> {
  const index = await loadIndex();
  let reviews = index.reviews;
  if (options.scopeContains) {
    const needle = options.scopeContains.toLowerCase();
    reviews = reviews.filter((r) => r.scope.toLowerCase().includes(needle));
  }
  if (options.reviewerId) {
    reviews = reviews.filter((r) => r.reviewerId === options.reviewerId);
  }
  const limit = options.limit ?? 50;
  return reviews.slice(0, Math.max(1, Math.min(limit, 500)));
}

/**
 * Read the markdown content of a saved review by id.
 * Returns null if not found.
 */
export async function getReviewMarkdown(id: string): Promise<string | null> {
  const index = await loadIndex();
  const entry = index.reviews.find((r) => r.id === id);
  if (!entry) return null;
  try {
    return await fs.readFile(path.join(getReviewDir(), entry.filename), 'utf-8');
  } catch {
    return null;
  }
}
