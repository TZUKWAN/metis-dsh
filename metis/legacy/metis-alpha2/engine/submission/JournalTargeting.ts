/**
 * JournalTargeting — 选刊匹配引擎（纯领域逻辑，可单测）。
 *
 * 数据来源与诚实边界：
 *  - 候选期刊来自「主题相关近期论文」的发表期刊聚合（OpenAlex / NCPSSD 检索结果），
 *    属于可追溯的事实：该刊近期确实发表过这些主题相近的论文；
 *  - 索引层级标注只使用本地白名单（CoreJournalLists + 用户自定义 ISSN）：
 *    SCI/SSCI 按 ISSN 核验；CSSCI/北大核心/CSCD 白名单暂未细分，统一标注
 *    「中文核心（白名单）」并如实说明；会议与普刊层级无法自动核验，标 unknown；
 *  - 不产生影响因子、录用率、审稿周期、版面费等无来源数字。
 */
import { isChineseCoreJournal, isSciSsciIssn, normalizeJournalName } from '../literature/CoreJournalLists.js';
import type { TargetingCriteria } from './SubmissionRuntimeContract.js';

export interface MatchInputPaper {
  title: string;
  year: number;
  venue: string;
  doi?: string;
  issn?: string;
  source: string;
}

export interface JournalCandidate {
  name: string;
  issn: string | null;
  /** 白名单核验通过的索引层级（可核验的事实）。 */
  verifiedTiers: string[];
  /** 层级核验状态：verified=白名单命中；unknown=无自动判据（需人工核验）。 */
  tierStatus: 'verified' | 'unknown';
  /** 近三年主题相关论文数（共现证据强度）。 */
  recentPaperCount: number;
  latestYear: number;
  /** 共现证据样例（最多 3 条）。 */
  evidence: Array<{ title: string; year: number; doi?: string; source: string }>;
  /** 是否满足用户前置条件：true/false/unknown（无自动判据）。 */
  meetsCriteria: boolean | null;
  criteriaNote: string;
  /** 排序分：近期共现数为主。 */
  score: number;
}

const CHINESE_CORE_LABEL = '中文核心（白名单：CSSCI/北大核心/CSCD 未细分）';
const SCI_SSCI_LABEL = 'SCI/SSCI（ISSN 白名单）';

/** 按用户前置条件判断候选是否达标。 */
function evaluateCriteria(
  candidate: { verifiedTiers: string[]; tierStatus: 'verified' | 'unknown'; name: string },
  criteria: TargetingCriteria,
): { meets: boolean | null; note: string } {
  const categories = criteria.categories;
  const hasChineseCore = categories.some((c) => c === 'cssci' || c === 'cscd' || c === 'pku_core');
  const hasSciSsci = categories.some((c) => c === 'sci' || c === 'ssci');
  const wantsConference = categories.includes('conference');
  const wantsCnGeneral = categories.includes('cn_general');
  const wantsEnGeneral = categories.includes('en_general');

  if (hasSciSsci && candidate.verifiedTiers.includes(SCI_SSCI_LABEL)) {
    return { meets: true, note: 'ISSN 命中 SCI/SSCI 白名单' };
  }
  if (hasChineseCore && isChineseCoreJournal(candidate.name)) {
    return { meets: true, note: `刊名命中${CHINESE_CORE_LABEL}` };
  }
  // 仅要求会议/普刊时：无自动判据，如实标注 unknown。
  if ((wantsConference || wantsCnGeneral || wantsEnGeneral) && !hasSciSsci && !hasChineseCore) {
    const label = wantsConference ? '会议' : wantsCnGeneral ? '中文普刊' : '英文普刊';
    return { meets: null, note: `${label}层级暂无自动核验依据，需人工确认` };
  }
  // 核心类条件未命中白名单：明确不满足（不冒充核心）。
  if (hasSciSsci || hasChineseCore) {
    return { meets: false, note: '未命中索引白名单（或白名单未收录该刊）' };
  }
  return { meets: null, note: '无自动核验依据' };
}

export function aggregateVenueCandidates(input: {
  papers: MatchInputPaper[];
  criteria: TargetingCriteria;
  currentYear?: number;
  limit?: number;
}): JournalCandidate[] {
  const currentYear = input.currentYear ?? new Date().getFullYear();
  const byVenue = new Map<string, {
    name: string; issn: string | null; papers: MatchInputPaper[];
  }>();
  for (const paper of input.papers) {
    const name = paper.venue.trim();
    if (!name) continue;
    const key = normalizeJournalName(name) || name.toLowerCase();
    const entry = byVenue.get(key) ?? { name, issn: paper.issn ?? null, papers: [] };
    if (!entry.issn && paper.issn) entry.issn = paper.issn;
    entry.papers.push(paper);
    byVenue.set(key, entry);
  }

  const candidates: JournalCandidate[] = [];
  for (const entry of byVenue.values()) {
    const recent = entry.papers.filter((paper) => currentYear - paper.year <= 3 && paper.year > 0);
    if (recent.length === 0) continue;
    const verifiedTiers: string[] = [];
    if (entry.issn && isSciSsciIssn(entry.issn)) verifiedTiers.push(SCI_SSCI_LABEL);
    if (isChineseCoreJournal(entry.name)) verifiedTiers.push(CHINESE_CORE_LABEL);
    const tierStatus: 'verified' | 'unknown' = verifiedTiers.length > 0 ? 'verified' : 'unknown';
    const probe = { verifiedTiers, tierStatus, name: entry.name };
    const verdict = evaluateCriteria(probe, input.criteria);
    const sorted = [...recent].sort((a, b) => b.year - a.year);
    candidates.push({
      name: entry.name,
      issn: entry.issn,
      verifiedTiers,
      tierStatus,
      recentPaperCount: recent.length,
      latestYear: sorted[0]!.year,
      evidence: sorted.slice(0, 3).map((paper) => ({ title: paper.title, year: paper.year, doi: paper.doi, source: paper.source })),
      meetsCriteria: verdict.meets,
      criteriaNote: verdict.note,
      score: recent.length * 10 + Math.max(0, sorted[0]!.year - (currentYear - 3)),
    });
  }
  // 满足条件的排前 → 共现数降序 → 名称稳定序。
  candidates.sort((a, b) => {
    const rank = (value: boolean | null) => (value === true ? 0 : value === null ? 1 : 2);
    return rank(a.meetsCriteria) - rank(b.meetsCriteria)
      || b.recentPaperCount - a.recentPaperCount
      || a.name.localeCompare(b.name);
  });
  return candidates.slice(0, input.limit ?? 20);
}

/** 由稿件标题构造检索词（截断到检索友好长度）。 */
export function buildMatchQuery(title: string, extraKeywords: string[] = []): string {
  return [title, ...extraKeywords].filter(Boolean).join(' ').slice(0, 180);
}
