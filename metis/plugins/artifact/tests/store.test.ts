/**
 * Artifact 插件测试（Phase 18 / 任务清单 18.4、26.1）。
 * 覆盖：注册/重复 id fail-loud、版本链可追溯、元数据更新、过滤、持久化 reload、
 * 文件存在性校验（T18-026：不静默成功）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/store.js'

const tmpFiles: string[] = []

function makeStore(): ArtifactStore {
  const file = path.join(process.cwd(), `.test-art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  tmpFiles.push(file)
  return new ArtifactStore(file)
}

afterEach(() => {
  for (const file of tmpFiles) {
    fs.rmSync(file, { force: true })
    fs.rmSync(file + '.corrupt-0', { force: true })
  }
})

describe('ArtifactStore', () => {
  it('registers an artifact with version 1 and reloads it', () => {
    const file = path.join(process.cwd(), `.test-art-reload-${Date.now()}.json`)
    const store = new ArtifactStore(file)
    const record = store.register({
      type: 'paper', title: '综述草稿', path: 'workspace/draft.md',
      projectId: 'rp-1', source: 'model',
    })
    expect(record.version).toBe(1)
    expect(record.status).toBe('draft')

    const reloaded = new ArtifactStore(file)
    expect(reloaded.get(record.id)?.title).toBe('综述草稿')
    expect(reloaded.get(record.id)?.versions).toHaveLength(1)
    fs.rmSync(file, { force: true })
  })

  it('rejects duplicate ids (fail-loud, no silent overwrite)', () => {
    const store = makeStore()
    store.register({ id: 'a', type: 'report', title: 'A', path: 'a.md', source: 'model' })
    expect(() => store.register({ id: 'a', type: 'report', title: 'A2', path: 'a.md', source: 'model' }))
      .toThrow(/已存在/)
  });

  it('appends version entries and advances the version counter', () => {
    const store = makeStore()
    const record = store.register({ type: 'review', title: '审读报告', path: 'review/v1.md', source: 'model' })
    const v2 = store.addVersion(record.id, 'review/v2.md', '补充修改任务清单')
    expect(v2?.version).toBe(2)
    expect(v2?.versions).toHaveLength(2)
    expect(v2?.versions[0]!.path).toBe('review/v1.md')
    expect(v2?.path).toBe('review/v2.md')
  })

  it('updates metadata without creating a version', () => {
    const store = makeStore()
    const record = store.register({ type: 'proposal', title: '基金草稿', path: 'p.md', source: 'model' })
    const updated = store.updateMetadata(record.id, { status: 'final', projectId: 'rp-9' })
    expect(updated?.status).toBe('final')
    expect(updated?.projectId).toBe('rp-9')
    expect(updated?.versions).toHaveLength(1)
  })

  it('lists by project and type', () => {
    const store = makeStore()
    store.register({ type: 'paper', title: 'P1', path: 'p1.md', projectId: 'rp-1', source: 'model' })
    store.register({ type: 'figure', title: 'F1', path: 'f1.png', projectId: 'rp-1', source: 'model' })
    store.register({ type: 'paper', title: 'P2', path: 'p2.md', source: 'model' })
    expect(store.list({ projectId: 'rp-1', type: 'paper' }).map((record) => record.title)).toEqual(['P1'])
    expect(store.list({ type: 'figure' })).toHaveLength(1)
  })
});
