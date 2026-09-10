/**
 * Cover Letter Service — 投稿信生成服务（学术投稿生命周期 P2b）。
 *
 * 职责：基于 SubmissionCase（标题/期刊/文章类型）、期刊档案最新快照的官方
 * 要求、稿件摘要与章节标题，生成可编辑的 Cover Letter 成果（kind 'word'，
 * 纯文本段落），并在该 case 存在 draft 投稿包时自动登记 cover_letter 条目。
 *
 * 事实门控（硬要求）：作者姓名/单位/通讯邮箱/基金号/伦理批准号/推荐审稿人/
 * 利益冲突声明——仓库无可靠来源（无用户名片设置），一律在信中留
 * 「[待确认：XXX]」占位并列入 needsConfirmation，禁止模型编造：
 *  - 有 agentLoop 时由 skillPrompt 明令不得编造，且落库前做确定性兜底：
 *    正文缺哪个占位就补哪个，不依赖模型自觉；
 *  - 无 agentLoop 时生成模板骨架并标 extraction: 'template'；
 *  - LLM 调用失败/输出为空时如实降级为模板，不伪装成 AI 成稿。
 *
 * 幂等：同 case 重复生成时按标题 `Cover Letter｜<期刊名>` 找到已有成果并
 * save 新版本（actor 'ai'），不重复建新成果。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ProviderProfileBinding } from '../engine/runtime/ProviderProfileContract.js';
import type { OutcomeDocument, OutcomeSource, WordDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import type { JournalRequirement } from '../engine/submission/JournalProfileContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import { extractManuscriptPlainText } from './SubmissionGapService.js';
import { hashOutcomeVersionContent, normalizeFilenameStem } from './SubmissionPackageService.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import type { OutcomeRepository } from './OutcomeRepository.js';
import type { SubmissionPackageRepository } from './SubmissionPackageRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

// ─── 公共契约 ────────────────────────────────────────────────

export const CoverLetterGenerateRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1),
});
export type CoverLetterGenerateRequest = z.infer<typeof CoverLetterGenerateRequestSchema>;

export type CoverLetterErrorCode = 'invalid_request' | 'case_not_found' | 'manuscript_not_found';

export type CoverLetterGenerateResult =
  | { ok: true; outcomeId: string; version: number; needsConfirmation: string[]; extraction: 'llm' | 'template' }
  | { ok: false; code: CoverLetterErrorCode };

export interface CoverLetterServiceOptions {
  submissionRepository: SubmissionRepository;
  journalRepository: JournalProfileRepository;
  outcomeRepository: OutcomeRepository;
  /** 可选：存在时生成后自动把 Cover Letter 挂进该 case 的 draft 投稿包。 */
  packageRepository?: SubmissionPackageRepository;
  /** 可选 LLM 原语：缺省时走模板骨架。 */
  agentLoop?: Pick<AgentLoop, 'run'>;
  /** 可选 provider 路由凭据（随 agentLoop 生效）。 */
  providerProfileBinding?: ProviderProfileBinding;
  /** 成果提示词工程(任务4/5):行为段 Override 解析。 */
  resolveBehaviorPrompt?: (promptId: string, outcomeId?: string | null) => string | null;
  /** T8：Profile 全局风格段。 */
  getGlobalPrompt?: (officeKind: string, outcomeId: string | null) => string | null;
}

/**
 * 事实门控清单：仓库无可靠来源，一律占位 + needsConfirmation，禁止编造。
 * 顺序即信中占位顺序。
 */
export const COVER_LETTER_FACT_PLACEHOLDERS = [
  '作者姓名',
  '作者单位',
  '通讯邮箱',
  '基金号',
  '伦理批准号',
  '推荐审稿人',
  '利益冲突声明',
] as const;

const placeholder = (fact: string): string => `[待确认：${fact}]`;

// ─── 稿件摘要提取（确定性，只截取不推测） ─────────────────────

function stripNumbering(text: string): string {
  return text.replace(/^\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)[.、\s]*/u, '').trim();
}

