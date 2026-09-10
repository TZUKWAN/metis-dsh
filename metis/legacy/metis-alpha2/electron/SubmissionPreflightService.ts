/**
 * Submission Preflight Service — 投稿预检服务（学术投稿生命周期 P2）。
 *
 * 职责：对投稿工作稿（无工作稿时回退源成果当前版本）做一轮全确定性预检，
 * 对照目标期刊最新快照的官方硬约束（journal_requirements），结果落库
 * submission_preflight_runs / submission_preflight_checks，并追加
 * submission_events（type 'preflight_run'）。
 *
 * 证据纪律（与 SubmissionGapService 一致）：
 *  - 只有官方要求存在且能解析出数值的规则才给 pass/block；解析不了 → warn
 *    「无法自动核验」；无快照/无该规则记录 → warn「未抓取官方要求」，
 *    严禁凭空编造通过；
 *  - blind_* 依赖研究者身份信息比对：当前仓库无用户名片/机构设置可复用，
 *    期刊要求盲审时一律 warn「需要研究者确认」，绝不假装已核验；
 *  - file_* 只读该 case 最新投稿包的文件清单，不臆造材料存在；
 *  - passed = block 数为 0（warn 不阻断，但必须呈现给研究者确认）。
 */
import type { OutcomeDocument, WordDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import type { JournalRequirement, JournalRequirementRuleKey } from '../engine/submission/JournalProfileContract.js';
import {
  SubmissionPreflightRunRequestSchema,
  type SubmissionPreflightCheck,
  type SubmissionPreflightCheckCreateInput,
  type SubmissionPreflightRun,
} from '../engine/submission/SubmissionPackageContract.js';
import {
  countManuscriptWords,
  extractManuscriptPlainText,
  type ManuscriptFacts,
} from './SubmissionGapService.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import type { OutcomeRepository } from './OutcomeRepository.js';
import type { SubmissionPackageRepository } from './SubmissionPackageRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

export type SubmissionPreflightErrorCode = 'invalid_request' | 'case_not_found' | 'manuscript_not_found';

export type SubmissionPreflightResult =
  | { ok: true; run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] }
  | { ok: false; code: SubmissionPreflightErrorCode };

export interface SubmissionPreflightServiceOptions {
  submissionRepository: SubmissionRepository;
  journalRepository: JournalProfileRepository;
  outcomeRepository: OutcomeRepository;
  packageRepository: SubmissionPackageRepository;
}

const NO_REQUIREMENT = '未抓取官方要求（无期刊快照或该规则无记录），无法自动核验，请研究者确认';

// ─── 稿件事实提取（确定性；与 SubmissionGapService 同口径） ────

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

/** 统计稿件中的表格数（word 块含 rows 即表格）。 */
function countTables(document: OutcomeDocument): number {
  if (document.type !== 'word') return 0;
  return document.blocks.filter((block) => block.rows && block.rows.length > 0).length;
}

// ─── 要求数值解析（解析不出返回 null，禁止瞎猜） ───────────────

function toInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw.replace(/,/gu, ''), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseSingleLimit(valueText: string): number | null {
  const unitMatch = /(\d[\d,]*)\s*(?:词|字|单词|个|words?|characters?|chars?)/iu.exec(valueText);
  if (unitMatch) return toInt(unitMatch[1]);
  const all = valueText.match(/\d[\d,]*/gu) ?? [];
  return all.length === 1 ? toInt(all[0]) : null;
}

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

function requirementText(requirement: JournalRequirement): string {
  return requirement.evidenceSnippet || requirement.valueText;
}

// ─── 声明段落关键词（全文检索，确定性） ────────────────────────

const STATEMENT_PATTERNS = {
  funding: /funding|financ|基金|资助|grant[s]?\s+(?:number|no\.)|supported by/iu,
  coi: /conflicts? of interest|competing interests?|利益冲突|利益关系/iu,
  ethics: /ethic|伦理|知情同意|informed consent|IRB/iu,
  dataAvailability: /data availab|数据可用|数据获取|数据开放|availability of data/iu,
} as const;

