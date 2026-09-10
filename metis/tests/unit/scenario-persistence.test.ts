import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'

const temporaryRoots: string[] = []

function temporaryDatabasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scenario-test-'))
  temporaryRoots.push(root)
  return path.join(root, 'metis-data', 'metis.db')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Scenario activation persistence', () => {
  it('isolates activations by DSH session and restores them after restart', async () => {
    const databasePath = temporaryDatabasePath()
    const first = await MetisDataStore.open(databasePath)
    const projectA = first.createProject({ title: 'Literature review project' }, 'workspace-a', 'session-a')
    const projectB = first.createProject({ title: 'Paper review project' }, 'workspace-b', 'session-b')

    first.setScenarioActivation('session-a', projectA.id, 'literature-review')
    first.setScenarioActivation('session-b', projectB.id, 'paper-review')
    expect(first.getScenarioActivation('session-a')?.scenarioId).toBe('literature-review')
    expect(first.getScenarioActivation('session-b')?.scenarioId).toBe('paper-review')
    first.close()

    const reopened = await MetisDataStore.open(databasePath)
    expect(reopened.getScenarioActivation('session-a')).toMatchObject({
      sessionId: 'session-a', projectId: projectA.id, scenarioId: 'literature-review',
    })
    expect(reopened.getScenarioActivation('session-b')).toMatchObject({
      sessionId: 'session-b', projectId: projectB.id, scenarioId: 'paper-review',
    })
    expect(reopened.getScenarioActivation('unknown-session')).toBeNull()
    expect(reopened.clearScenarioActivation('session-a')).toBe(true)
    expect(reopened.getScenarioActivation('session-a')).toBeNull()
    expect(reopened.getScenarioActivation('session-b')?.scenarioId).toBe('paper-review')
    reopened.close()
  })
})