/** 取摘要正文（Abstract/摘要 标题之后到下一标题之间）；取不到回退全文首段。 */
function extractAbstractText(document: OutcomeDocument): string {
  if (document.type === 'word') {
    const blocks = document.blocks;
    const start = blocks.findIndex((block) => {
      if (block.kind !== 'heading') return false;
      const heading = stripNumbering(block.text ?? '').toLowerCase();
      return heading.startsWith('abstract') || heading.startsWith('摘要');
    });
    if (start >= 0) {
      const parts: string[] = [];
      for (let index = start + 1; index < blocks.length; index += 1) {
        const block = blocks[index]!;
        if (block.kind === 'heading') break;
        const text = (block.text ?? '').trim();
        if (text) parts.push(text);
      }
      if (parts.length > 0) return parts.join('\n');
    }
  }
  return extractManuscriptPlainText(document).split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

/** 从摘要中取第一句作为贡献要点；取不到返回空串（禁止编造）。 */
function firstSentence(text: string): string {
  const match = /.+?[.。!？!?\n]/u.exec(text.trim());
  return (match ? match[0] : text.trim()).trim().slice(0, 300);
}

/** 正文纯文本 → WordDocument 纯段落块。 */
function plainTextToWordDocument(text: string): WordDocument {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    type: 'word',
    page: {},
    header: '',
    footer: '',
    blocks: lines.map((line, index) => ({ id: `cl-b-${index + 1}`, kind: 'paragraph' as const, text: line })),
  };
}

// ─── 服务 ────────────────────────────────────────────────────

export class CoverLetterService {
  constructor(private readonly options: CoverLetterServiceOptions) {}

  /**
   * 生成 Cover Letter：装配上下文 → （有 agentLoop）LLM 成稿或模板骨架 →
   * 事实占位兜底 → 落库为可编辑 word 成果（已有同题成果则 save 新版本）→
   * 自动挂进 draft 投稿包 → 追加 cover_letter_generated 事件。
   */
  async generate(rawInput: unknown): Promise<CoverLetterGenerateResult> {
    const parsed = CoverLetterGenerateRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, caseId } = parsed.data;

    const submissionCase = this.options.submissionRepository.getCase(projectId, caseId);
    if (!submissionCase) return { ok: false, code: 'case_not_found' };
    const manuscriptId = submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId;
    const manuscript = manuscriptId ? this.options.outcomeRepository.get(projectId, manuscriptId) : undefined;
    if (!manuscriptId || !manuscript) return { ok: false, code: 'manuscript_not_found' };

    const profile = submissionCase.targetJournalId
      ? this.options.journalRepository.getProfile(projectId, submissionCase.targetJournalId)
      : undefined;
    const snapshot = profile ? this.options.journalRepository.latestSnapshot(profile.id) : undefined;
    const requirements = snapshot ? this.options.journalRepository.listRequirements(snapshot.id) : [];
    const journalName = submissionCase.targetJournalName || profile?.canonicalName || '目标期刊';
    const abstractText = extractAbstractText(manuscript.version.content);
    const headings = manuscript.version.content.type === 'word'
      ? manuscript.version.content.blocks
          .filter((block) => block.kind === 'heading' && (block.text ?? '').trim().length > 0)
          .map((block) => stripNumbering(block.text ?? ''))
      : [];

    const needsConfirmation = [...COVER_LETTER_FACT_PLACEHOLDERS];
    const context = {
      title: submissionCase.title || manuscript.outcome.title,
      journalName,
      articleType: submissionCase.articleType ?? '',
      requirements,
      abstractText,
      headings,
    };

    let body: string;
    let extraction: 'llm' | 'template';
    const llmBody = await this.generateWithLlm(projectId, context);
    if (llmBody) {
      body = llmBody;
      extraction = 'llm';
    } else {
      body = this.templateBody(context);
      extraction = 'template';
    }
    // 确定性兜底：正文缺哪个事实占位就补哪个，不依赖模型自觉。
    const missing = needsConfirmation.filter((fact) => !body.includes(placeholder(fact)));
    if (missing.length > 0) {
      body += `\n\n—— 以下事实信息待研究者确认后补全 ——\n${missing.map((fact) => `${fact}：${placeholder(fact)}`).join('\n')}`;
    }

