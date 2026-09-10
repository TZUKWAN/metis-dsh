/**
 * Evidence 领域模型（dsh-metis-evidence，Phase 10）。
 *
 * 设计目标（任务清单 10.1 / 愿景十四）：每条重要事实可追溯
 * Claim → Evidence → Source → Original Record (URL/DOI/File)。
 * evidenceState 表达验证生命周期；未经验证的证据不得进入正式科研成果。
 */

/** 证据验证状态（T10-006）。 */
export type VerificationState = 'unverified' | 'verified' | 'rejected' | 'conflicted' | 'stale';

/** 来源类型（可扩展；插件不枚举完毕，来源归 provider 归属）。 */
export type EvidenceSourceType =
  | 'literature'
  | 'web_page'
  | 'database_observation'
  | 'computation'
  | 'user_provided'
  | 'model_inference'
  | 'file';

export interface EvidenceSource {
  /** 来源提供方（如 crossref/openalex/ncpssd/user）。 */
  provider: string
  /** 提供方内部 id（如 DOI、OpenAlex work id）。 */
  sourceId?: string
  /** 正式 URL（如有）。 */
  url?: string
  /** 抓取/获取时间。 */
  retrievedAt?: number
}

export interface EvidenceRecord {
  id: string
  /** 归属科研项目（core 插件的 ResearchProjectRecord id）；null 表示尚未归属。 */
  projectId: string | null
  sourceType: EvidenceSourceType
  source: EvidenceSource
  /** 主张/观察的一句话概括（面向模型与人的 canonical 表达）。 */
  title: string
  /** 原文摘录或观察值（有界：≤ 4_000 字符，超出截断并记录 truncated 标记）。 */
  observation?: string
  doi?: string
  url?: string
  observedAt: number
  verificationState: VerificationState
  /** 记录该证据的工具/来源标识（ createdByTool，T10-008）。 */
  createdByTool: string
  createdAt: number
  updatedAt: number
  truncated?: boolean
}

/** 持久化文件形态（schema version 独立演进）。 */
export interface EvidenceStoreFile {
  schemaVersion: 1
  records: EvidenceRecord[]
}

export function isEvidenceRecordLike(value: unknown): value is EvidenceRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string'
    && typeof record['title'] === 'string'
    && typeof record['sourceType'] === 'string'
    && typeof record['observedAt'] === 'number'
    && typeof record['verificationState'] === 'string'
}
