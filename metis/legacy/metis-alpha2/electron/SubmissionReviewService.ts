/**
 * SubmissionReviewService — Decision Letter 拆解与返修工作台服务（P4）。
 *
 * 解析原则：编辑信原文逐字保留；切分是确定性的（Reviewer 标题行正则），
 * 判定与截止日期只采信可解释的关键词/日期命中，判不了就如实返回 unclear/null。
 * LLM 仅在规则切分失败时作辅助，且其输出必须能在原文中逐字定位，否则丢弃。
 */
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ProviderProfileBinding } from '../engine/runtime/ProviderProfileContract.js';
import type {
  DecisionParseResult,
  ReviewRound,
  ReviewerComment,
  SubmissionReviewDecision,
} from '../engine/submission/SubmissionReviewContract.js';
import type { SubmissionRepository } from './SubmissionRepository.js';
import type { SubmissionReviewRepository } from './SubmissionReviewRepository.js';
import type { OutcomeRepository } from './OutcomeRepository.js';

const REVIEWER_HEADING = /(?:^|\n)\s*(?:reviewer\s*#?\s*(\d+)|审稿人\s*([一二三四五六七八九十\d]+)|referee\s*#?\s*(\d+))\s*[:：.]?\s*(?=\S)/giu;

const DECISION_KEYWORDS: Array<{ decision: SubmissionReviewDecision; patterns: RegExp[]; label: string }> = [
  { decision: 'accept', label: '接受', patterns: [/\baccepted (?:for publication|in its current form|with minor)\b/iu, /decision[:：]\s*accept\b/iu, /录用/u] },
  { decision: 'minor_revision', label: '小修', patterns: [/\bminor (?:revision|revisions|changes)\b/iu, /小修/u] },
  { decision: 'major_revision', label: '大修', patterns: [/\bmajor (?:revision|revisions|changes)\b/iu, /\brevise and resubmit\b/iu, /大修/u, /退修/u] },
  { decision: 'reject', label: '拒稿', patterns: [/\breject(?:ed|ion)?\b/iu, /不宜刊用/u] },
  { decision: 'resubmit', label: '重投', patterns: [/\bresubmi(?:ssion|t)\b/iu, /重投/u] },
];

/** 常见英文长日期（20 November 2026 / November 20, 2026）与数字日期（2026-11-20）。 */
const DEADLINE_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/giu, hint: 'day-month-year' },
  { pattern: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/giu, hint: 'month-day-year' },
  { pattern: /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/giu, hint: 'iso' },
];
const MONTHS: Record<string, number> = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
const REVISE_CONTEXT = /(?:revision|resubmi\w+|deadline|by\s*$)|返修|修改.{0,6}(?:前|之内)|重新提交/giu;

function parseDeadline(text: string): { deadline: number | null; evidence: string } {
  for (const { pattern } of DEADLINE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const windowStart = Math.max(0, match.index - 120);
      const context = text.slice(windowStart, match.index + match[0].length + 40);
      if (!REVISE_CONTEXT.test(context)) { REVISE_CONTEXT.lastIndex = 0; continue; }
      REVISE_CONTEXT.lastIndex = 0;
      const hint = DEADLINE_PATTERNS.find((entry) => entry.pattern.source === pattern.source)?.hint ?? '';
      let year: number; let month: number; let day: number;
      if (hint === 'day-month-year') {
        day = Number(match[1]); month = MONTHS[match[2]!.toLowerCase()]!; year = Number(match[3]);
      } else if (hint === 'month-day-year') {
        month = MONTHS[match[1]!.toLowerCase()]!; day = Number(match[2]); year = Number(match[3]);
      } else {
        year = Number(match[1]); month = Number(match[2]) - 1; day = Number(match[3]);
      }
      const date = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(date.getTime())) return { deadline: date.getTime(), evidence: match[0] };
    }
  }
  return { deadline: null, evidence: '' };
}

export class SubmissionReviewService {
  constructor(private readonly options: {
    submissionRepository: SubmissionRepository;
    reviewRepository: SubmissionReviewRepository;
    outcomeRepository: OutcomeRepository;
    agentLoop?: AgentLoop | null;
    providerProfileBinding?: ProviderProfileBinding;
  }) {}

