/**
 * Persistence vertical slice: a real Crossref response enters the same SQLite
 * transaction as the project's Literature and Evidence records, then survives
 * a close/reopen cycle. This is not a Cordis loader or Agent E2E test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'
import { CrossrefProvider } from '../../plugins/literature-crossref/src/index.ts'
import { OpenAlexProvider } from '../../plugins/literature-openalex/src/index.ts'
import { ProviderUnavailableError } from '../../plugins/literature/src/domain.ts'

const KNOWN_DOI = '10.1371/journal.pone.0000001'
const temporaryRoots: string[] = []

function temporaryDatabasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-literature-vertical-'))
  temporaryRoots.push(root)
  return path.join(root, 'metis-data', 'metis.db')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Literature/Evidence SQLite persistence vertical slice', () => {
  it('persists a real Crossref DOI as project literature and evidence across restart', async () => {
    const provider = new CrossrefProvider()
    const sourceRecord = await provider.getByDoi(KNOWN_DOI)

    expect(sourceRecord).not.toBeNull()
    expect(sourceRecord?.doi).toBe(KNOWN_DOI)
    expect(sourceRecord?.title.length).toBeGreaterThan(0)
    expect(sourceRecord?.source).toBe('crossref')

    const databasePath = temporaryDatabasePath()
    const first = await MetisDataStore.open(databasePath)
    const project = first.createProject({ title: 'Crossref persistence verification' }, 'workspace-vertical', 'session-vertical')

    const saved = first.saveLiteratureWithEvidence({
      record: sourceRecord!,
      projectId: project.id,
      createdByTool: 'literature_save',
    })

    expect(saved.projectId).toBe(project.id)
    expect(saved.evidenceId).toBeTruthy()
    expect(first.listLiterature(project.id)).toHaveLength(1)
    expect(first.queryEvidence({ doi: KNOWN_DOI })).toHaveLength(1)
    first.close()

    const reopened = await MetisDataStore.open(databasePath)
    const restoredLiterature = reopened.listLiterature(project.id)
    const restoredEvidence = reopened.queryEvidence({ doi: KNOWN_DOI })

    expect(restoredLiterature).toHaveLength(1)
    expect(restoredLiterature[0]?.id).toBe(saved.id)
    expect(restoredLiterature[0]?.evidenceId).toBe(saved.evidenceId)
    expect(restoredEvidence).toHaveLength(1)
    expect(restoredEvidence[0]?.id).toBe(saved.evidenceId)
    expect(restoredEvidence[0]?.source.provider).toBe('crossref')
    reopened.close()
  }, 40_000)

  it('either returns OpenAlex records or exposes an explicit provider failure', async () => {
    const openalex = new OpenAlexProvider()
    try {
      const records = await openalex.search({ query: 'generative artificial intelligence knowledge workers', limit: 3 })
      expect(Array.isArray(records)).toBe(true)
      for (const record of records) {
        expect(record.source).toBe('openalex')
        expect(record.title.length).toBeGreaterThan(0)
      }
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderUnavailableError)
      expect((error as ProviderUnavailableError).provider).toBe('openalex')
    }
  }, 40_000)
})
