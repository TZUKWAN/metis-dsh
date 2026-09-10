/**
 * dsh-metis-literature-ncpssd — NCPSSD 中文文献 Provider（Phase 15 / Gate E）。
 *
 * 来源：国家哲学社会科学文献中心（www.ncpssd.org）公共检索接口。
 * 领域逻辑提取自旧 METIS `electron/LiteratureSearchService.ts`（parser 与获取分离）。
 *
 * Known Limitations：
 * - NCPSSD 无 DOI 检索能力（capabilities.getByDoi = false）；
 * - 反爬/登录态变化时以 ProviderUnavailableError fail-loud（T14-012/028），不改 DSH；
 * - 核心期刊标记来自 CoreJournalLists 白名单（来源数据，非模型推断）。
 */

import {
  ProviderUnavailableError,
  type LiteratureProvider,
  type LiteratureRecord,
  type LiteratureSearchOptions,
} from 'dsh-metis-literature'
import { buildSearchForm, parseNcpssdPayload } from './ncpssd-parser.ts'

const SEARCH_URL = 'https://www.ncpssd.org/searchHandler/search'
const REFERER = 'https://www.ncpssd.org/Literature/articlelist'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Metis/0.1'
const DEFAULT_TIMEOUT_MS = 20_000

export class NcpssdProvider implements LiteratureProvider {
  readonly name = 'ncpssd'
  readonly capabilities = { search: true, getByDoi: false }
  private readonly timeoutMs: number

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  async search(options: LiteratureSearchOptions): Promise<LiteratureRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 25)
    // 核心过滤在客户端做：第一页大多是非核心刊物，放大抓取量再过滤避免空结果。
    const form = buildSearchForm(options.query, 1, Math.min(100, limit * 8))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort)
    let records: LiteratureRecord[]
    try {
      const response = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
          Referer: REFERER,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      })
      if (!response.ok) throw new ProviderUnavailableError('ncpssd', `http_${response.status}`)
      const payload: unknown = await response.json()
      // coreOnly=true：只返回核心期刊题录（默认，与旧 ncpssd_search 工具一致）。
      records = parseNcpssdPayload(payload, { coreOnly: true, pageSize: limit }).records.slice(0, limit)
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error
      throw new ProviderUnavailableError('ncpssd', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
    return records
  }
}
