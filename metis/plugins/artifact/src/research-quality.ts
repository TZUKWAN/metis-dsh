/**
 * Research Quality Guard（总提示词 五十八/五十九）。
 *
 * 对 Artifact 当前版本文件做第一版**结构性**质量检查：
 * - 引用候选提取（DOI / 作者-年份）并与项目文献库比对 → verified-in-library / unverified-citation；
 * - 未解决占位符检测（待核验/待补充/TODO/占位等）；
 * - 结构完整性（研究问题/文献/理论/争议/缺口/研究设计 标题覆盖）。
 *
 * 原则：结构规则 + 证据比对，不用 LLM Judge 直接判 PASS；结果以 warnings 形式
 * 供 finalize 门与模型参考，不静默放行也不武断拒绝。
 */

export interface CitationCandidate {
  readonly kind: 'doi' | 'author-year'
  readonly raw: string
  readonly doi?: string
}

export interface QualityIssue {
  readonly severity: 'critical' | 'warning'
  readonly kind: 'placeholder' | 'unverified-citation' | 'missing-section' | 'empty-document'
  readonly message: string
  readonly detail?: string
}

export interface ResearchQualityReport {
  readonly wordCount: number
  readonly citationCandidates: CitationCandidate[]
  readonly doisInLibrary: string[]
  readonly doisUnverified: string[]
  readonly criticalPlaceholders: string[]
  readonly missingSections: string[]
  readonly issues: QualityIssue[]
}

/** DOI 形态（官方 crossref recommended regex，宽松化尾字符）。 */
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g

/** 作者-年份引用形态：李四（2024）、(Smith, 2023)、Smith et al., 2022。 */
const AUTHOR_YEAR_PATTERN = /([(（][A-Za-z\u4e00-\u9fa5][^()（）]{0,40}?,\s*(19|20)\d{2}[)）])|([\u4e00-\u9fa5]{2,6}（(19|20)\d{2}）)/g

/** 常见未解决占位符标记。 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /待核验/g,
  /待补充/g,
  /待确认/g,
  /TODO\b/g,
  /XXX\b/g,
  /（在此填写[^）]*）/g,
  /【占位/g,
]

/** 综述/论文类成果期望覆盖的结构主题（按标题文本匹配，缺项报 warning）。 */
const EXPECTED_SECTIONS: ReadonlyArray<{ key: string; patterns: ReadonlyArray<RegExp> }> = [
  { key: '研究问题', patterns: [/研究问题/, /研究背景/] },
  { key: '文献综述', patterns: [/文献/, /研究现状/, /文献综述/] },
  { key: '理论', patterns: [/理论/, /概念/, /框架/] },
  { key: '争议', patterns: [/争议/, /分歧/, /不同观点/, /争论/] },
  { key: '研究缺口', patterns: [/缺口/, /不足/, /未解决/] },
]

export function extractCitationCandidates(text: string): CitationCandidate[] {
  const candidates: CitationCandidate[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(DOI_PATTERN)) {
    const doi = match[0].replace(/[.,;]$/, '').toLowerCase()
    if (seen.has(doi)) continue
    seen.add(doi)
    candidates.push({ kind: 'doi', raw: match[0], doi })
  }
  for (const match of text.matchAll(AUTHOR_YEAR_PATTERN)) {
    const raw = match[0]
    if (seen.has(raw)) continue
    seen.add(raw)
    candidates.push({ kind: 'author-year', raw })
  }
  return candidates
}

export function findPlaceholders(text: string): string[] {
  const found: string[] = []
  for (const pattern of PLACEHOLDER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[0])
    }
  }
  return [...new Set(found)]
}

export function findMissingSections(text: string): string[] {
  const lowered = text.toLowerCase()
  return EXPECTED_SECTIONS
    .filter((section) => !section.patterns.some((pattern) => pattern.test(lowered)))
    .map((section) => section.key)
}

/**
 * 汇总结构化质量报告。`libraryDois` 是当前项目文献库中已核验的 DOI 集合
 * （小写规范化）；正文出现的 DOI 不在库中即记为 unverified-citation（warning），
 * 不武断判定幻觉——但 finalize 门会把未解决项作为 warnings 透出。
 */
export function buildResearchQualityReport(input: {
  text: string
  libraryDois: ReadonlySet<string>
  expectStructure?: boolean
}): ResearchQualityReport {
  const text = input.text ?? ''
  const wordCount = text.replace(/\s/g, '').length
  const citationCandidates = extractCitationCandidates(text)
  const doisInLibrary: string[] = []
  const doisUnverified: string[] = []
  for (const candidate of citationCandidates) {
    if (candidate.kind !== 'doi' || candidate.doi === undefined) continue
    if (input.libraryDois.has(candidate.doi)) doisInLibrary.push(candidate.doi)
    else doisUnverified.push(candidate.doi)
  }
  const criticalPlaceholders = findPlaceholders(text)
  const missingSections = input.expectStructure === false ? [] : findMissingSections(text)

  const issues: QualityIssue[] = []
  if (wordCount < 20) {
    issues.push({ severity: 'critical', kind: 'empty-document', message: '成果文本为空或过短，无法作为正式成果。' })
  }
  for (const placeholder of criticalPlaceholders) {
    issues.push({ severity: 'critical', kind: 'placeholder', message: `存在未解决占位符: ${placeholder}` })
  }
  for (const doi of doisUnverified) {
    issues.push({
      severity: 'warning',
      kind: 'unverified-citation',
      message: `DOI 不在项目文献库中（未核验）: ${doi}`,
      detail: '请先通过 literature_get/literature_save 核验并保存，再作为正式引用。',
    })
  }
  for (const section of missingSections) {
    issues.push({ severity: 'warning', kind: 'missing-section', message: `未检测到「${section}」相关内容` })
  }
  return {
    wordCount,
    citationCandidates,
    doisInLibrary,
    doisUnverified,
    criticalPlaceholders,
    missingSections,
    issues,
  }
}

/** finalize 门：critical 问题清单（空文档、未解决占位符）。 */
export function criticalIssues(report: ResearchQualityReport): QualityIssue[] {
  return report.issues.filter((issue) => issue.severity === 'critical')
}
