/**
 * NCPSSD provider smoke plus real SQLite evidence persistence. A network block
 * is accepted only when the provider reports its fail-loud domain error.
 *
 * @vitest-environment node
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'
import { NcpssdProvider } from '../../plugins/literature-ncpssd/src/index.ts'
import { parseNcpssdPayload } from '../../plugins/literature-ncpssd/src/ncpssd-parser.ts'

const temporaryRoots: string[] = []

function temporaryDatabasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-ncpssd-live-'))
  temporaryRoots.push(root)
  return path.join(root, 'metis-data', 'metis.db')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('NcpssdProvider live smoke', () => {
  it('returns real Chinese records or fails loud, then persists a returned record in SQLite', async () => {
    const provider = new NcpssdProvider()
    try {
      const records = await provider.search({ query: '劳动过程理论', limit: 10 })
      expect(Array.isArray(records)).toBe(true)
      for (const record of records) {
        expect(record.source).toBe('ncpssd')
        expect(record.title.length).toBeGreaterThan(0)
        if (record.coreStatus === 'chinese-core') expect(record.journal).toBeTruthy()
      }

      if (records[0]) {
        const store = await MetisDataStore.open(temporaryDatabasePath())
        const project = store.createProject({ title: 'NCPSSD SQLite smoke' })
        const saved = store.saveLiteratureWithEvidence({
          record: records[0],
          projectId: project.id,
          createdByTool: 'literature_save',
        })
        expect(saved.evidenceId).toBeTruthy()
        expect(store.queryEvidence({ projectId: project.id })).toHaveLength(1)
        store.close()
      }
    } catch (error) {
      const failureNote = error instanceof Error ? error.message : String(error)
      expect(failureNote).toContain('ncpssd')
    }
  }, 40_000)

  it('parses a real-shaped payload end to end', () => {
    const payload = {
      data: {
        total: 1,
        rows: [{
          data_id: '70001234',
          title: '<font class="highLight">数字劳动</font>研究综述',
          creator: '张三',
          cbw_name: '新闻与传播研究',
          date: '2022-10-01',
          remark: '综述数字劳动研究。',
          subject: '传播学',
          type: '中文期刊文章',
        }],
      },
    }
    const result = parseNcpssdPayload(payload, { coreOnly: false, pageSize: 10 })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.title).toBe('数字劳动研究综述')
  })
})