    const title = `Cover Letter｜${journalName}`;
    const content = plainTextToWordDocument(body);
    const sources: OutcomeSource[] = [{
      kind: 'outcome_version',
      id: manuscriptId,
      version: manuscript.version.version,
      label: `稿件：${manuscript.outcome.title} v${manuscript.version.version}`,
    }];
    const note = 'Cover Letter 草稿（AI 生成，事实待确认）';

    // 幂等：按标题找到该 case 已有的 Cover Letter 成果则 save 新版本。
    const existing = this.options.outcomeRepository
      .list(projectId, title)
      .find((item) => item.title === title);
    const persisted = existing
      ? this.options.outcomeRepository.save({ projectId, outcomeId: existing.id, baseVersion: existing.currentVersion, content, note, actor: 'ai', sources })
      : this.options.outcomeRepository.create({ projectId, categoryId: null, title, kind: 'word', content, note, actor: 'ai' });

    this.attachToDraftPackage(projectId, caseId, persisted.outcome.id, persisted.version.version, persisted.version.content, requirements);
    this.options.submissionRepository.addEvent(projectId, {
      caseId,
      type: 'cover_letter_generated',
      source: 'agent',
      description: `Cover Letter 已生成（${extraction === 'llm' ? 'AI 成稿' : '模板骨架'}，v${persisted.version.version}）`,
      metadata: {
        outcomeId: persisted.outcome.id,
        version: persisted.version.version,
        extraction,
        needsConfirmation,
      },
    });
    return { ok: true, outcomeId: persisted.outcome.id, version: persisted.version.version, needsConfirmation, extraction };
  }

  // ── 内部实现 ───────────────────────────────────────────────

  /** LLM 成稿：无 agentLoop 或调用失败/输出为空时返回 null（调用方降级模板）。 */
  private async generateWithLlm(
    projectId: string,
    context: {
      title: string;
      journalName: string;
      articleType: string;
      requirements: JournalRequirement[];
      abstractText: string;
      headings: string[];
    },
  ): Promise<string | null> {
    const agentLoop = this.options.agentLoop;
    if (!agentLoop) return null;
    const requirementLines = context.requirements
      .map((requirement) => `- [${requirement.ruleKey}] ${requirement.valueText}`)
      .join('\n');
    const prompt = [
      `目标期刊：${context.journalName}`,
      `稿件标题：${context.title}`,
      context.articleType ? `文章类型：${context.articleType}` : '',
      '',
      '【期刊官方要求（如有）】',
      requirementLines || '（未抓取到官方要求）',
      '',
      '【稿件摘要（截断）】',
      context.abstractText.slice(0, 1500) || '（未提取到摘要）',
      '',
      '【稿件章节标题】',
      context.headings.join('、') || '（无）',
    ].filter((line) => line !== '').join('\n');
    // 成果提示词工程(任务4):行为段首行支持 Override;事实禁令与占位协议保持系统控制。
    const coverLetterBehavior = this.options.resolveBehaviorPrompt?.('document.cover_letter') ?? null;
    const globalStylePrompt = this.options.getGlobalPrompt?.('word', null) ?? null;
    const skillPrompt = [
        ...((globalStylePrompt ?? '').trim() ? ['【内容规范·全局风格（本 Profile 全部动作共同遵守）】\n' + (globalStylePrompt ?? '').trim()] : []),
      ...(coverLetterBehavior ? coverLetterBehavior.split('\n').filter((line) => line.trim().length > 0) : [
      '你是学术投稿信（Cover Letter）撰写助手。根据用户给出的稿件与期刊上下文，撰写一封投稿信正文。',
      ]),
      `硬性禁令：以下事实一律不得编造——${COVER_LETTER_FACT_PLACEHOLDERS.join('、')}；`,
      `凡涉及这些事实的位置必须使用占位符（形如 ${placeholder('作者姓名')}），与上下文无关的信息不要虚构。`,
      '可以如实陈述的：稿件标题、目标期刊名、文章类型、从摘要中提取的研究主题与贡献。',
      '只输出投稿信正文纯文本，不要 Markdown 格式，不要任何解释或前后缀。',
    ].join('\n');
    try {
      const response = await runEphemeralChatTurn({
        agentLoop,
        sessionId: `cover-letter-${randomUUID()}`,
        requestId: `cover-letter-${randomUUID()}`,
        messages: [{ role: 'user', content: prompt }],
        maxTurns: 1,
        allowedTools: [],
        projectId,
        skillPrompt,
        ...(this.options.providerProfileBinding ? { providerProfileBinding: this.options.providerProfileBinding } : {}),
      });
      if (response.status !== 'completed') return null;
      const answer = response.answer.trim();
      return answer.length > 0 ? answer : null;
    } catch {
      return null;
    }
  }

  /** 模板骨架：称呼/标题期刊占位、贡献要点取自摘要第一句、标准结尾、全部事实占位。 */
  private templateBody(context: {
    title: string;
    journalName: string;
    articleType: string;
    abstractText: string;
  }): string {
    const contribution = firstSentence(context.abstractText);
    return [
      '尊敬的编辑：',
      '',
      `您好！我们谨向《${context.journalName}》提交稿件「${context.title}」${context.articleType ? `（${context.articleType}）` : ''}，恳请贵刊考虑刊发。`,
      '',
      contribution
        ? `本研究的主要贡献：${contribution}`
        : '本研究的主要贡献：[待确认：请研究者补充贡献要点（未能从稿件摘要提取）]',
      '',
      '本稿件为原创成果，未曾在其他刊物发表，亦未同时投稿他刊（请研究者确认上述声明属实）。',
      '',
      `作者：${placeholder('作者姓名')}（${placeholder('作者单位')}）`,
      `通讯邮箱：${placeholder('通讯邮箱')}`,
      `基金资助：${placeholder('基金号')}`,
      `伦理批准：${placeholder('伦理批准号')}`,
      `推荐审稿人：${placeholder('推荐审稿人')}`,
      `利益冲突声明：${placeholder('利益冲突声明')}`,
      '',
      '此致',
      '敬礼！',
      '',
      placeholder('作者姓名'),
      placeholder('作者单位'),
    ].join('\n');
  }

  /** 该 case 存在 draft 投稿包时，把 Cover Letter 成果登记/更新为 cover_letter 条目。 */
  private attachToDraftPackage(
    projectId: string,
    caseId: string,
    outcomeId: string,
    version: number,
    content: OutcomeDocument,
    requirements: JournalRequirement[],
  ): void {
    const packageRepository = this.options.packageRepository;
    if (!packageRepository) return;
    const pkg = packageRepository.latestPackageForCase(caseId);
    if (!pkg || pkg.status !== 'draft') return;
    const filename = `${normalizeFilenameStem(`Cover Letter ${version}`, 'cover-letter')}.docx`;
    const contentHash = hashOutcomeVersionContent(content);
    const required = requirements.some((requirement) => requirement.ruleKey === 'cover_letter');
    const existing = packageRepository
      .listPackageFiles(pkg.id)
      .find((file) => file.type === 'cover_letter' && file.outcomeId === outcomeId);
    if (existing) {
      if (existing.outcomeVersion === version && existing.contentHash === contentHash) return;
      packageRepository.updatePackageFile(pkg.id, existing.id, {
        filename,
        outcomeVersion: version,
        contentHash,
        required,
        validationStatus: 'pending',
      });
      return;
    }
    packageRepository.addPackageFile(pkg.id, {
      type: 'cover_letter',
      filename,
      outcomeId,
      outcomeVersion: version,
      contentHash,
      required,
      note: 'Cover Letter（AI 生成，事实待确认）',
    });
  }
}
