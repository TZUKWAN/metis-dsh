/**
 * Submission Gap Service — 投稿稿件诊断服务（学术投稿生命周期 P1）。
 *
 * 职责：对照目标期刊官方硬约束（journal_requirements，ruleType 固定
 * 'official_requirement'）与语料软范式（journal_pattern_observations），
 * 对投稿工作稿（无工作稿时回退源成果当前版本）做差距诊断，结果落库
 * submission_gap_items。
 *
 * 证据纪律（与 JournalProfileContract 一致）：
 *  - 确定性检查只针对有官方要求记录的规则生效，evidence 必须同时引用
 *    要求原文摘录与稿件实测数值；valueText 解析不出数值就跳过，禁止瞎猜；
 *  - 软范式只来自 evidenceLevel/sampleSize 足够的 pattern observations，
 *    evidence 必须写明样本量并声明其非官方硬性要求；严禁把范式写成官方要求；
 *  - LLM 语义对照为可选补充（注入 agentLoop 才启用），输出经 Zod 校验，
 *    且 LLM 不得伪造 published_pattern 证据（软范式只能来自语料观察）；
 *  - 去重只针对仍 open 的现存差距项（按规范化标题），planned/applied 等
 *    历史项不动；重复运行 diagnose 不会产生重复 open 项。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { OutcomeDocument, WordDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import {
  SUBMISSION_GAP_SEVERITIES,
  SUBMISSION_GAP_SOURCE_TYPES,
  SUBMISSION_IMPACT_LEVELS,
  type JournalPatternObservation,
  type JournalRequirement,
  type SubmissionGapItem,
  type SubmissionGapItemCreateInput,
} from '../engine/submission/JournalProfileContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import type { OutcomeRepository } from './OutcomeRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

// ─── 公共契约 ────────────────────────────────────────────────

export const SubmissionGapDiagnoseRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1),
});
export type SubmissionGapDiagnoseRequest = z.infer<typeof SubmissionGapDiagnoseRequestSchema>;

export type SubmissionGapErrorCode = 'invalid_request' | 'case_not_found' | 'manuscript_not_found';

export type SubmissionGapDiagnoseResult =
  | { ok: true; items: SubmissionGapItem[] }
  | { ok: false; code: SubmissionGapErrorCode };

export type SubmissionDeterministicCheckResult =
  | { ok: true; gaps: SubmissionGapItemCreateInput[]; facts: ManuscriptFacts }
  | { ok: false; code: SubmissionGapErrorCode };

/** 稿件结构实测事实（全部由确定性规则从文档中提取，无推测成分）。 */
export interface ManuscriptFacts {
  /** false = 文档类型不支持文本结构分析（如 ppt），所有内容类检查跳过。 */
  supported: boolean;
  /** 中英混排统计：汉字按字、英文/数字按词。 */
  wordCount: number;
  hasAbstract: boolean;
  /** null = 检测到摘要标志但无法切出摘要正文（长度检查跳过，禁止瞎猜）。 */
  abstractWordCount: number | null;
  /** null = 未检测到关键词。 */
  keywordCount: number | null;
  /** 去掉编号前缀的标题文本列表。 */
  headings: string[];
  referenceCount: number;
}

export interface SubmissionGapServiceOptions {
  submissionRepository: SubmissionRepository;
  journalRepository: JournalProfileRepository;
  outcomeRepository: OutcomeRepository;
  /** 可选 LLM 原语：注入后 diagnose 追加一轮「稿件 × 要求」语义对照。 */
  agentLoop?: Pick<AgentLoop, 'run'>;
}

/** 软范式观察进入诊断的最低证据门槛：至少读过摘要且样本量 >= 3。 */
const MIN_PATTERN_SAMPLE_SIZE = 3;

const LLM_GAP_LIST_SCHEMA = z.array(z.strictObject({
  severity: z.enum(SUBMISSION_GAP_SEVERITIES),
  title: z.string().min(1).max(500),
  problem: z.string().max(20000).default(''),
  evidence: z.string().max(20000).default(''),
  sourceType: z.enum(SUBMISSION_GAP_SOURCE_TYPES),
  affectedLocation: z.string().max(500).default(''),
  recommendedAction: z.string().max(20000).default(''),
  requiresResearcherJudgment: z.boolean().default(false),
  estimatedImpact: z.enum(SUBMISSION_IMPACT_LEVELS).default('medium'),
})).max(10);

