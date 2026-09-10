/**
 * Literature 领域模型与 Provider 契约（dsh-metis-literature，Phase 11 / T11）。
 */

import type { VerificationState } from '../../evidence/src/domain.js'

/** 文献记录（T11-003）。authors 结构化数组；year 为 number 或 null；DOI 规范化小写。 */
export interface LiteratureRecord {
  id: string
  title: string
  authors: Array<{ name: string; given?: string; family?: string }>
  year: number | null
  journal?: string
  abstract?: string
  doi?: string
  url?: string
  /** 来源提供方标识（crossref/openalex/ncpssd/...）。 */
  source: string
  /** 提供方内部 id。 */
  sourceId?: string
  keywords?: string[]
  citationCount?: number
  /** 核心期刊标记（必须来自来源，禁止模型推断——规格五/二十六）。 */
  coreStatus?: 'cssci' | 'pku-core' | 'chinese-core' | 'sci' | 'ssci' | 'unknown'
  verificationState?: VerificationState
  /** 保存到项目时登记的证据 id（T11-037）。 */
  evidenceId?: string
  projectId?: string | null
}

/** 规范化 DOI：去 url 前缀、小写（T11-006）。 */
export function normalizeDoi(doi: string | undefined | null): string | undefined {
  if (!doi) return undefined
  const trimmed = doi.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
}

/** Provider 不可用/失败的稳定领域错误（T11-040：映射为 domain error，fail-loud）。 */
export class ProviderUnavailableError extends Error {
  readonly provider: string
  readonly cause2?: string

  constructor(provider: string, cause2?: string) {
    super(`Literature provider "${provider}" is unavailable${cause2 ? `: ${cause2}` : ''}. 其他来源仍可使用；本次未返回伪结果。`)
    this.name = 'ProviderUnavailableError'
    this.provider = provider
    this.cause2 = cause2
  }
}

export interface LiteratureSearchOptions {
  query: string
  limit?: number
  signal?: AbortSignal
}

/** Literature Provider 契约（T11-009~018）。 */
export interface LiteratureProvider {
  readonly name: string
  readonly capabilities: {
    search: boolean
    getByDoi: boolean
  }
  search(options: LiteratureSearchOptions): Promise<LiteratureRecord[]>
  getByDoi?(doi: string, signal?: AbortSignal): Promise<LiteratureRecord | null>
}

/** 搜索硬上限（T11-035）。 */
export const SEARCH_HARD_CAP = 50
