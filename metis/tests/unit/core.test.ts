import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'

const temporaryRoots: string[] = []

function temporaryDatabasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-core-test-'))
  temporaryRoots.push(root)
  return path.join(root, 'metis.db')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('ResearchProject persistent workspace/session binding', () => {
  it('keeps Workspace A and Workspace B isolated after a database restart', async () => {
    const databasePath = temporaryDatabasePath()
    const first = await MetisDataStore.open(databasePath)
    const projectA = first.createProject(
      { title: '生成式人工智能与知识工作者职业分层', discipline: '社会学', keywords: ['生成式 AI'] },
      'workspace-a',
      'session-a',
    )
    const projectB = first.createProject(
      { title: '历史文本中的国家治理概念', discipline: '政治学', keywords: ['历史文本'] },
      'workspace-b',
      'session-b',
    )
    first.close()

    const reopened = await MetisDataStore.open(databasePath)
    expect(reopened.getCurrentProject('workspace-a', 'session-a')?.id).toBe(projectA.id)
    expect(reopened.getCurrentProject('workspace-b', 'session-b')?.id).toBe(projectB.id)
    expect(reopened.getCurrentProject('workspace-a', 'session-b')).toBeNull()
    expect(reopened.getCurrentProject('workspace-b', 'session-a')).toBeNull()
    expect(reopened.getCurrentProject('workspace-a', null)?.title).toContain('生成式人工智能')
    expect(reopened.getCurrentProject('workspace-b', null)?.title).toContain('历史文本')
    reopened.close()
  })

  it('updates only the current project without losing prior known fields', async () => {
    const store = await MetisDataStore.open(temporaryDatabasePath())
    const project = store.createProject({ title: '原始题目', discipline: '社会学' }, 'workspace-a', 'session-a')
    const updated = store.updateProject(project.id, { researchQuestion: 'AI 如何重塑职业边界？' })
    expect(updated).toMatchObject({
      id: project.id,
      title: '原始题目',
      discipline: '社会学',
      researchQuestion: 'AI 如何重塑职业边界？',
    })
    store.close()
  })
})