// ─── 文本统计与结构提取（纯确定性） ──────────────────────────

const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/gu;

/** 中英混排字数统计：CJK 字符按字计，其余按空白切词（只计含字母/数字的词）。 */
export function countManuscriptWords(text: string): number {
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const latin = text
    .replace(CJK_PATTERN, ' ')
    .split(/\s+/u)
    .filter((token) => /[A-Za-z0-9]/u.test(token)).length;
  return cjk + latin;
}

/** 提取稿件纯文本（供 LLM 上下文 / beforeText-afterText 记录使用）。 */
export function extractManuscriptPlainText(document: OutcomeDocument): string {
  if (document.type === 'word') {
    return document.blocks
      .map((block) => block.text ?? (block.rows ? block.rows.map((row) => row.join(' ')).join(' ') : ''))
      .filter((text) => text.trim().length > 0)
      .join('\n');
  }
  if (document.type === 'other') return document.text;
  return '';
}

/** 去掉章节编号前缀（如 "1. Introduction" / "一、摘要" → 正文名）。 */
function stripNumbering(text: string): string {
  return text.replace(/^\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[.、\s]*/u, '').trim();
}

function blockText(block: WordDocument['blocks'][number]): string {
  return block.text ?? (block.rows ? block.rows.map((row) => row.join(' ')).join(' ') : '');
}

const KEYWORD_LINE = /^\s*(?:keywords?|key words|关键词|关键字)\s*[:：]?\s*/iu;

function splitKeywordList(text: string): number {
  return text.split(/[,;，；、|]/u).map((item) => item.trim()).filter((item) => item.length > 0).length;
}

function extractWordFacts(document: WordDocument): ManuscriptFacts {
  const blocks = document.blocks;
  const headings = blocks
    .filter((block) => block.kind === 'heading' && (block.text ?? '').trim().length > 0)
    .map((block) => stripNumbering(block.text ?? ''));
  const wordCount = countManuscriptWords(blocks.map(blockText).join('\n'));

  // 摘要：优先找 Abstract/摘要 标题，其后到下一个标题之间的正文为摘要；
  // 退路：以「摘要/Abstract」开头的段落整体视为摘要。
  let hasAbstract = false;
  let abstractWordCount: number | null = null;
  const abstractHeadingIndex = blocks.findIndex((block) => {
    if (block.kind !== 'heading') return false;
    const heading = stripNumbering(block.text ?? '').toLowerCase();
    return heading.startsWith('abstract') || heading.startsWith('摘要');
  });
  if (abstractHeadingIndex >= 0) {
    hasAbstract = true;
    const parts: string[] = [];
    for (let index = abstractHeadingIndex + 1; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.kind === 'heading') break;
      const text = blockText(block).trim();
      if (text && !KEYWORD_LINE.test(text)) parts.push(text);
    }
    abstractWordCount = countManuscriptWords(parts.join('\n'));
  } else {
    const inline = blocks.find((block) => block.kind !== 'heading' && /^\s*(?:abstract|摘要)\s*[:：]?\s*\S/iu.test(blockText(block)));
    if (inline) {
      hasAbstract = true;
      abstractWordCount = countManuscriptWords(blockText(inline));
    }
  }

  // 关键词：Keywords/关键词 行内列表，或该标题之后的第一个正文块。
  let keywordCount: number | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const text = blockText(block);
    if (!KEYWORD_LINE.test(text)) continue;
    const remainder = text.replace(KEYWORD_LINE, '').trim();
    if (remainder) {
      keywordCount = splitKeywordList(remainder);
    } else {
      const next = blocks.slice(index + 1).find((candidate) => candidate.kind !== 'heading' && blockText(candidate).trim().length > 0);
      keywordCount = next ? splitKeywordList(blockText(next).trim()) : 0;
    }
    break;
  }

  // 参考文献：References/参考文献 标题后的正文块计数；无该标题则按 [n] 编号行计数。
  let referenceCount = 0;
  const referenceHeadingIndex = blocks.findIndex((block) => {
    if (block.kind !== 'heading') return false;
    return /^(?:references|bibliography|参考文献|引用文献)$/u.test(stripNumbering(block.text ?? '').toLowerCase());
  });
  if (referenceHeadingIndex >= 0) {
    for (let index = referenceHeadingIndex + 1; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.kind === 'heading') break;
      if (blockText(block).trim().length > 0) referenceCount += 1;
    }
  } else {
    referenceCount = blocks.filter((block) => /^\s*\[\d+\]/u.test(blockText(block))).length;
  }

  return { supported: true, wordCount, hasAbstract, abstractWordCount, keywordCount, headings, referenceCount };
}

