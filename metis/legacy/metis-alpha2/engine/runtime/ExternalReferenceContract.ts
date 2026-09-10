/**
 * ExternalModelReference 契约（2026-09-05 刘总规格书：Chatbot 协作模式）。
 *
 * 【零越界铁律】外部模型（ChatGPT/Claude/DeepSeek/Kimi/豆包/GLM…）的输出
 * **永不是 Evidence**：不进 evidence 链、不参与引用真实性核验、不进
 * evidenceRefs。它只能作为「外部参考」（external considerations /
 * hypotheses）进入研究过程——渲染层必须带「外部参考·非证据」徽标，
 * 数据层独立存 external_references 表，与 papers/sources 证据链物理隔离。
 */

import { createHash } from 'node:crypto';

export const EXTERNAL_REFERENCE_VERSION = 1 as const;

export interface ExternalModelReference {
  v: typeof EXTERNAL_REFERENCE_VERSION;
  id: string;
  /** 来源模型/站点显示名（如 ChatGPT、豆包）。 */
  model: string;
  /** 来源页面 URL（http/https）。 */
  url: string;
  /** 用户在 Chatbot 页选中的原文（引用全文，原样保留）。 */
  quotedText: string;
  /** sha256(quotedText) 前 16 位——去重与防篡改指纹。 */
  contextDigest: string;
  capturedAt: number;
  projectId: string | null;
  /** 捕获时所在的选题/工作会话（可空）。 */
  sessionId: string | null;
}

export type ExternalReferenceParseResult =
  | { ok: true; reference: ExternalModelReference }
  | { ok: false; issues: string[] };

const URL_PATTERN = /^https?:\/\/[^\s]+$/iu;

export function externalReferenceDigest(quotedText: string): string {
  return createHash('sha256').update(quotedText, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 宽松净化校验：未知字段剔除；仅运行必需字段类型错误才拒绝，并如实带回
 * 具体字段（与 PersonalizationRepository.save 同一宽松哲学）。
 */
export function normalizeExternalModelReference(raw: unknown): ExternalReferenceParseResult {
  const issues: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ['root: 必须是对象'] };
  }
  const candidate = raw as Record<string, unknown>;
  const model = typeof candidate.model === 'string' ? candidate.model.trim().slice(0, 64) : '';
  if (!model) issues.push('model: 必须是非空字符串');
  const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
  if (!url || !URL_PATTERN.test(url)) issues.push('url: 必须是 http(s) URL');
  const quotedText = typeof candidate.quotedText === 'string' ? candidate.quotedText : '';
  if (!quotedText.trim()) issues.push('quotedText: 引用文本不能为空');
  if (quotedText.length > 20_000) issues.push('quotedText: 超过 20000 字符上限');
  const capturedAt = typeof candidate.capturedAt === 'number' && Number.isFinite(candidate.capturedAt)
    ? Math.floor(candidate.capturedAt)
    : Date.now();
  if (issues.length > 0) return { ok: false, issues };
  const id = typeof candidate.id === 'string' && candidate.id.trim().length >= 3
    ? candidate.id.trim().slice(0, 64)
    : `extref-${capturedAt.toString(36)}-${externalReferenceDigest(quotedText)}`;
  return {
    ok: true,
    reference: {
      v: EXTERNAL_REFERENCE_VERSION,
      id,
      model: model!,
      url: url!,
      quotedText,
      contextDigest: externalReferenceDigest(quotedText!),
      capturedAt,
      projectId: typeof candidate.projectId === 'string' && candidate.projectId.trim() ? candidate.projectId.trim().slice(0, 128) : null,
      sessionId: typeof candidate.sessionId === 'string' && candidate.sessionId.trim() ? candidate.sessionId.trim().slice(0, 128) : null,
    },
  };
}

/**
 * Context Package（METIS → Chatbot Bridge）：把当前选题上下文组装为
 * 结构化 Markdown 文本，供粘贴到外部模型。纯函数、确定性输出。
 */
export interface ContextPackageInput {
  projectTitle?: string | null;
  topicQuestion?: string | null;
  sessionStatus?: string | null;
  candidates: Array<{ title: string; status: string; novelty?: number | null; feasibility?: number | null }>;
  recentTurns: Array<{ role: string; content: string }>;
  /** 引用外部模型内容时必须明确「非证据」语义。 */
  externalReferences?: Array<{ model: string; quotedText: string }>;
  maxChars?: number;
}

export function buildContextPackage(input: ContextPackageInput): string {
  const limit = input.maxChars ?? 8000;
  const lines: string[] = [];
  lines.push('## METIS 研究上下文包');
  lines.push('');
  if (input.projectTitle) lines.push(`项目：${input.projectTitle}`);
  if (input.topicQuestion) lines.push(`选题问题：${input.topicQuestion}`);
  if (input.sessionStatus) lines.push(`当前阶段：${input.sessionStatus}`);
  if (input.candidates.length > 0) {
    lines.push('', '### 候选选题池');
    for (const candidate of input.candidates.slice(0, 12)) {
      const scores = [
        typeof candidate.novelty === 'number' ? `新颖${candidate.novelty}` : null,
        typeof candidate.feasibility === 'number' ? `可行${candidate.feasibility}` : null,
      ].filter(Boolean).join(' / ');
      lines.push(`- [${candidate.status}] ${candidate.title}${scores ? `（${scores}）` : ''}`);
    }
  }
  if (input.externalReferences && input.externalReferences.length > 0) {
    lines.push('', '### 已引用的外部模型观点（外部参考·非证据）');
    for (const ref of input.externalReferences.slice(0, 6)) {
      lines.push(`- [${ref.model}] ${ref.quotedText.slice(0, 200)}`);
    }
  }
  if (input.recentTurns.length > 0) {
    lines.push('', '### 最近对话');
    for (const turn of input.recentTurns.slice(-6)) {
      const role = turn.role === 'user' ? '用户' : 'METIS';
      lines.push(`- ${role}：${turn.content.slice(0, 400)}`);
    }
  }
  lines.push('', '（以上为 METIS 当前工作上下文，仅供你参考；请基于这些信息回答我的下一个问题。）');
  const text = lines.join('\n');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`;
}
