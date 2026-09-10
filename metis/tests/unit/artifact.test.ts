import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'

const temporaryRoots: string[] = []

function temporaryDatabasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-artifact-test-'))
  temporaryRoots.push(root)
  return path.join(root, 'metis-data', 'metis.db')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Artifact SQLite persistence', () => {
  it('persists append-only versions and evidence links across restart', async () => {
    const databasePath = temporaryDatabasePath()
    const first = await MetisDataStore.open(databasePath)
    const project = first.createProject({ title: 'Artifact persistence' }, 'workspace-artifact', 'session-artifact')
    const evidence = first.registerEvidence({
      projectId: project.id,
      sourceType: 'literature',
      source: { provider: 'crossref', sourceId: 'work-1', url: 'https://doi.org/10.1000/example' },
      title: 'Traceable source',
      doi: '10.1000/example',
      createdByTool: 'literature_save',
    }).record

    const artifact = first.registerArtifact({
      type: 'review',
      title: 'Literature review draft',
      workspacePath: 'outputs/review-v1.md',
      projectId: project.id,
      source: 'dsh-workspace',
      note: 'initial draft',
      evidenceIds: [evidence.id],
    })
    const versioned = first.addArtifactVersion(artifact.id, 'outputs/review-v2.md', 'add limitations')

    expect(versioned?.version).toBe(2)
    expect(versioned?.versions).toHaveLength(2)
    expect(versioned?.evidenceIds).toEqual([evidence.id])
    first.close()

    const reopened = await MetisDataStore.open(databasePath)
    const restored = reopened.getArtifact(artifact.id)
    expect(restored?.projectId).toBe(project.id)
    expect(restored?.workspacePath).toBe('outputs/review-v2.md')
    expect(restored?.versions).toEqual([
      expect.objectContaining({ version: 1, workspacePath: 'outputs/review-v1.md', note: 'initial draft' }),
      expect.objectContaining({ version: 2, workspacePath: 'outputs/review-v2.md', note: 'add limitations' }),
    ])
    expect(restored?.evidenceIds).toEqual([evidence.id])
    reopened.close()
  })

  it('rejects Artifact references to unknown evidence instead of persisting a partial record', async () => {
    const store = await MetisDataStore.open(temporaryDatabasePath())
    const project = store.createProject({ title: 'Artifact validation' })

    expect(() => store.registerArtifact({
      type: 'paper',
      title: 'Unlinked artifact',
      workspacePath: 'paper.md',
      projectId: project.id,
      source: 'dsh-workspace',
      evidenceIds: ['ev-does-not-exist'],
    })).toThrow(/unknown evidence/)
    expect(store.listArtifacts({ projectId: project.id })).toHaveLength(0)
    store.close()
  })
})