function extractFacts(document: OutcomeDocument): ManuscriptFacts {
  if (document.type === 'word') return extractWordFacts(document);
  if (document.type === 'other') {
    const text = document.text;
    const keywordMatch = KEYWORD_LINE.exec(text);
    return {
      supported: true,
      wordCount: countManuscriptWords(text),
      hasAbstract: /摘要|abstract/iu.test(text),
      abstractWordCount: null,
      keywordCount: keywordMatch ? splitKeywordList(text.slice(keywordMatch.index + keywordMatch[0].length).split('\n')[0] ?? '') : null,
      headings: [],
      referenceCount: (text.match(/^\s*\[\d+\]/gmu) ?? []).length,
    };
  }
  return { supported: false, wordCount: 0, hasAbstract: false, abstractWordCount: null, keywordCount: null, headings: [], referenceCount: 0 };
}

// ─── 要求数值解析（解析不出就返回 null，禁止瞎猜） ────────────

function toInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw.replace(/,/gu, ''), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 解析「不超过 N 词/字」类上限：优先取带单位词的数字；全文仅一个数字时才采纳。 */
function parseSingleLimit(valueText: string): number | null {
  const unitMatch = /(\d[\d,]*)\s*(?:词|字|单词|words?|characters?|chars?)/iu.exec(valueText);
  if (unitMatch) return toInt(unitMatch[1]);
  const all = valueText.match(/\d[\d,]*/gu) ?? [];
  return all.length === 1 ? toInt(all[0]) : null;
}

/** 解析关键词数量规则：范围（3-6）/ 至少 N / 不超过 N / 带单位的单个数字。 */
function parseKeywordRule(valueText: string): { min: number | null; max: number | null } | null {
  const range = /(\d[\d,]*)\s*[-–—~至到]\s*(\d[\d,]*)/u.exec(valueText);
  if (range) return { min: toInt(range[1]), max: toInt(range[2]) };
  const minMatch = /(?:至少|最少|不低于|at least|minimum(?: of)?)\s*(\d[\d,]*)/iu.exec(valueText);
  const maxMatch = /(?:不超过|至多|最多|up to|no more than|maximum(?: of)?)\s*(\d[\d,]*)/iu.exec(valueText);
  if (minMatch || maxMatch) {
    return { min: minMatch ? toInt(minMatch[1]) : null, max: maxMatch ? toInt(maxMatch[1]) : null };
  }
  const single = valueText.match(/\d[\d,]*/gu) ?? [];
  if (single.length === 1 && /(?:个|条|keywords?)/iu.test(valueText)) return { min: null, max: toInt(single[0]) };
  return null;
}

// ─── 差距候选生成 ────────────────────────────────────────────

function officialEvidence(requirement: JournalRequirement, actual: string): string {
  const source = requirement.sourceTitle || requirement.sourceUrl || '期刊官方投稿指南';
  const snippet = requirement.evidenceSnippet || requirement.valueText;
  return `官方要求（${source}）："${snippet}"；稿件实测：${actual}`;
}

