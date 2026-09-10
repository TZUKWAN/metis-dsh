/**
 * OpenAlex Literature Provider（Phase 13 / T13）。
 * 领域逻辑提取自旧 METIS `engine/research/OpenAlexClient.ts`（摘要倒排重建、
 * 检索参数、字段语义保持一致），按 LiteratureProvider 契约重写，fail-loud。
 */

import {
  normalizeDoi,
  ProviderUnavailableError,
  type LiteratureProvider,
  type LiteratureRecord,
  type LiteratureSearchOptions,
} from 'dsh-metis-literature'

const BASE_URL = 'https://api.openalex.org/works'
const DEFAULT_TIMEOUT_MS = 20_000
const MAILTO = 'metis-workbench@local'

interface OpenAlexWork {
  id?: string
  doi?: string
  title?: string
  display_name?: string
  authorships?: Array<{ author?: { display_name?: string } }>
  publication_year?: number
  primary_location?: { source?: { display_name?: string } }
  abstract_inverted_index?: Record<string, number[]>
  cited_by_count?: number
}

function reconstructAbstract(invertedIndex: Record<string, number[]> | undefined): string | undefined {
  if (!invertedIndex || Object.keys(invertedIndex).length === 0) return undefined
  const tokens: Array<{ position: number; word: string }> = []
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) tokens.push({ position, word })
  }
  tokens.sort((a, b) => a.position - b.position)
  return tokens.map((token) => token.word).join(' ') || undefined
}

export function openalexWorkToRecord(work: OpenAlexWork): LiteratureRecord {
  const doiRaw = typeof work.doi === 'string' ? work.doi.replace(/^https?:\/\/doi\.org\//i, '') : undefined
  const doi = normalizeDoi(doiRaw)
  return {
    id: `openalex:${work.id ?? doi ?? crypto.randomUUID()}`,
    title: work.display_name ?? work.title ?? doi ?? '(untitled)',
    authors: (work.authorships ?? [])
      .map((authorship) => authorship.author?.display_name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ name })),
    year: typeof work.publication_year === 'number' ? work.publication_year : null,
    journal: work.primary_location?.source?.display_name,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    ...(doi ? { doi } : {}),
    source: 'openalex',
    ...(typeof work.id === 'string' ? { sourceId: work.id } : {}),
    ...(typeof work.cited_by_count === 'number' ? { citationCount: work.cited_by_count } : {}),
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
    if (response.status === 429 || response.status === 403) throw new ProviderUnavailableError('openalex', `rate_limited(${response.status})`)
    if (response.status >= 500) throw new ProviderUnavailableError('openalex', `server_error(${response.status})`)
    if (!response.ok) throw new ProviderUnavailableError('openalex', `http_${response.status}`)
    return await response.json()
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error
    throw new ProviderUnavailableError('openalex', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

export class OpenAlexProvider implements LiteratureProvider {
  readonly name = 'openalex'
  readonly capabilities = { search: true, getByDoi: true }
  private readonly timeoutMs: number

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  async search(options: LiteratureSearchOptions): Promise<LiteratureRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
    const url = new URL(BASE_URL)
    url.searchParams.set('search', options.query)
    url.searchParams.set('per-page', String(limit))
    url.searchParams.set('mailto', MAILTO)
    const data = await fetchJson(url.toString(), this.timeoutMs, options.signal) as { results?: OpenAlexWork[] }
    return (data.results ?? []).map(openalexWorkToRecord)
  }

  async getByDoi(doi: string, signal?: AbortSignal): Promise<LiteratureRecord | null> {
    const normalized = normalizeDoi(doi)
    if (!normalized) return null
    try {
      const data = await fetchJson(`${BASE_URL}/doi:${normalized}?mailto=${MAILTO}`, this.timeoutMs, signal) as OpenAlexWork
      if (!data || typeof data !== 'object') return null
      return openalexWorkToRecord(data)
    } catch (error) {
      if (error instanceof ProviderUnavailableError && error.cause2 === 'http_404') return null
      throw error
    }
  }
}