const ACKNOWLEDGEMENT_PATTERN = /acknowledg|致谢|鸣谢/iu;
const AI_STATEMENT_PATTERN = /AI[- ]assist|artificial intelligence|generative AI|大语言模型|生成式\s?AI|AI\s?辅助|人工智能辅助|ChatGPT|large language model/iu;

// ─── 服务 ────────────────────────────────────────────────────

export class SubmissionPreflightService {
  constructor(private readonly options: SubmissionPreflightServiceOptions) {}

  /**
   * 运行一次投稿预检：取当前工作稿 → 提取稿件事实 → 对照最新期刊快照官方要求
   * 生成全部确定性检查 → run+checks 单事务落库 → 追加 preflight_run 事件。
   */
  async run(rawInput: unknown): Promise<SubmissionPreflightResult> {
    const parsed = SubmissionPreflightRunRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, caseId } = parsed.data;

    const submissionCase = this.options.submissionRepository.getCase(projectId, caseId);
    if (!submissionCase) return { ok: false, code: 'case_not_found' };
    const outcomeId = submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId;
    const detail = outcomeId ? this.options.outcomeRepository.get(projectId, outcomeId) : undefined;
    if (!outcomeId || !detail) return { ok: false, code: 'manuscript_not_found' };

    const document = detail.version.content;
    const facts = extractFacts(document);
    const manuscriptText = extractManuscriptPlainText(document);
    const outcomeVersion = detail.version.version;

    let requirements: JournalRequirement[] = [];
    if (submissionCase.targetJournalId) {
      const snapshot = this.options.journalRepository.latestSnapshot(submissionCase.targetJournalId);
      if (snapshot) requirements = this.options.journalRepository.listRequirements(snapshot.id);
    }
    const byRule = new Map(requirements.map((requirement) => [requirement.ruleKey, requirement]));

    const checks: SubmissionPreflightCheckCreateInput[] = [];
    const push = (check: SubmissionPreflightCheckCreateInput): void => { checks.push(check); };

    this.checkContentLimits(push, byRule, facts, document);
    this.checkBlindReview(push, byRule.get('blind_review'), manuscriptText);
    this.checkStatements(push, byRule, manuscriptText, facts);
    this.checkFiles(push, byRule, caseId, outcomeId, outcomeVersion);
    this.checkAiPolicy(push, byRule.get('ai_policy'), manuscriptText);