/** 确定性差距检查：仅基于官方硬约束 + 稿件实测事实；解析不出数值的规则跳过。 */
export function computeDeterministicGaps(
  requirements: JournalRequirement[],
  facts: ManuscriptFacts,
): SubmissionGapItemCreateInput[] {
  if (!facts.supported) return [];
  const gaps: SubmissionGapItemCreateInput[] = [];
  const byRule = new Map(requirements.map((requirement) => [requirement.ruleKey, requirement]));

  const wordLimit = byRule.get('word_limit');
  if (wordLimit) {
    const limit = parseSingleLimit(wordLimit.valueText);
    if (limit !== null && facts.wordCount > limit) {
      gaps.push({
        severity: 'must_fix',
        sourceType: 'official_requirement',
        title: '全文篇幅超出期刊字数上限',
        problem: `稿件约 ${facts.wordCount} 词/字（汉字按字、英文按词统计），超出上限 ${limit}。`,
        evidence: officialEvidence(wordLimit, `全文约 ${facts.wordCount} 词/字`),
        affectedLocation: '全文',
        recommendedAction: `压缩全文至 ${limit} 词/字以内（当前约 ${facts.wordCount}）。`,
        estimatedImpact: 'high',
      });
    }
  }

  const abstractLimit = byRule.get('abstract_limit');
  if (abstractLimit) {
    if (!facts.hasAbstract) {
      gaps.push({
        severity: 'must_fix',
        sourceType: 'official_requirement',
        title: '缺少摘要（期刊对摘要有明确要求）',
        problem: '期刊官方要求包含摘要约束，但稿件中未检测到摘要部分。',
        evidence: officialEvidence(abstractLimit, '未检测到摘要'),
        affectedLocation: '摘要',
        recommendedAction: '在正文前补充摘要，并满足期刊摘要长度要求。',
        estimatedImpact: 'high',
      });
    } else if (facts.abstractWordCount !== null) {
      const limit = parseSingleLimit(abstractLimit.valueText);
      if (limit !== null && facts.abstractWordCount > limit) {
        gaps.push({
          severity: 'must_fix',
          sourceType: 'official_requirement',
          title: '摘要长度超出期刊上限',
          problem: `摘要约 ${facts.abstractWordCount} 词/字，超出上限 ${limit}。`,
          evidence: officialEvidence(abstractLimit, `摘要约 ${facts.abstractWordCount} 词/字`),
          affectedLocation: '摘要',
          recommendedAction: `压缩摘要至 ${limit} 词/字以内（当前约 ${facts.abstractWordCount}）。`,
          estimatedImpact: 'high',
        });
      }
    }
  }

  const keywords = byRule.get('keywords');
  if (keywords) {
    if (facts.keywordCount === null) {
      gaps.push({
        severity: 'must_fix',
        sourceType: 'official_requirement',
        title: '未检测到关键词',
        problem: '期刊官方要求包含关键词约束，但稿件中未检测到关键词列表。',
        evidence: officialEvidence(keywords, '未检测到关键词'),
        affectedLocation: '关键词',
        recommendedAction: '按期刊要求补充关键词列表。',
        estimatedImpact: 'medium',
      });
    } else {
      const rule = parseKeywordRule(keywords.valueText);
      const belowMin = rule?.min !== null && rule?.min !== undefined && facts.keywordCount < rule.min;
      const aboveMax = rule?.max !== null && rule?.max !== undefined && facts.keywordCount > rule.max;
      if (rule && (belowMin || aboveMax)) {
        const rangeText = [rule.min !== null ? `至少 ${rule.min}` : '', rule.max !== null ? `至多 ${rule.max}` : ''].filter(Boolean).join('，');
        gaps.push({
          severity: 'must_fix',
          sourceType: 'official_requirement',
          title: '关键词数量不符合期刊要求',
          problem: `稿件含 ${facts.keywordCount} 个关键词，期刊要求${rangeText}。`,
          evidence: officialEvidence(keywords, `关键词 ${facts.keywordCount} 个`),
          affectedLocation: '关键词',
          recommendedAction: `调整关键词数量至期刊要求范围（当前 ${facts.keywordCount} 个）。`,
          estimatedImpact: 'medium',
        });
      }
    }
  }

  const sectionStructure = byRule.get('section_structure');
  if (sectionStructure) {
    const names = sectionStructure.valueText
      .split(/[,;，；、\n]/u)
      .map((name) => stripNumbering(name))
      .filter((name) => name.length >= 2 && name.length <= 60);
    if (names.length > 0) {
      const headings = facts.headings.map((heading) => heading.toLowerCase());
      const missing = names.filter((name) => {
        const needle = name.toLowerCase();
        return !headings.some((heading) => heading.includes(needle) || needle.includes(heading));
      });
      if (missing.length > 0) {
        gaps.push({
          severity: 'must_fix',
          sourceType: 'official_requirement',
          title: '章节结构缺少期刊要求的部分',
          problem: `稿件缺少期刊要求的章节：${missing.join('、')}。`,
          evidence: officialEvidence(sectionStructure, `稿件章节：${facts.headings.join('、') || '（未检测到标题结构）'}`),
          affectedLocation: '章节结构',
          recommendedAction: `按期刊章节结构要求补充：${missing.join('、')}。`,
          estimatedImpact: 'high',
        });
      }
    }
  }

  const referenceStyle = byRule.get('reference_style');
  if (referenceStyle && facts.referenceCount === 0) {
    gaps.push({
      severity: 'must_fix',
      sourceType: 'official_requirement',
      title: '未检测到参考文献列表',
      problem: '期刊官方要求包含参考文献规范，但稿件中未检测到参考文献条目。',
      evidence: officialEvidence(referenceStyle, '参考文献条目数：0'),
      affectedLocation: '参考文献',
      recommendedAction: '补充参考文献列表并按期刊引用格式整理。',
      estimatedImpact: 'high',
    });
  }

  return gaps;
}

