/**
 * ContextScope 契约（任务2：METIS 上下文隔离与领域所有权，2026-09-05 刘总规格书）。
 *
 * 【核心原则：默认隔离，显式共享】
 * 任何可能进入 LLM/Agent 上下文的数据都必须能回答：属于哪个 Project / Session /
 * Topic / Artifact / Outcome / SubmissionCase；当前调用是否有权读取。
 *
 * Invariant（不是约定，是校验函数）：
 * - Session 最多属于一个 Project（sessions.project_id 唯一归属）。
 * - Outcome / Project Artifact 属于 Project。
 * - Topic 在转 Project 前可独立（projectId 为 null 合法）。
 * - ExternalReference 至少绑定捕获时的 Topic/Session；有 Project 时同时绑定。
 * - Evidence / Sources 为 Project-scoped。
 * - 只有显式 global 语义（用户全局偏好/规则）才允许进入所有 scope。
 * - null/undefined scope 不等于「所有 scope」：读取 API 必须显式给出 scope，
 *   缺省即拒绝（scope_required）或返回空，绝不回退到全局最近数据。
 *
 * 本模块不依赖任何 runtime/store 模块，可被 electron 与 engine 双侧使用。
 */

import { createHash } from 'node:crypto';

/** 一次 LLM 调用/一次上下文读取所声明的归属范围。字段全部可选，但组合受 invariant 约束。 */
export interface ContextScope {
  projectId?: string;
  sessionId?: string;
  /** Topic（选题）会话 id——转 Project 前独立于 projectId。 */
  topicSessionId?: string;
  outcomeId?: string;
  artifactId?: string;
  submissionCaseId?: string;
}

export interface ScopeValidationIssue {
  code: 'scope_mismatch' | 'scope_required' | 'invalid_scope';
  /** 人读诊断（写入日志/错误响应，不进 prompt）。 */
  detail: string;
}

const SCOPE_ID_MAX = 256;

function cleanScopeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, SCOPE_ID_MAX) : undefined;
}

/** 净化任意输入为合法 ContextScope；未知字段剔除，空串/非字符串字段丢弃。 */
export function sanitizeContextScope(raw: unknown): ContextScope {
  const candidate = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  const scope: ContextScope = {};
  const projectId = cleanScopeId(candidate.projectId);
  const sessionId = cleanScopeId(candidate.sessionId);
  const topicSessionId = cleanScopeId(candidate.topicSessionId);
  const outcomeId = cleanScopeId(candidate.outcomeId);
  const artifactId = cleanScopeId(candidate.artifactId);
  const submissionCaseId = cleanScopeId(candidate.submissionCaseId);
  if (projectId) scope.projectId = projectId;
  if (sessionId) scope.sessionId = sessionId;
  if (topicSessionId) scope.topicSessionId = topicSessionId;
  if (outcomeId) scope.outcomeId = outcomeId;
  if (artifactId) scope.artifactId = artifactId;
  if (submissionCaseId) scope.submissionCaseId = submissionCaseId;
  return scope;
}

/**
 * Fail-closed 归属校验（任务第十三节）：
 * session 属于 Project A 而 request 声明 Project B 时拒绝 scope_mismatch；
 * 绝不自动猜、修正或按「最近项目」回退。
 *
 * 判定规则：两侧都非空且不相等 → mismatch。任一侧为空不参与判定
 * （null 不等于通配符，也不自动等于对方——绑定必须显式发生）。
 */
export function checkSessionProjectBinding(
  owner: { projectId?: string | null },
  request: { projectId?: string | null },
): ScopeValidationIssue | null {
  const ownerProject = typeof owner.projectId === 'string' && owner.projectId.trim() ? owner.projectId.trim() : null;
  const requestProject = typeof request.projectId === 'string' && request.projectId.trim() ? request.projectId.trim() : null;
  if (ownerProject && requestProject && ownerProject !== requestProject) {
    return {
      code: 'scope_mismatch',
      detail: `session belongs to project "${ownerProject}" but request declares project "${requestProject}"`,
    };
  }
  return null;
}

/**
 * 上下文读取 scope 校验：读取「可能进 prompt」的数据时必须显式声明至少一个
 * 归属维度。空 scope → scope_required（禁止 list() → 全局最近的危险默认）。
 */
export function requireScopeOwnership(
  scope: ContextScope,
  dimension: 'projectId' | 'sessionId' | 'topicSessionId',
): ScopeValidationIssue | null {
  if (scope[dimension]) return null;
  if (scope.projectId || scope.sessionId || scope.topicSessionId) return null;
  return {
    code: 'scope_required',
    detail: `context read requires explicit ownership (at least ${dimension}); empty scope must never mean "all data"`,
  };
}

