/**
 * Literature Provider 注册表（Phase 11 / T11-019~027）。
 * - 同名 provider 拒绝重复注册（T11-021）；
 * - merge 按 DOI 优先去重（T11-026）：无 DOI 时使用 provider+sourceId 严格回退，
 *   不把标题相似当同一篇。
 */

import { normalizeDoi, type LiteratureProvider, type LiteratureRecord } from './domain.js'

function dedupeKey(record: LiteratureRecord): string | null {
  const doi = normalizeDoi(record.doi)
  if (doi) return `doi:${doi}`
  if (record.source && record.sourceId) return `src:${record.source}:${record.sourceId}`
  return null
}

export class LiteratureRegistry {
  private readonly providers = new Map<string, LiteratureProvider>()

  registerProvider(provider: LiteratureProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Literature provider "${provider.name}" 已注册（T11-021：拒绝同名重复注册）。`)
    }
    this.providers.set(provider.name, provider)
  }

  unregisterProvider(name: string): boolean {
    return this.providers.delete(name)
  }

  getProviderNames(): string[] {
    return [...this.providers.keys()]
  }

  getProvider(name: string): LiteratureProvider | undefined {
    return this.providers.get(name)
  }

  /** 选择要使用的 provider；未指定且无法解析时抛错（fail-loud）。 */
  resolveProviders(filter?: string[]): LiteratureProvider[] {
    if (!filter || filter.length === 0) {
      const all = [...this.providers.values()]
      if (all.length === 0) throw new Error('没有任何已注册的 literature provider。请安装 literature-crossref / literature-openalex 等插件。')
      return all
    }
    const resolved = filter
      .map((name) => this.providers.get(name))
      .filter((provider): provider is LiteratureProvider => provider !== undefined)
    if (resolved.length === 0) {
      throw new Error(`指定的 provider 不存在：${filter.join(', ')}。可用：${[...this.providers.keys()].join(', ') || '（无）'}。`)
    }
    return resolved
  }

  /** 合并多 provider 检索结果：按去重键保序去重（DOI 优先）。 */
  merge(records: LiteratureRecord[]): LiteratureRecord[] {
    const seen = new Set<string>()
    const output: LiteratureRecord[] = []
    for (const record of records) {
      const key = dedupeKey(record)
      if (key === null) {
        // 无任何稳定标识：保留（真实来源的记录至少有 source+sourceId 或 DOI 之一）。
        output.push(record)
        continue
      }
      if (seen.has(key)) continue
      seen.add(key)
      output.push(record)
    }
    return output
  }
}