/** 软范式差距：只采纳证据等级/样本量足够的观察；严禁标成官方要求。 */
export function computePatternGaps(observations: JournalPatternObservation[]): SubmissionGapItemCreateInput[] {
  return observations
    .filter((observation) => observation.evidenceLevel !== 'metadata_only' && observation.sampleSize >= MIN_PATTERN_SAMPLE_SIZE)
    .map((observation) => ({
      severity: 'strongly_recommended' as const,
      sourceType: 'published_pattern' as const,
      title: `范式核对：${observation.patternKey}`,
      problem: observation.observation,
      evidence: `该刊近期 ${observation.sampleSize} 篇样本中观察到的已发表范式（证据等级：${observation.evidenceLevel}；此为语料归纳的软范式，非官方硬性要求）：${observation.observation}`,
      affectedLocation: observation.patternKey,
      recommendedAction: '请对照上述已发表范式检查稿件相应部分，必要时调整；此为软范式而非官方强制要求。',
      requiresResearcherJudgment: true,
      estimatedImpact: 'medium' as const,
    }));
}

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/gu, ' ');

function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

// ─── 服务 ────────────────────────────────────────────────────

export class SubmissionGapService {
  constructor(private readonly options: SubmissionGapServiceOptions) {}

  private loadContext(projectId: string, caseId: string):
    | { code: SubmissionGapErrorCode }
    | {
        facts: ManuscriptFacts;
        manuscriptText: string;
        requirements: JournalRequirement[];
        observations: JournalPatternObservation[];
      } {
    const submissionCase = this.options.submissionRepository.getCase(projectId, caseId);
    if (!submissionCase) return { code: 'case_not_found' };
    const outcomeId = submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId;
    const detail = outcomeId ? this.options.outcomeRepository.get(projectId, outcomeId) : undefined;
    if (!detail) return { code: 'manuscript_not_found' };
    let requirements: JournalRequirement[] = [];
    let observations: JournalPatternObservation[] = [];
    if (submissionCase.targetJournalId) {
      const snapshot = this.options.journalRepository.latestSnapshot(submissionCase.targetJournalId);
      if (snapshot) {
        requirements = this.options.journalRepository.listRequirements(snapshot.id);
        observations = this.options.journalRepository.listPatternObservations(snapshot.id);
      }
    }
    return {
      facts: extractFacts(detail.version.content),
      manuscriptText: extractManuscriptPlainText(detail.version.content),
      requirements,
      observations,
    };
  }

  /**
   * 只计算的确定性检查（不落库）：供 verifyPlan 复核 must_fix 是否真实消解。
   * 与 diagnose 共用同一套规则与事实提取，保证「诊断口径 = 复核口径」。
   */
  async runDeterministicChecks(rawInput: unknown): Promise<SubmissionDeterministicCheckResult> {
    const parsed = SubmissionGapDiagnoseRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const context = this.loadContext(parsed.data.projectId, parsed.data.caseId);
    if ('code' in context) return { ok: false, code: context.code };
    return { ok: true, gaps: computeDeterministicGaps(context.requirements, context.facts), facts: context.facts };
  }