    const stored = this.options.packageRepository.savePreflightRun(caseId, outcomeId, outcomeVersion, checks);
    this.options.submissionRepository.addEvent(projectId, {
      caseId,
      type: 'preflight_run',
      source: 'system',
      description: stored.run.passed
        ? `投稿预检通过（${stored.run.warnCount} 项待确认）`
        : `投稿预检发现 ${stored.run.blockCount} 个阻断项、${stored.run.warnCount} 项待确认`,
      metadata: {
        runId: stored.run.id,
        passed: stored.run.passed,
        blockCount: stored.run.blockCount,
        warnCount: stored.run.warnCount,
        outcomeId,
        outcomeVersion,
      },
    });
    return { ok: true, run: stored.run, checks: stored.checks };
  }

  // ── 内容类检查（字数/摘要/关键词/章节/引用/图表） ─────────────

  private checkContentLimits(
    push: (check: SubmissionPreflightCheckCreateInput) => void,
    byRule: Map<JournalRequirementRuleKey, JournalRequirement>,
    facts: ManuscriptFacts,
    document: OutcomeDocument,
  ): void {
    if (!facts.supported) {
      const detail = '文档类型不支持文本结构分析，内容类检查无法自动核验，请研究者人工核对';
      push({ checkKey: 'word_count', label: '全文篇幅', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'abstract', label: '摘要', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'keywords', label: '关键词', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'section_structure', label: '章节结构', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'reference_style', label: '参考文献', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'figures_tables', label: '图表', level: 'warn', detail, source: 'deterministic' });
      return;
    }

    // word_count
    const wordLimit = byRule.get('word_limit');
    if (!wordLimit) {
      push({ checkKey: 'word_count', label: '全文篇幅', level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。当前全文约 ${facts.wordCount} 词/字` });
    } else {
      const limit = parseSingleLimit(wordLimit.valueText);
      if (limit === null) {
        push({ checkKey: 'word_count', label: '全文篇幅', level: 'warn', source: 'requirement', detail: `官方要求「${wordLimit.valueText}」无法解析出数值上限，无法自动核验。当前全文约 ${facts.wordCount} 词/字` });
      } else if (facts.wordCount > limit) {
        push({ checkKey: 'word_count', label: '全文篇幅', level: 'block', source: 'requirement', detail: `全文约 ${facts.wordCount} 词/字，超出官方上限 ${limit}（${requirementText(wordLimit)}）` });
      } else {
        push({ checkKey: 'word_count', label: '全文篇幅', level: 'pass', source: 'requirement', detail: `全文约 ${facts.wordCount} 词/字，未超出官方上限 ${limit}` });
      }
    }

    // abstract
    const abstractLimit = byRule.get('abstract_limit');
    if (!abstractLimit) {
      push({ checkKey: 'abstract', label: '摘要', level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。${facts.hasAbstract ? '已检测到摘要' : '未检测到摘要'}` });
    } else if (!facts.hasAbstract) {
      push({ checkKey: 'abstract', label: '摘要', level: 'block', source: 'requirement', detail: `官方对摘要有明确要求（${requirementText(abstractLimit)}），但稿件未检测到摘要` });
    } else {
      const limit = parseSingleLimit(abstractLimit.valueText);
      if (limit === null || facts.abstractWordCount === null) {
        push({ checkKey: 'abstract', label: '摘要', level: 'warn', source: 'requirement', detail: `已检测到摘要；官方要求「${abstractLimit.valueText}」无法解析出数值上限或摘要正文无法切分，无法自动核验` });
      } else if (facts.abstractWordCount > limit) {
        push({ checkKey: 'abstract', label: '摘要', level: 'block', source: 'requirement', detail: `摘要约 ${facts.abstractWordCount} 词/字，超出官方上限 ${limit}（${requirementText(abstractLimit)}）` });
      } else {
        push({ checkKey: 'abstract', label: '摘要', level: 'pass', source: 'requirement', detail: `摘要约 ${facts.abstractWordCount} 词/字，未超出官方上限 ${limit}` });
      }
    }

    // keywords
    const keywords = byRule.get('keywords');
    if (!keywords) {
      push({ checkKey: 'keywords', label: '关键词', level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。${facts.keywordCount === null ? '未检测到关键词' : `检测到 ${facts.keywordCount} 个关键词`}` });
    } else if (facts.keywordCount === null) {
      push({ checkKey: 'keywords', label: '关键词', level: 'block', source: 'requirement', detail: `官方对关键词有明确要求（${requirementText(keywords)}），但稿件未检测到关键词列表` });
    } else {
      const rule = parseKeywordRule(keywords.valueText);
      const belowMin = rule?.min !== null && rule?.min !== undefined && facts.keywordCount < rule.min;
      const aboveMax = rule?.max !== null && rule?.max !== undefined && facts.keywordCount > rule.max;
      if (!rule) {
        push({ checkKey: 'keywords', label: '关键词', level: 'warn', source: 'requirement', detail: `官方要求「${keywords.valueText}」无法解析出数量规则，无法自动核验。检测到 ${facts.keywordCount} 个关键词` });
      } else if (belowMin || aboveMax) {
        const rangeText = [rule.min !== null ? `至少 ${rule.min}` : '', rule.max !== null ? `至多 ${rule.max}` : ''].filter(Boolean).join('，');
        push({ checkKey: 'keywords', label: '关键词', level: 'block', source: 'requirement', detail: `关键词 ${facts.keywordCount} 个，不符合官方要求（${rangeText}；${requirementText(keywords)}）` });
      } else {
        push({ checkKey: 'keywords', label: '关键词', level: 'pass', source: 'requirement', detail: `关键词 ${facts.keywordCount} 个，符合官方要求「${keywords.valueText}」` });
      }
    }

    // section_structure
    const sectionStructure = byRule.get('section_structure');
    if (!sectionStructure) {
      push({ checkKey: 'section_structure', label: '章节结构', level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。稿件章节：${facts.headings.join('、') || '（未检测到标题结构）'}` });
    } else {
      const names = sectionStructure.valueText
        .split(/[,;，；、\n]/u)
        .map((name) => stripNumbering(name))
        .filter((name) => name.length >= 2 && name.length <= 60);
      if (names.length === 0) {
        push({ checkKey: 'section_structure', label: '章节结构', level: 'warn', source: 'requirement', detail: `官方要求「${sectionStructure.valueText}」无法解析出章节清单，无法自动核验` });
      } else {
        const headings = facts.headings.map((heading) => heading.toLowerCase());
        const missing = names.filter((name) => {
          const needle = name.toLowerCase();
          return !headings.some((heading) => heading.includes(needle) || needle.includes(heading));
        });
        if (missing.length > 0) {
          push({ checkKey: 'section_structure', label: '章节结构', level: 'block', source: 'requirement', detail: `缺少官方要求的章节：${missing.join('、')}（${requirementText(sectionStructure)}）` });
        } else {
          push({ checkKey: 'section_structure', label: '章节结构', level: 'pass', source: 'requirement', detail: `章节结构覆盖官方要求：${names.join('、')}` });
        }
      }
    }

    // reference_style
    const referenceStyle = byRule.get('reference_style');
    if (!referenceStyle) {
      push({ checkKey: 'reference_style', label: '参考文献', level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。检测到参考文献条目 ${facts.referenceCount} 条` });
    } else if (facts.referenceCount === 0) {
      push({ checkKey: 'reference_style', label: '参考文献', level: 'block', source: 'requirement', detail: `官方要求参考文献规范（${requirementText(referenceStyle)}），但稿件未检测到参考文献条目` });
    } else {
      push({ checkKey: 'reference_style', label: '参考文献', level: 'warn', source: 'requirement', detail: `检测到参考文献 ${facts.referenceCount} 条；引用格式细则无法自动核验，请人工对照官方要求「${referenceStyle.valueText}」` });
    }

    // figures_tables
    const figuresTables = byRule.get('figures_tables');
    const tableCount = countTables(document);
    if (!figuresTables) {
      push({ checkKey: 'figures_tables', label: '图表', level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。检测到表格 ${tableCount} 个` });
    } else {
      const limit = parseSingleLimit(figuresTables.valueText);
      if (limit === null) {
        push({ checkKey: 'figures_tables', label: '图表', level: 'warn', source: 'requirement', detail: `官方要求「${figuresTables.valueText}」无法解析出数值上限，无法自动核验。检测到表格 ${tableCount} 个，请人工核对图/表数量与格式` });
      } else if (tableCount > limit) {
        push({ checkKey: 'figures_tables', label: '图表', level: 'block', source: 'requirement', detail: `检测到表格 ${tableCount} 个，超出官方上限 ${limit}（${requirementText(figuresTables)}）` });
      } else {
        push({ checkKey: 'figures_tables', label: '图表', level: 'pass', source: 'requirement', detail: `检测到表格 ${tableCount} 个，未超出官方上限 ${limit}（图数量需人工核对）` });
      }
    }
  }

  // ── 盲审检查（blind_*） ──────────────────────────────────────

  private checkBlindReview(
    push: (check: SubmissionPreflightCheckCreateInput) => void,
    blindReview: JournalRequirement | undefined,
    manuscriptText: string,
  ): void {
    if (!blindReview) {
      const detail = '期刊无盲审要求（或未抓取到相关要求），无需匿名化处理';
      push({ checkKey: 'blind_author_names', label: '盲审：作者姓名', level: 'pass', detail, source: 'requirement' });
      push({ checkKey: 'blind_affiliation', label: '盲审：作者单位', level: 'pass', detail, source: 'requirement' });
      push({ checkKey: 'blind_acknowledgement', label: '盲审：致谢', level: 'pass', detail, source: 'requirement' });
      return;
    }
    // 仓库当前无用户名片/机构设置可复用：身份比对无法自动化，绝不假装已核验。
    const identityNote = `期刊要求盲审（${requirementText(blindReview)}）；未找到研究者名片/机构设置，无法自动比对身份信息，需要研究者确认稿件已匿名化`;
    push({ checkKey: 'blind_author_names', label: '盲审：作者姓名', level: 'warn', detail: identityNote, source: 'requirement' });
    push({ checkKey: 'blind_affiliation', label: '盲审：作者单位', level: 'warn', detail: identityNote, source: 'requirement' });
    if (ACKNOWLEDGEMENT_PATTERN.test(manuscriptText)) {
      push({ checkKey: 'blind_acknowledgement', label: '盲审：致谢', level: 'warn', source: 'requirement', detail: `期刊要求盲审（${requirementText(blindReview)}）；稿件中检测到致谢内容，盲审稿建议移除或匿名化，需要研究者确认` });
    } else {
      push({ checkKey: 'blind_acknowledgement', label: '盲审：致谢', level: 'pass', source: 'requirement', detail: '期刊要求盲审；未检测到致谢内容' });
    }
  }

  // ── 声明类检查（statement_*） ────────────────────────────────

  private checkStatements(
    push: (check: SubmissionPreflightCheckCreateInput) => void,
    byRule: Map<JournalRequirementRuleKey, JournalRequirement>,
    manuscriptText: string,
    facts: ManuscriptFacts,
  ): void {
    if (!facts.supported) {
      const detail = '文档类型不支持文本结构分析，声明类检查无法自动核验，请研究者人工核对';
      push({ checkKey: 'statement_funding', label: '基金资助声明', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'statement_coi', label: '利益冲突声明', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'statement_ethics', label: '伦理声明', level: 'warn', detail, source: 'deterministic' });
      push({ checkKey: 'statement_data_availability', label: '数据可用性声明', level: 'warn', detail, source: 'deterministic' });
      return;
    }
    const items: Array<{
      checkKey: 'statement_funding' | 'statement_coi' | 'statement_ethics' | 'statement_data_availability';
      label: string;
      ruleKey: JournalRequirementRuleKey;
      pattern: RegExp;
    }> = [
      { checkKey: 'statement_funding', label: '基金资助声明', ruleKey: 'funding', pattern: STATEMENT_PATTERNS.funding },
      { checkKey: 'statement_coi', label: '利益冲突声明', ruleKey: 'conflict_of_interest', pattern: STATEMENT_PATTERNS.coi },
      { checkKey: 'statement_ethics', label: '伦理声明', ruleKey: 'ethics', pattern: STATEMENT_PATTERNS.ethics },
      { checkKey: 'statement_data_availability', label: '数据可用性声明', ruleKey: 'data_availability', pattern: STATEMENT_PATTERNS.dataAvailability },
    ];
    for (const item of items) {
      const requirement = byRule.get(item.ruleKey);
      const found = item.pattern.test(manuscriptText);
      if (found) {
        push({
          checkKey: item.checkKey,
          label: item.label,
          level: 'pass',
          source: requirement ? 'requirement' : 'deterministic',
          detail: requirement ? `稿件中检测到${item.label}（官方要求：${requirementText(requirement)}）` : `稿件中检测到${item.label}（期刊未明确要求，已具备）`,
        });
      } else if (requirement) {
        push({ checkKey: item.checkKey, label: item.label, level: 'block', source: 'requirement', detail: `官方要求${item.label}（${requirementText(requirement)}），但稿件中未检测到，请补充` });
      } else {
        push({ checkKey: item.checkKey, label: item.label, level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。稿件中未检测到${item.label}` });
      }
    }
  }

  // ── 材料清单检查（file_*） ───────────────────────────────────

  private checkFiles(
    push: (check: SubmissionPreflightCheckCreateInput) => void,
    byRule: Map<JournalRequirementRuleKey, JournalRequirement>,
    caseId: string,
    outcomeId: string,
    outcomeVersion: number,
  ): void {
    // 主稿件 = 当前工作稿本身，恒在。
    push({
      checkKey: 'file_main_manuscript',
      label: '主稿件',
      level: 'pass',
      source: 'deterministic',
      detail: `当前工作稿 ${outcomeId} v${outcomeVersion} 即投稿主稿件`,
    });

    // 只读最新一轮 draft 投稿包的文件清单，不臆造材料存在。
    const latest = this.options.packageRepository.latestPackageForCase(caseId);
    const files = latest && latest.status === 'draft' ? this.options.packageRepository.listPackageFiles(latest.id) : [];
    const hasFile = (type: 'title_page' | 'cover_letter' | 'supplementary'): boolean => files.some((file) => file.type === type);
    const packageNote = latest
      ? latest.status === 'draft'
        ? `（对照第 ${latest.round} 轮投稿包，共 ${files.length} 个已登记文件）`
        : `（第 ${latest.round} 轮投稿包已冻结，未再建新一轮草稿包）`
      : '（尚未建立投稿包）';

    const items: Array<{
      checkKey: 'file_title_page' | 'file_cover_letter' | 'file_supplementary';
      label: string;
      type: 'title_page' | 'cover_letter' | 'supplementary';
      ruleKey: JournalRequirementRuleKey;
      /** 官方要求缺失时的阻断强度：title_page/cover_letter 阻断，supplementary 仅提醒。 */
      blockWhenRequired: boolean;
    }> = [
      { checkKey: 'file_title_page', label: 'Title Page', type: 'title_page', ruleKey: 'title_page', blockWhenRequired: true },
      { checkKey: 'file_cover_letter', label: 'Cover Letter', type: 'cover_letter', ruleKey: 'cover_letter', blockWhenRequired: true },
      { checkKey: 'file_supplementary', label: '补充材料', type: 'supplementary', ruleKey: 'supplementary', blockWhenRequired: false },
    ];
    for (const item of items) {
      const requirement = byRule.get(item.ruleKey);
      const present = hasFile(item.type);
      if (present) {
        push({ checkKey: item.checkKey, label: item.label, level: 'pass', source: 'deterministic', detail: `投稿包中已登记${item.label}${packageNote}` });
      } else if (requirement) {
        push({
          checkKey: item.checkKey,
          label: item.label,
          level: item.blockWhenRequired ? 'block' : 'warn',
          source: 'requirement',
          detail: `官方要求${item.label}（${requirementText(requirement)}），但投稿包中未登记${packageNote}`,
        });
      } else {
        push({ checkKey: item.checkKey, label: item.label, level: 'warn', source: 'requirement', detail: `${NO_REQUIREMENT}。投稿包中未登记${item.label}${packageNote}` });
      }
    }
  }

  // ── AI 政策检查 ─────────────────────────────────────────────

  private checkAiPolicy(
    push: (check: SubmissionPreflightCheckCreateInput) => void,
    aiPolicy: JournalRequirement | undefined,
    manuscriptText: string,
  ): void {
    if (!aiPolicy) {
      push({ checkKey: 'ai_policy', label: 'AI 使用政策', level: 'pass', source: 'requirement', detail: '期刊无 AI 政策要求（或未抓取到相关要求）' });
      return;
    }
    if (AI_STATEMENT_PATTERN.test(manuscriptText)) {
      push({ checkKey: 'ai_policy', label: 'AI 使用政策', level: 'pass', source: 'requirement', detail: `稿件中检测到 AI 使用相关声明（官方要求：${requirementText(aiPolicy)}）` });
    } else {
      push({ checkKey: 'ai_policy', label: 'AI 使用政策', level: 'warn', source: 'requirement', detail: `期刊有 AI 政策要求（${requirementText(aiPolicy)}），但稿件中未检测到 AI 使用声明，请确认是否需要补充` });
    }
  }
}
