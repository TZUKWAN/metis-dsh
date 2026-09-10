/**
 * Crossref Literature Provider（Phase 12 / T12）。
 *
 * 领域逻辑提取自旧 METIS `engine/research/CrossrefClient.ts`（normalize/字段提取
 * 语义保持一致），按 LiteratureProvider 契约重写。与 legacy 的差异：
 * - 失败 fail-loud（ProviderUnavailableError），不再静默返回空结果；
 * - timeout + 可取消（exec.signal 经调用方传入）；
 * - 不把 Crossref 之外的信息伪装成 Crossref 返回（T12-020）。
 */

import {
  normalizeDoi,
  ProviderUnavailableError,
  type LiteratureProvider,
  type LiteratureRecord,
  type LiteratureSearchOptions,
} from 'dsh-metis-literature'

const BASE_URL = 'https://api.crossref.org/works'
const DEFAULT_TIMEOUT_MS = 20_000

interface CrossrefWork {
  DOI?: string
  title?: unknown
  author?: Array<{ name?: string; given?: string; family?: string }>
  'container-title'?: unknown
  abstract?: unknown
  URL?: string
  issued?: { 'date-parts'?: number[][] }
  'is-referenced-by-count'?: number
}

function extractYear(work: CrossrefWork): number | null {
  const parts = work.issued?.['date-parts']?.[0]
  if (Array.isArray(parts) && typeof parts[0] === 'number') return parts[0]
  return null
}

function extractTitle(work: CrossrefWork): string {
  if (Array.isArray(work.title) && typeof work.title[0] === 'string') return work.title[0]
  return ''
}

function extractAuthors(work: CrossrefWork): Array<{ name: string }> {
  if (!Array.isArray(work.author)) return []
  return work.author
    .map((author) => {
      if (typeof author.name === 'string') return { name: author.name.trim() }
      const parts = [author.given, author.family].filter((part): part is string => typeof part === 'string' && part.length > 0)
      const name = parts.join(' ').trim()
      return name ? { name } : null
    })
    .filter((item): item is { name: string } => item !== null)
}

function extractVenue(work: CrossrefWork): string | undefined {
  if (Array.isArray(work['container-title']) && typeof work['container-title'][0] === 'string') {
    return work['container-title'][0]
  }
  return undefined
}

function extractAbstract(work: CrossrefWork): string | undefined {
  if (typeof work.abstract !== 'string') return undefined
  // Crossref 摘要可能带 JATS XML 标签——轻剥离。
  return work.abstract
    .replace(/<\/?jats:[^>]+>/gi, '')
    .replace(/<\/?[^>]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim() || undefined
}

export function crossrefWorkToRecord(work: CrossrefWork): LiteratureRecord {
  const doi = normalizeDoi(work.DOI)
  return {
    id: `crossref:${doi ?? crypto.randomUUID()}`,
    title: extractTitle(work) || doi || '(untitled)',
    authors: extractAuthors(work),
    year: extractYear(work),
    journal: extractVenue(work),
    abstract: extractAbstract(work),
    ...(doi ? { doi } : {}),
    ...(typeof work.URL === 'string' ? { url: work.URL } : {}),
    source: 'crossref',
    ...(typeof work['is-referenced-by-count'] === 'number' ? { citationCount: work['is-referenced-by-count'] } : {}),
  }
}

async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 429) throw new ProviderUnavailableError('crossref', 'rate_limited(429)')
    if (response.status >= 500) throw new ProviderUnavailableError('crossref', `server_error(${response.status})`)
    if (!response.ok) throw new ProviderUnavailableError('crossref', `http_${response.status}`)
    return await response.json()
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error
    throw new ProviderUnavailableError('crossref', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

export class CrossrefProvider implements LiteratureProvider {
  readonly name = 'crossref'
  readonly capabilities = { search: true, getByDoi: true }
  private readonly timeoutMs: number

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  async search(options: LiteratureSearchOptions): Promise<LiteratureRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
    const url = new URL(BASE_URL)
    url.searchParams.set('query', options.query)
    url.searchParams.set('rows', String(limit))
    url.searchParams.set('select', 'DOI,title,author,container-title,abstract,URL,issued,is-referenced-by-count')
    const data = await fetchJson(url.toString(), this.timeoutMs, options.signal) as { message?: { items?: CrossrefWork[] } }
    return (data.message?.items ?? []).map(crossrefWorkToRecord)
  }

  async getByDoi(doi: string, signal?: AbortSignal): Promise<LiteratureRecord | null> {
    const normalized = normalizeDoi(doi)
    if (!normalized) return null
    try {
      const data = await fetchJson(`${BASE_URL}/${normalized}`, this.timeoutMs, signal) as { message?: CrossrefWork }
      if (!data.message) return null
      return crossrefWorkToRecord(data.message)
    } catch (error) {
      if (error instanceof ProviderUnavailableError && error.cause2 === 'http_404') return null
      throw error
    }
  }
}

export default {
  name: 'metis-literature-crossref',
  inject: ['metisLiterature'],
  apply(ctx: import('@deepseek-ai/cordis').Context): void {
    ctx.metisLiterature.registry.registerProvider(new CrossrefProvider())
  },
}
