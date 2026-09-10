/**
 * Findings Log — durable, append-only log of research findings.
 *
 * The research equivalent of a lab notebook: each finding is a concise factual
 * statement the agent discovered, with optional tags, confidence, and a source
 * pointer (claim id, paper id, review id). Findings persist across sessions so
 * an autonomous research loop can accumulate knowledge instead of forgetting.
 *
 * Storage:
 *   - <workspace>/findings.md          (human-readable, append-only)
 *   - <dataDir>/findings-index.json    (machine-readable index)
 *
 * Inspired by Orchestra-Research/AI-Research-SKILLs' findings.md persistent
 * memory and the workspace layout from WenyuChiou/ai-research-skills.
 *
 * Added round 311.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type FindingConfidence = 'low' | 'medium' | 'high';

export interface Finding {
  id: string;
  text: string;
  tags: string[];
  confidence: FindingConfidence;
  source?: string;        // claim id / paper id / review id / "manual"
  createdAt: number;
}

export interface FindingsIndex {
  version: number;
  updatedAt: number;
  findings: Finding[];
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

function getIndexPath(): string {
  return path.join(getDataDir(), 'findings-index.json');
}

function getMarkdownPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'findings.md');
}

function generateId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function emptyIndex(): FindingsIndex {
  return { version: INDEX_VERSION, updatedAt: Date.now(), findings: [] };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true });
}

/**
 * Load the findings index. Returns an empty index if none exists or malformed.
 */
export async function loadFindingsIndex(): Promise<FindingsIndex> {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(getIndexPath(), 'utf-8');
    const parsed = JSON.parse(raw) as FindingsIndex;
    if (!parsed || !Array.isArray(parsed.findings)) return emptyIndex();
    return { ...emptyIndex(), ...parsed, findings: parsed.findings };
  } catch {
    return emptyIndex();
  }
}

async function saveFindingsIndex(index: FindingsIndex): Promise<void> {
  await ensureDataDir();
  index.updatedAt = Date.now();
  await fs.writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

function renderFindingMarkdown(f: Finding): string {
  const date = new Date(f.createdAt).toISOString().slice(0, 10);
  const tags = f.tags.length > 0 ? ` [${f.tags.join(', ')}]` : '';
  const conf = ` (confidence: ${f.confidence})`;
  const src = f.source ? ` — source: ${f.source}` : '';
  return `- **[${date}]** ${f.text}${tags}${conf}${src}`;
}

/**
 * Append a finding to the log. Writes both the markdown file (in workspaceRoot,
 * if provided) and the JSON index (in the data dir).
 */
export async function addFinding(input: {
  text: string;
  tags?: string[];
  confidence?: FindingConfidence;
  source?: string;
  workspaceRoot?: string;
}): Promise<Finding> {
  const text = input.text.trim();
  if (!text) throw new Error('Finding text must not be empty.');

  const finding: Finding = {
    id: generateId(),
    text,
    tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    confidence: input.confidence ?? 'medium',
    source: input.source,
    createdAt: Date.now(),
  };

  const index = await loadFindingsIndex();
  index.findings.push(finding);
  await saveFindingsIndex(index);

  // Append to the human-readable markdown log if a workspace is given.
  if (input.workspaceRoot) {
    try {
      const mdPath = getMarkdownPath(input.workspaceRoot);
      await fs.mkdir(path.dirname(mdPath), { recursive: true });
      const header = fsSync.existsSync(mdPath) ? '' : '# Findings Log\n\n';
      await fs.appendFile(mdPath, `${header}${renderFindingMarkdown(finding)}\n`, 'utf-8');
    } catch {
      // Non-fatal: the index is the source of truth.
    }
  }

  return finding;
}

/**
 * List findings, most recent first, with optional filters.
 */
export async function listFindings(options: {
  tag?: string;
  contains?: string;
  confidence?: FindingConfidence;
  limit?: number;
} = {}): Promise<Finding[]> {
  const index = await loadFindingsIndex();
  let findings = [...index.findings].reverse(); // most recent first
  if (options.tag) {
    const needle = options.tag.toLowerCase();
    findings = findings.filter((f) => f.tags.includes(needle));
  }
  if (options.confidence) {
    findings = findings.filter((f) => f.confidence === options.confidence);
  }
  if (options.contains) {
    const needle = options.contains.toLowerCase();
    findings = findings.filter((f) => f.text.toLowerCase().includes(needle));
  }
  const limit = options.limit ?? 100;
  return findings.slice(0, Math.max(1, Math.min(limit, 1000)));
}

/**
 * Clear all findings (the markdown log is left untouched as a historical record).
 */
export async function clearFindings(): Promise<{ cleared: number }> {
  const index = await loadFindingsIndex();
  const cleared = index.findings.length;
  await saveFindingsIndex(emptyIndex());
  return { cleared };
}

export type FindingsExportFormat = 'markdown' | 'json' | 'csv';

/**
 * Export findings in a portable format.
 *   - markdown: a human-readable report (groups by tag, lists each finding)
 *   - json:     the raw findings array, pretty-printed
 *   - csv:      id,date,confidence,source,tags,text (RFC-4180 quoted)
 *
 * Optional filePath writes the export to disk and returns the path; otherwise
 * returns the content inline.
 *
 * Added round 314.
 */
export async function exportFindings(options: {
  format?: FindingsExportFormat;
  tag?: string;
  confidence?: FindingConfidence;
  contains?: string;
  filePath?: string;
} = {}): Promise<{ format: FindingsExportFormat; count: number; content: string; filePath?: string }> {
  const format: FindingsExportFormat = options.format === 'markdown' || options.format === 'json' || options.format === 'csv'
    ? options.format
    : 'markdown';

  const findings = await listFindings({
    tag: options.tag,
    confidence: options.confidence,
    contains: options.contains,
    limit: 1000,
  });

  let content: string;
  if (format === 'json') {
    content = JSON.stringify(findings, null, 2);
  } else if (format === 'csv') {
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const header = 'id,date,confidence,source,tags,text';
    const rows = findings.map((f) => {
      const date = new Date(f.createdAt).toISOString().slice(0, 10);
      return [f.id, date, f.confidence, f.source ?? '', f.tags.join(';'), f.text].map(esc).join(',');
    });
    content = [header, ...rows].join('\n');
  } else {
    // markdown
    const byTag = new Map<string, Finding[]>();
    for (const f of findings) {
      const key = f.tags.length > 0 ? f.tags[0]! : 'untagged';
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push(f);
    }
    const lines = [
      '# Findings Export',
      `${findings.length} finding(s) exported on ${new Date().toISOString().slice(0, 10)}.`,
      '',
    ];
    for (const [tag, items] of byTag) {
      lines.push(`## ${tag}`);
      for (const f of items) {
        const date = new Date(f.createdAt).toISOString().slice(0, 10);
        const src = f.source ? ` _(source: ${f.source})_` : '';
        lines.push(`- **[${date}]** (${f.confidence}) ${f.text}${src}`);
      }
      lines.push('');
    }
    content = lines.join('\n');
  }

  let writtenPath: string | undefined;
  if (options.filePath) {
    await fs.mkdir(path.dirname(options.filePath), { recursive: true });
    await fs.writeFile(options.filePath, content, 'utf-8');
    writtenPath = options.filePath;
  }

  return { format, count: findings.length, content, filePath: writtenPath };
}