  /** 确定性解析：按 Reviewer 标题行切段；判定与截止日期仅采信关键词命中。 */
  parseDecisionLetter(text: string): DecisionParseResult {
    const trimmed = text.trim();
    const sections: Array<{ reviewerLabel: string; text: string }> = [];
    const headings: Array<{ index: number; length: number; label: string }> = [];
    REVIEWER_HEADING.lastIndex = 0;
    let heading: RegExpExecArray | null;
    while ((heading = REVIEWER_HEADING.exec(trimmed)) !== null) {
      const raw = heading[0].trim();
      headings.push({ index: heading.index, length: heading[0].length, label: raw.replace(/[:：.]\s*$/u, '').slice(0, 60) });
    }
    for (let i = 0; i < headings.length; i += 1) {
      const start = headings[i]!.index + headings[i]!.length;
      const end = i + 1 < headings.length ? headings[i + 1]!.index : trimmed.length;
      const body = trimmed.slice(start, end).trim();
      if (body) sections.push({ reviewerLabel: headings[i]!.label, text: body });
    }

    let decision: SubmissionReviewDecision = 'unclear';
    let decisionEvidence = '';
    for (const entry of DECISION_KEYWORDS) {
      const hit = entry.patterns.find((pattern) => pattern.test(trimmed));
      if (hit) { decision = entry.decision; decisionEvidence = `命中「${entry.label}」表述`; break; }
    }
    const { deadline, evidence: deadlineEvidence } = parseDeadline(trimmed);

    // 编辑意见 = 未落入任何 Reviewer 段落的正文头部（含决定说明等上下文）。
    const editorText = headings.length > 0 ? trimmed.slice(0, headings[0]!.index).trim() : '';
    const editorComments = editorText ? [{ reviewerLabel: 'Editor', text: editorText }] : [];

    return {
      decision,
      decisionEvidence,
      deadline,
      deadlineEvidence,
      editorComments,
      reviewerComments: sections,
      method: 'deterministic',
    };
  }

  /**
   * 从 Decision Letter 全文创建审稿轮次：原文保存 → 解析 → 意见落库。
   * case 状态推进到 REVISION_REQUIRED 由调用方显式触发（本方法不改状态机）。
   */
  createRoundFromLetter(input: {
    projectId: string; caseId: string; decisionLetterText: string;
    receivedAt?: number; deadline?: number | null;
  }): { ok: true; roundId: string; parsed: DecisionParseResult } | { ok: false; code: 'case_not_found' | 'empty_letter' } {
    if (!input.decisionLetterText.trim()) return { ok: false, code: 'empty_letter' };
    const parsed = this.parseDecisionLetter(input.decisionLetterText);
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return { ok: false, code: 'case_not_found' };
    const round = this.options.reviewRepository.createRound({
      projectId: input.projectId,
      caseId: input.caseId,
      decisionLetterText: input.decisionLetterText,
      decision: parsed.decision === 'unclear' && parsed.reviewerComments.length > 0 ? 'major_revision' : parsed.decision,
      receivedAt: input.receivedAt,
      deadline: input.deadline ?? parsed.deadline,
      comments: [...parsed.editorComments, ...parsed.reviewerComments].map((section) => ({
        reviewerLabel: section.reviewerLabel,
        originalText: section.text,
        category: section.reviewerLabel.toLowerCase().startsWith('editor') || section.reviewerLabel.includes('Editor') ? ('editorial' as const) : undefined,
      })),
      submittedOutcomeVersion: submissionCase.submittedOutcomeVersion ?? submissionCase.workingOutcomeVersion ?? submissionCase.sourceOutcomeVersion ?? null,
    });
    this.options.submissionRepository.addEvent(input.projectId, {
      caseId: input.caseId, type: 'decision_received', source: 'human', actor: 'review-parser',
      description: `Decision Letter 已拆解：${parsed.decision}${parsed.deadline ? `，返修截止 ${new Date(parsed.deadline).toISOString().slice(0, 10)}` : ''}；共 ${parsed.editorComments.length + parsed.reviewerComments.length} 条意见。`,
      metadata: { roundId: round.id, decision: round.decision, deadline: round.deadline },
    });
    return { ok: true, roundId: round.id, parsed };
  }

  listRounds(projectId: string, caseId: string): Array<ReviewRound & { comments: ReviewerComment[] }> {
    return this.options.reviewRepository.listRounds(projectId, caseId).map((round) => ({
      ...round,
      comments: this.options.reviewRepository.listComments(round.id),
    }));
  }