  /**
   * 稿件诊断：确定性检查（无 LLM 可跑）→ 软范式核对 → 可选 LLM 语义对照 →
   * 与现存 open 项按标题去重 → 新增落库。返回该 case 当前全部 open 差距项。
   */
  async diagnose(rawInput: unknown): Promise<SubmissionGapDiagnoseResult> {
    const parsed = SubmissionGapDiagnoseRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, caseId } = parsed.data;
    const context = this.loadContext(projectId, caseId);
    if ('code' in context) return { ok: false, code: context.code };

    const candidates: SubmissionGapItemCreateInput[] = [
      ...computeDeterministicGaps(context.requirements, context.facts),
      ...computePatternGaps(context.observations),
      ...(await this.llmSupplement(projectId, context)),
    ];

    // 去重：只挡现存 open 项；planned/applied/dismissed/verified 的历史项不动。
    const seen = new Set(this.options.journalRepository.listGapItems(caseId, 'open').map((item) => normalizeTitle(item.title)));
    const fresh: SubmissionGapItemCreateInput[] = [];
    for (const candidate of candidates) {
      const key = normalizeTitle(candidate.title ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push(candidate);
    }
    if (fresh.length > 0) this.options.journalRepository.createGapItems(caseId, fresh);
    return { ok: true, items: this.options.journalRepository.listGapItems(caseId, 'open') };
  }

  /** 可选 LLM 语义对照；任何失败（模型不可用/输出不合契约）都静默降级为空。 */
  private async llmSupplement(
    projectId: string,
    context: { facts: ManuscriptFacts; manuscriptText: string; requirements: JournalRequirement[] },
  ): Promise<SubmissionGapItemCreateInput[]> {
    const agentLoop = this.options.agentLoop;
    if (!agentLoop || context.requirements.length === 0 || !context.facts.supported) return [];
    const requirementLines = context.requirements
      .map((requirement) => `- [${requirement.ruleKey}] ${requirement.valueText}（证据："${requirement.evidenceSnippet || '无摘录'}"）`)
      .join('\n');
    const prompt = [
      '你是学术投稿预审助手。下面给出一个目标期刊的官方投稿要求和一篇稿件的结构化事实。',
      '请只做语义层面的对照（确定性数值检查已由其他规则完成），找出稿件与官方要求之间尚未被发现的差距。',
      '只输出一个 JSON 数组（无 Markdown 围栏），每个元素形如：',
      '{"severity":"must_fix|strongly_recommended|optional","title":"...","problem":"...","evidence":"必须引用上方要求原文","sourceType":"official_requirement|manuscript","affectedLocation":"...","recommendedAction":"...","requiresResearcherJudgment":false,"estimatedImpact":"high|medium|low"}',
      '禁止输出 sourceType 为 published_pattern 的项（软范式只能来自语料观察）。没有新发现就输出 []。',
      '',
      '【官方要求】',
      requirementLines,
      '',
      '【稿件事实】',
      `总词/字数约 ${context.facts.wordCount}；摘要：${context.facts.hasAbstract ? `存在（约 ${context.facts.abstractWordCount ?? '?'} 词/字）` : '缺失'}；关键词：${context.facts.keywordCount ?? '未检测到'}；参考文献条目：${context.facts.referenceCount}。`,
      `章节标题：${context.facts.headings.join('、') || '（无）'}`,
      '',
      '【稿件正文（可能截断）】',
      context.manuscriptText.slice(0, 20000),
    ].join('\n');
    try {
      const response = await runEphemeralChatTurn({
        agentLoop,
        sessionId: `submission-gap-${randomUUID()}`,
        requestId: `submission-gap-${randomUUID()}`,
        messages: [{ role: 'user', content: prompt }],
        maxTurns: 1,
        allowedTools: [],
        projectId,
      });
      if (response.status !== 'completed' || !response.answer.trim()) return [];
      const parsedLlm = LLM_GAP_LIST_SCHEMA.safeParse(parseJsonLoose(response.answer));
      if (!parsedLlm.success) return [];
      // LLM 不得伪造语料样本证据：published_pattern 一律丢弃。
      return parsedLlm.data.filter((gap) => gap.sourceType !== 'published_pattern');
    } catch {
      return [];
    }
  }
}
