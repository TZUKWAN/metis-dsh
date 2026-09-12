/**
 * 并发与隔离集成测试（指令四十七）。
 * 两个 Workspace / 两个 Session / 两个 Project 在同一数据库上交错运行，
 * 断言 Literature / Evidence / Scenario / Artifact 零交叉污染。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'

const temporaryRoots: string[] = []
const openStores: MetisDataStore[] = []

afterEach(() => {
  for (const data of openStores.splice(0)) {
    try { data.close() } catch { /* already closed */ }
  }
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function makeStore(): Promise<MetisDataStore> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-concurrency-test-'))
  temporaryRoots.push(root)
  const data = await MetisDataStore.open(path.join(root, 'metis-data', 'metis.db'))
  openStores.push(data)
  return data
}

describe('multi-workspace / multi-session concurrency isolation', () => {
  it('keeps interleaved saves strictly scoped per workspace-session-project', async () => {
    const data = await makeStore()

    const projectA = data.createProject({ title: 'A：平台劳动研究' }, 'workspace-a', 'session-a')
    const projectB = data.createProject({ title: 'B：基层治理研究' }, 'workspace-b', 'session-b')
    data.setScenarioActivation('session-a', projectA.id, 'literature-review')
    data.setScenarioActivation('session-b', projectB.id, 'paper-review')

    // 交错 + 并行写入：两个“会话”同时向各自项目保存文献。
    const recordFor = (doi: string, title: string) => ({
      id: `crossref:${doi}`, title, authors: [{ name: 'Author' }], year: 2024,
      source: 'crossref', doi,
    })
    const saves = await Promise.all([
      Promise.all([
        data.saveLiteratureWithEvidence({ record: recordFor('10.1000/aaa', 'A-paper-1'), projectId: projectA.id, createdByTool: 'literature_save' }),
        data.saveLiteratureWithEvidence({ record: recordFor('10.1000/aab', 'A-paper-2'), projectId: projectA.id, createdByTool: 'literature_save' }),
      ]),
      Promise.all([
        data.saveLiteratureWithEvidence({ record: recordFor('10.1000/bbb', 'B-paper-1'), projectId: projectB.id, createdByTool: 'literature_save' }),
        data.saveLiteratureWithEvidence({ record: recordFor('10.1000/bba', 'B-paper-2'), projectId: projectB.id, createdByTool: 'literature_save' }),
      ]),
    ])
    expect(saves.flat()).toHaveLength(4)

    // 各自的项目视图严格隔离。
    const litA = data.listLiterature(projectA.id)
    const litB = data.listLiterature(projectB.id)
    expect(litA.map((record) => record.doi).sort()).toEqual(['10.1000/aaa', '10.1000/aab'])
    expect(litB.map((record) => record.doi).sort()).toEqual(['10.1000/bba', '10.1000/bbb'])

    // Evidence 归属正确。
    for (const record of litA) {
      const evidence = data.getEvidence(record.evidenceId!)
      expect(evidence?.projectId).toBe(projectA.id)
    }
    for (const record of litB) {
      const evidence = data.getEvidence(record.evidenceId!)
      expect(evidence?.projectId).toBe(projectB.id)
    }

    // Scenario / Artifact 归属正确。
    expect(data.getScenarioActivation('session-a')?.scenarioId).toBe('literature-review')
    expect(data.getScenarioActivation('session-b')?.scenarioId).toBe('paper-review')
    const artifactA = data.registerArtifact({
      type: 'review', title: 'A review', workspacePath: 'a.md', projectId: projectA.id, source: 'dsh-workspace',
    })
    const artifactB = data.registerArtifact({
      type: 'review', title: 'B review', workspacePath: 'b.md', projectId: projectB.id, source: 'dsh-workspace',
    })
    expect(data.getArtifact(artifactA.id)?.projectId).toBe(projectA.id)
    expect(data.getArtifact(artifactB.id)?.projectId).toBe(projectB.id)

    // 跨会话读取被拒：session-a 拿不到 workspace-b 绑定的项目。
    expect(data.resolveProjectId('workspace-b', 'session-a')).toBeNull()
    expect(data.resolveProjectId('workspace-a', 'session-b')).toBeNull()
    expect(data.resolveProjectId('workspace-a', 'session-a')).toBe(projectA.id)
  })

  it('survives concurrent identical saves without duplicate rows (busy_timeout + dedupe)', async () => {
    const data = await makeStore()
    const project = data.createProject({ title: 'dedupe race' }, 'workspace-race', 'session-race')
    const record = {
      id: 'crossref:10.1000/race', title: 'Raced paper', authors: [{ name: 'X' }], year: 2024,
      source: 'crossref', doi: '10.1000/race',
    }
    const results = await Promise.all([
      data.saveLiteratureWithEvidence({ record, projectId: project.id, createdByTool: 'literature_save' }),
      data.saveLiteratureWithEvidence({ record, projectId: project.id, createdByTool: 'literature_save' }),
      data.saveLiteratureWithEvidence({ record, projectId: project.id, createdByTool: 'literature_save' }),
    ])
    const literature = data.listLiterature(project.id)
    expect(literature).toHaveLength(1)
    // 三个并发保存共享同一 Evidence（来源身份去重），不为同一来源复制证据。
    const evidence = data.queryEvidence({ projectId: project.id })
    expect(evidence).toHaveLength(1)
    expect(new Set(results.map((record) => record.id))).toHaveLength(1)
  })
})
