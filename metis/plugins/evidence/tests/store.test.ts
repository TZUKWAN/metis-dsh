/**
 * EvidenceStore 单元测试（Phase 10 / 任务清单 10.4）。
 * 覆盖：登记与去重（T10-031）、验证生命周期、查询、持久化 reload（T10-034）、
 * 无效文件的处理。
 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvidenceStore } from '../src/store.js'

const tmpFiles: string[] = []

function makeStore(): EvidenceStore {
  const file = path.join(process.cwd(), `.test-evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  tmpFiles.push(file)
  return new EvidenceStore(file)
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    for (const suffix of ['', '.corrupt-0']) fs.rmSync(file + suffix, { force: true })
    for (const file2 of tmpFiles) fs.rmSync(file2, { force: true })
  }
  // 粗清理：按前缀删除本测试产生的临时文件。
  for (const file of tmpFiles) fs.rmSync(file, { force: true })
})

describe('EvidenceStore', () => {
  it('registers an observation as unverified and persists it across reload', () => {
    const file = path.join(process.cwd(), `.test-ev-reload-${Date.now()}.json`)
    const store = new EvidenceStore(file)

    const { record, duplicate } = store.registerObservation({
      projectId: 'rp-1',
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: '10.1000/test' },
      title: '某研究发现 AI 对低经验员工生产率提升更明显',
      doi: '10.1000/test',
      createdByTool: 'literature_search',
    })
    expect(duplicate).toBe(false)
    expect(record.verificationState).toBe('unverified')

    // 新实例 = 重启后 reload（T10-034）。
    const reloaded = new EvidenceStore(file)
    expect(reloaded.get(record.id)?.title).toBe(record.title)
    expect(reloaded.queryByProject('rp-1')).toHaveLength(1)
    fs.rmSync(file, { force: true })
  })

  it('deduplicates by DOI regardless of prefix casing and does not double-register', () => {
    const store = makeStore()
    store.registerObservation({
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: '10.1000/Dup' },
      title: 'A',
      doi: 'https://doi.org/10.1000/DUP',
      createdByTool: 'test',
    })
    const second = store.registerObservation({
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: '10.1000/dup' },
      title: 'A（重复尝试）',
      doi: '10.1000/dup',
      createdByTool: 'test',
    })
    expect(second.duplicate).toBe(true)
    expect(store.queryByDoi('10.1000/dup')).toHaveLength(1)
  })

  it('treats records without DOI or URL as distinct by provider+sourceId+title', () => {
    const store = makeStore()
    store.registerObservation({
      sourceType: 'web_page',
      source: { provider: 'user', sourceId: 'page-1' },
      title: '期刊官网投稿要求',
      createdByTool: 'test',
    })
    const again = store.registerObservation({
      sourceType: 'web_page',
      source: { provider: 'user', sourceId: 'page-1' },
      title: '期刊官网投稿要求',
      createdByTool: 'test',
    })
    expect(again.duplicate).toBe(true)
  })

  it('supports the verification lifecycle transitions', () => {
    const store = makeStore()
    const { record } = store.registerObservation({
      sourceType: 'literature',
      source: { provider: 'openalex', sourceId: 'w1' },
      title: 'Claim',
      createdByTool: 'test',
    })
    expect(store.verify(record.id)?.verificationState).toBe('verified')
    expect(store.markConflict(record.id)?.verificationState).toBe('conflicted')
    expect(store.markStale(record.id)?.verificationState).toBe('stale')
    expect(store.reject(record.id)?.verificationState).toBe('rejected')
  })

  it('truncates oversized observations with a truncated marker', () => {
    const store = makeStore()
    const { record } = store.registerObservation({
      sourceType: 'file',
      source: { provider: 'user', sourceId: 'big' },
      title: '大观察',
      observation: 'x'.repeat(5_000),
      createdByTool: 'test',
    })
    expect(record.truncated).toBe(true)
    expect((record.observation ?? '').length).toBe(4_000)
  })

  it('quarantines a corrupt store file instead of crashing on reload', () => {
    const file = path.join(process.cwd(), `.test-ev-corrupt-${Date.now()}.json`)
    fs.writeFileSync(file, '{ not valid json', 'utf8')
    const store = new EvidenceStore(file)
    expect(store.all()).toHaveLength(0)
    // 损坏文件被备份保留（不静默销毁原始记录）。
    const quarantined = fs.readdirSync(process.cwd()).filter((name) => name.startsWith(path.basename(file) + '.corrupt-'))
    expect(quarantined.length).toBeGreaterThan(0)
    for (const name of quarantined) fs.rmSync(path.join(process.cwd(), name), { force: true })
    fs.rmSync(file, { force: true })
  })
})