  /**
   * 汇总生成 Response to Reviewers：逐条意见 → 回复文本（含修改位置与前后文摘要），
   * 保存为可编辑成果。未处理完的意见会以「待回复」占位——绝不假装已完成。
   */
  async generateResponseLetter(input: { projectId: string; caseId: string }): Promise<
    { ok: true; outcomeId: string; version: number; unresolvedCount: number } | { ok: false; code: 'case_not_found' | 'no_rounds' | 'outcome_failed' }
  > {
    const rounds = this.listRounds(input.projectId, input.caseId);
    if (rounds.length === 0) return { ok: false, code: 'no_rounds' };
    const latest = rounds[0]!;
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return { ok: false, code: 'case_not_found' };

    const lines: string[] = [`Response to Reviewers`, '', `Manuscript: ${submissionCase.title}`, `Journal: ${submissionCase.targetJournalName || '[待确认：目标期刊]'}`, ''];
    let unresolved = 0;
    for (const comment of latest.comments) {
      lines.push(`--- ${comment.reviewerLabel || 'Reviewer'} ---`);
      lines.push(`Comment: ${comment.originalText}`);
      if (comment.responseText.trim()) {
        lines.push(`Response: ${comment.responseText}`);
        if (comment.affectedLocation.trim()) lines.push(`Location: ${comment.affectedLocation}`);
        if (comment.beforeText.trim()) lines.push(`Before: ${comment.beforeText}`);
        if (comment.afterText.trim()) lines.push(`After: ${comment.afterText}`);
      } else {
        unresolved += 1;
        lines.push('Response: [待回复：该意见尚未给出回应]');
      }
      lines.push('');
    }

    const existing = this.options.outcomeRepository.list(input.projectId, '')
      .find((outcome) => outcome.title.startsWith(`Response to Reviewers｜`));
    const content = buildPlainTextOutcome(lines.join('\n'));
    try {
      if (existing) {
        const detail = this.options.outcomeRepository.get(input.projectId, existing.id);
        const saved = this.options.outcomeRepository.save({
          projectId: input.projectId, outcomeId: existing.id, baseVersion: detail!.outcome.currentVersion,
          content, note: 'Response to Reviewers 更新（AI 汇总）', actor: 'ai',
          sources: [{ kind: 'outcome_version', id: submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId ?? existing.id, version: detail!.version.version, label: `${submissionCase.title}` }],
        });
        this.options.reviewRepository.setRoundResponseLetter(latest.id, saved.outcome.id);
        return { ok: true, outcomeId: saved.outcome.id, version: saved.version.version, unresolvedCount: unresolved };
      }
      const created = this.options.outcomeRepository.create({
        projectId: input.projectId, categoryId: null, title: `Response to Reviewers｜${submissionCase.targetJournalName || '未命名期刊'}`,
        kind: 'word', content, note: 'Response to Reviewers 草稿（AI 汇总自审稿意见）', actor: 'ai',
      });
      this.options.reviewRepository.setRoundResponseLetter(latest.id, created.outcome.id);
      return { ok: true, outcomeId: created.outcome.id, version: created.version.version, unresolvedCount: unresolved };
    } catch {
      return { ok: false, code: 'outcome_failed' };
    }
  }

  /** 开始返修：case 显式进入 REVISING（状态机校验由仓储负责）。 */
  async beginRevision(input: { projectId: string; caseId: string; roundId?: string }): Promise<{ ok: true } | { ok: false; code: string }> {
    const round = input.roundId
      ? this.options.reviewRepository.getRound(input.roundId)
      : this.options.reviewRepository.latestRound(input.projectId, input.caseId);
    if (!round) return { ok: false, code: 'round_not_found' };
    const changed = this.options.submissionRepository.changeStatus(input.projectId, {
      caseId: input.caseId, to: 'REVISING', reason: '开始处理审稿意见', source: 'human', actor: 'human',
    });
    if (!changed) return { ok: false, code: 'illegal_transition' };
    return { ok: true };
  }
}

// OutcomeDocument（Word）纯文本文档构造，结构与 WordDocumentSchema 对齐。
interface WordBlock { id: string; kind: 'paragraph' | 'heading'; text: string; level?: number }
function buildPlainTextOutcome(text: string): { type: 'word'; blocks: WordBlock[]; page: Record<string, unknown>; header: string; footer: string } {
  let counter = 0;
  const nextId = (): string => `oid-review-${Date.now().toString(36)}-${counter += 1}`;
  return {
    type: 'word',
    blocks: text.split('\n').filter((line) => line.trim().length > 0).map((line, index) => ({
      id: nextId(),
      kind: index === 0 ? ('heading' as const) : ('paragraph' as const),
      text: line,
      ...(index === 0 ? { level: 1 } : {}),
    })),
    page: {},
    header: '',
    footer: '',
  };
}
