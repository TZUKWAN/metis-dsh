/**
 * Artifact review status + version diff (METIS-607 / METIS-604).
 *
 * METIS-607: compute an artifact's review status from its evidence: source deleted → stale;
 * data updated → stale; checks failed → partial; all-pass + has sources → verified. A user
 * must never mistake an unverified AI output for a reliable conclusion.
 * METIS-604: text/spec/data diff between versions, with rollback (never overwrites original).
 */

import { canBeVerified, type ArtifactManifest, type ArtifactReviewStatus } from './ArtifactManifest.js';

export interface ReviewCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ReviewResult {
  status: ArtifactReviewStatus;
  checks: ReviewCheck[];
  blockingIssues: string[];
}

/**
 * Compute the review status from checks + provenance signals (METIS-607).
 *   - anySourceDeleted OR inputStale => 'stale'
 *   - any check failed with a blocking issue => 'partial'
 *   - all checks passed AND has cited sources => 'verified'
 *   - newly created, not yet checked => 'pending'
 *   - otherwise => 'draft'
 */
export function computeReviewStatus(
  manifest: ArtifactManifest,
  checks: ReviewCheck[],
  signals: { anySourceDeleted: boolean; inputStale: boolean },
  authority: { receiptVerified?: boolean; profileEnforced?: boolean } = {},
): ReviewResult {
  const blockingIssues: string[] = [];
  for (const c of checks) {
    if (!c.passed) blockingIssues.push(`${c.name}: ${c.detail}`);
  }

  let status: ArtifactReviewStatus;
  if (signals.anySourceDeleted || signals.inputStale) {
    status = 'stale';
    if (signals.anySourceDeleted) blockingIssues.push('至少一个被引用的来源已被删除');
    if (signals.inputStale) blockingIssues.push('输入数据已更新，成果可能过期');
  } else if (blockingIssues.length > 0) {
    status = 'partial';
  } else if (canBeVerified(manifest, authority).ok && checks.length > 0 && checks.every((c) => c.passed)) {
    status = 'verified';
  } else if (checks.length === 0) {
    status = 'pending';
  } else {
    status = 'draft';
  }

  return { status, checks, blockingIssues };
}

/** Whether an artifact may be presented to the user as a reliable conclusion. */
export function isReliable(result: ReviewResult): boolean {
  return result.status === 'verified';
}

// ─── Version diff (METIS-604) ─────────────────────────────────

export interface DiffResult {
  kind: 'text' | 'spec' | 'data' | 'identical';
  added: number;
  removed: number;
  /** Human-readable summary. */
  summary: string;
}

/** Diff two artifact versions. Never overwrites either — diff is read-only. */
export function diffVersions(oldContent: string, newContent: string, artifactType: string): DiffResult {
  if (oldContent === newContent) return { kind: 'identical', added: 0, removed: 0, summary: '无变化' };

  // Line-based diff for text/markdown/manuscript/report.
  if (['manuscript', 'report'].includes(artifactType)) {
    const oldLines = new Set(oldContent.split('\n'));
    const newLines = new Set(newContent.split('\n'));
    let added = 0; let removed = 0;
    for (const l of newLines) if (!oldLines.has(l)) added++;
    for (const l of oldLines) if (!newLines.has(l)) removed++;
    return { kind: 'text', added, removed, summary: `新增 ${added} 行，删除 ${removed} 行` };
  }

  // Spec / data: try JSON structural diff (count changed keys).
  try {
    const oldJson = JSON.parse(oldContent) as Record<string, unknown>;
    const newJson = JSON.parse(newContent) as Record<string, unknown>;
    const oldKeys = new Set(Object.keys(oldJson));
    const newKeys = new Set(Object.keys(newJson));
    let added = 0; let removed = 0;
    for (const k of newKeys) if (!oldKeys.has(k)) added++;
    for (const k of oldKeys) if (!newKeys.has(k)) removed++;
    return { kind: artifactType === 'chart' ? 'spec' : 'data', added, removed, summary: `结构变更：+${added} / -${removed} 字段` };
  } catch {
    // not JSON — fall back to char-level
    return { kind: 'text', added: Math.max(0, newContent.length - oldContent.length), removed: Math.max(0, oldContent.length - newContent.length), summary: `长度变化 ${oldContent.length} → ${newContent.length}` };
  }
}
