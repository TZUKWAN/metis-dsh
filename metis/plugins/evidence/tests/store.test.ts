/**
 * EvidenceStore 单元测试（SQLite 形态）。
 * 覆盖：登记与去重、验证生命周期、查询、持久化 reload、超长截断、
 * 损坏数据库 fail-loud（不静默吞掉原始数据）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../../shared/data/src/index.ts'
import { EvidenceStore } from '../src/store.js'

const temporaryRoots: string[] = []
const openStores: MetisDataStore[] = []

async function makeStore(): Promise<{ store: EvidenceStore; data: MetisDataStore; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-evidence-test-'))
  temporaryRoots.push(root)
  const databasePath = path.join(root, 'metis-data', 'metis.db')
  const data = await MetisDataStore.open(databasePath)
  openStores.push(data)
  return { store: new EvidenceStore(data), data, root }
}

async function reopenStore(root: string): Promise<EvidenceStore> {
  const databasePath = path.join(root, 'metis-data', 'metis.db')
  const data = await MetisDataStore.open(databasePath)
  openStores.push(data)
  return new EvidenceStore(data)
}

afterEach(() => {
  for (const data of openStores.splice(0)) {
    try { data.close() } catch { /* already closed */ }
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('EvidenceStore', () => {
  it('registers an observation as unverified and persists it across reload', async () => {
    const { store, data, root } = await makeStore()
    const project = data.createProject({ title: 'Evidence lifecycle' })

    const { record, duplicate } = store.registerObservation({
      projectId: project.id,
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: '10.1000/test' },
      title: '某研究发现 AI 对低经验员工生产率提升更明显',
      doi: '10.1000/test',
      createdByTool: 'literature_search',
    })
    expect(duplicate).toBe(false)
    expect(record.verificationState).toBe('unverified')

    // 新实例 = 重启后 reload。
    const reloaded = await reopenStore(root)
    expect(reloaded.get(record.id)?.title).toBe(record.title)
    expect(reloaded.queryByProject(project.id)).toHaveLength(1)
  })

  it('deduplicates by DOI regardless of prefix casing or title wording', async () => {
    const { store } = await makeStore()
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

  it('keeps distinct sources apart even when titles match', async () => {
    const { store } = await makeStore()
    store.registerObservation({
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: 'work-a' },
      title: 'Same title',
      doi: '10.1000/aaa',
      createdByTool: 'test',
    })
    const second = store.registerObservation({
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: 'work-b' },
      title: 'Same title',
      doi: '10.1000/bbb',
      createdByTool: 'test',
    })
    expect(second.duplicate).toBe(false)
    expect(store.all()).toHaveLength(2)
  })

  it('treats records without DOI or URL as distinct by provider+sourceId+title', async () => {
    const { store } = await makeStore()
    const input = {
      sourceType: 'web_page' as const,
      source: { provider: 'user', sourceId: 'page-1' },
      title: '期刊官网投稿要求',
      createdByTool: 'test',
    }
    store.registerObservation(input)
    const again = store.registerObservation(input)
    expect(again.duplicate).toBe(true)
  })

  it('supports the verification lifecycle transitions', async () => {
    const { store } = await makeStore()
    const { record } = store.registerObservation({
      sourceType: 'literature',
      source: { provider: 'openalex', sourceId: 'w1' },
      title: 'Claim',
      createdByTool: 'test',
    })
    expect(store.verify(record.id)?.verificationState).toBe('verified')
    expect(store.markConflict(record.id)?.verificationState).toBe('conflicting')
    expect(store.markStale(record.id)?.verificationState).toBe('stale')
    expect(store.reject(record.id)?.verificationState).toBe('invalid')
  })

  it('truncates oversized observations with a truncated marker', async () => {
    const { store } = await makeStore()
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

  it('fails loud on a corrupt database file instead of inventing an empty store', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-evidence-corrupt-'))
    temporaryRoots.push(root)
    const databasePath = path.join(root, 'metis-data', 'metis.db')
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    fs.writeFileSync(databasePath, 'this is not a sqlite database', 'utf8')

    await expect(MetisDataStore.open(databasePath)).rejects.toThrow()
    // 原始字节保持原样（不静默销毁或伪装成空库）。
    expect(fs.readFileSync(databasePath, 'utf8')).toBe('this is not a sqlite database')
  })
})
