/**
 * NCPSSD 响应解析器（Phase 15 / T14-013 parser 与获取分离）。
 *
 * 纯函数：输入 NCPSSD searchHandler 的 JSON payload，输出规范化 LiteratureRecord。
 * 语义提取自旧 METIS `electron/LiteratureSearchService.ts`（T14 提取 parser）：
 * - 只保留期刊论文（type 缺失不过滤；排除年鉴/图书等边缘条目）；
 * - 高亮标签剥离、作者/标签分隔符切分、日期提取年份、data_id→文章详情 URL；
 * - 核心期刊判定委托 core-journals.isChineseCoreJournal（来源白名单，禁止模型推断）。
 */

import { isChineseCoreJournal } from './core-journals.ts'
import type { LiteratureRecord } from '../../literature/src/domain.ts'

export interface NcpssdRow {
  data_id?: unknown
  title?: unknown
  creator?: unknown
  cbw_name?: unknown
  date?: unknown
  remark?: unknown
  subject?: unknown
  type?: unknown
}

export interface NcpssdPayload {
  data?: {
    rows?: unknown
    total?: unknown
  }
}

export interface NcpssdParseResult {
  records: LiteratureRecord[]
  /** 来源报告的总条数（未过滤前）。 */
  total: number
  /** 核心过滤后的条数。 */
  coreCount: number
}

export function stripHighlight(text: string): string {
  return text.replace(/<\/?(?:font|b|em|i|span)[^>]*>/giu, '').trim()
}

export function normalizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : ''
}

/** Solr 查询词转义：剥离引号/括号/反斜杠（T14-017 query normalization）。 */
export function escapeSolrTerm(term: string): string {
  return term.replace(/["()\\]/gu, ' ').trim()
}

/** 构造 NCPSSD 检索 where 表达式（title/ik_title/ik_subject 三通道）。 */
export function buildSolrWhere(term: string): string {
  const escaped = escapeSolrTerm(term)
  return `title:("${escaped}") OR ik_title:(${escaped}) OR ik_subject:(${escaped})`
}

export function parseNcpssdPayload(
  payload: unknown,
  options: { coreOnly: boolean; pageSize: number },
): NcpssdParseResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('bad_payload: NCPSSD response is not an object')
  }
  const data = (payload as NcpssdPayload).data
  const rows = Array.isArray(data?.rows) ? (data.rows as NcpssdRow[]) : []
  const total = typeof data?.total === 'number' ? data.total : rows.length

  const records: LiteratureRecord[] = []
  let coreCount = 0
  const seen = new Set<string>()
  for (const row of rows) {
    // 只保留期刊论文（字段缺失时不过滤）；年鉴/图书等边缘条目排除。
    const rowType = String(row.type ?? '')
    if (rowType && rowType !== '中文期刊文章') continue

    const title = normalizeText(stripHighlight(String(row.title ?? '')), 500)
    if (!title) continue

    const venue = normalizeText(String(row.cbw_name ?? ''), 200)
    // 核心标记必须来自白名单（来源判定），禁止模型/代码推断（T14-015）。
    const core = venue ? isChineseCoreJournal(venue) : false
    if (options.coreOnly && !core) continue

    const dataId = normalizeText(String(row.data_id ?? ''), 100)
    const dedupeKey = dataId || title
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const dateText = String(row.date ?? '')
    const yearMatch = /(\d{4})/u.exec(dateText)
    if (core) coreCount += 1

    records.push({
      id: `ncpssd:${dataId || title.slice(0, 32)}`,
      title,
      authors: stripHighlight(String(row.creator ?? ''))
        .split(/[;；,，]/u)
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 12)
        .map((name) => ({ name })),
      year: yearMatch ? Number(yearMatch[1]) : null,
      journal: venue || undefined,
      abstract: normalizeText(stripHighlight(String(row.remark ?? '')), 1500) || undefined,
      source: 'ncpssd',
      ...(dataId ? { sourceId: dataId, url: `https://www.ncpssd.org/Literature/articleinfo?id=${encodeURIComponent(dataId)}` } : {}),
      ...(core ? { coreStatus: 'chinese-core' as const } : {}),
      keywords: stripHighlight(String(row.subject ?? '')).split(/[;；]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
    })
  }
  return { records, total, coreCount }
}

/** 构造 NCPSSD 检索请求的表单参数（HTTP 层单独实现）。 */
export function buildSearchForm(query: string, page: number, pageSize: number): Record<string, string> {
  const where = buildSolrWhere(query)
  return {
    search: where,
    pageNum: String(page),
    pageSize: String(pageSize),
    sort: 'synUpdateType|DESC,date|DESC,ik_subject|DESC,id|DESC',
    sType: '',
    ajaxKeys: '',
    customShowCondition: '',
  }
}