/** 人读诊断用（日志/provenance），不进 prompt。 */
export function describeScope(scope: ContextScope): string {
  const parts: string[] = [];
  if (scope.projectId) parts.push(`project=${scope.projectId}`);
  if (scope.sessionId) parts.push(`session=${scope.sessionId}`);
  if (scope.topicSessionId) parts.push(`topic=${scope.topicSessionId}`);
  if (scope.outcomeId) parts.push(`outcome=${scope.outcomeId}`);
  if (scope.artifactId) parts.push(`artifact=${scope.artifactId}`);
  if (scope.submissionCaseId) parts.push(`case=${scope.submissionCaseId}`);
  return parts.length > 0 ? parts.join(',') : 'global';
}

// ─── Context Provenance（任务第十二节）────────────────────────
//
// 重要 run 保存轻量 provenance（哪些 scope 的内容被装进了请求），用于事后
// 诊断「这条回答当时看了哪些上下文」。不保存隐藏推理链。

export interface ContextProvenance {
  projectId?: string;
  sessionId?: string;
  scenarioId?: string;
  /** 注入 prompt 的 active artifact ids（显式选中，非「最近抓取」）。 */
  artifactIds?: string[];
  /** 注入 prompt 的 source/evidence ids。 */
  sourceIds?: string[];
  evidenceIds?: string[];
  /** 注入 prompt 的规则层 digest（global/scenario/project Metis.md）。 */
  ruleRevisions?: string[];
  /** 显式引用的外部模型参考 id（ExternalModelReference）。 */
  externalRefIds?: string[];
  /** 上下文内容 digest（sha256 前 16 位，由 buildContextProvenance 计算）。 */
  contextDigest?: string;
  createdAt?: number;
}

const PROVENANCE_INPUT_MAX = 20_000;

/**
 * 组装一条 provenance 记录：对注入内容做轻量 digest，附带各维度 id。
 * 纯函数、确定性（同输入同输出）。
 */
export function buildContextProvenance(input: {
  projectId?: string;
  sessionId?: string;
  scenarioId?: string;
  artifactIds?: string[];
  sourceIds?: string[];
  evidenceIds?: string[];
  ruleRevisions?: string[];
  externalRefIds?: string[];
  /** 参与 digest 的注入内容片段（如 memoryContext、projectRules markdown）。 */
  injectedParts?: Array<{ kind: string; content: string }>;
}): ContextProvenance {
  const digestInput = (input.injectedParts ?? [])
    .map((part) => `${part.kind}\u0000${part.content.slice(0, PROVENANCE_INPUT_MAX)}`)
    .join('\u0001');
  const provenance: ContextProvenance = {
    createdAt: Date.now(),
  };
  if (input.projectId) provenance.projectId = input.projectId;
  if (input.sessionId) provenance.sessionId = input.sessionId;
  if (input.scenarioId) provenance.scenarioId = input.scenarioId;
  if (input.artifactIds?.length) provenance.artifactIds = input.artifactIds.slice(0, 64);
  if (input.sourceIds?.length) provenance.sourceIds = input.sourceIds.slice(0, 64);
  if (input.evidenceIds?.length) provenance.evidenceIds = input.evidenceIds.slice(0, 64);
  if (input.ruleRevisions?.length) provenance.ruleRevisions = input.ruleRevisions.slice(0, 16);
  if (input.externalRefIds?.length) provenance.externalRefIds = input.externalRefIds.slice(0, 64);
  provenance.contextDigest = sha256Short(digestInput);
  return provenance;
}

/** 轻量摘要：与 ExternalReferenceContract.digestOf 同一口径（sha256 前 16 位）。 */
function sha256Short(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 跨项目 leakage 的最终防线（任务第十四节）：在 provider request 发出前，
 * 对「声明 scope = B」的最终 prompt 文本断言不含 A 项目的独占 marker。
 * 这是测试与运行时可共用的同一实现；调用方负责在发送前调用。
 */
export function assertNoForeignScopeMarkers(input: {
  requestScope: { projectId?: string };
  promptText: string;
  /** 其它项目的独占 marker（如项目标题、唯一 id）。 */
  foreignMarkers: Array<{ projectId: string; markers: string[] }>;
}): ScopeValidationIssue | null {
  const requestProject = input.requestScope.projectId?.trim();
  if (!requestProject) return null;
  for (const foreign of input.foreignMarkers) {
    if (foreign.projectId === requestProject) continue;
    for (const marker of foreign.markers) {
      if (marker && input.promptText.includes(marker)) {
        return {
          code: 'scope_mismatch',
          detail: `provider request for project "${requestProject}" contains foreign marker of project "${foreign.projectId}"`,
        };
      }
    }
  }
  return null;
}
