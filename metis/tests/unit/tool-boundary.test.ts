/**
 * 工具边界与错误契约测试（指令九~十三）。
 * 覆盖：contracts 归一化助手、数据层引用完整性校验、错误契约形态。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MetisDataStore } from '../../shared/data/src/index.ts'
import {
  metisError,
  normalizeJsonArrayArg,
  normalizeJsonRecordArg,
  requireStringArg,
} from '../../shared/contracts/src/index.ts'

const temporaryRoots: string[] = []
const openStores: MetisDataStore[] = []

async function makeStore(): Promise<MetisDataStore> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-boundary-test-'))
  temporaryRoots.push(root)
  const data = await MetisDataStore.open(path.join(root, 'metis-data', 'metis.db'))
  openStores.push(data)
  return data
}

afterEach(() => {
  for (const data of openStores.splice(0)) {
    try { data.close() } catch { /* already closed */ }
  }
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('contracts: boundary normalization', () => {
  it('normalizes JSON-string encoded objects (observed model behavior)', () => {
    expect(normalizeJsonRecordArg('{"a":1}', 'x')).toEqual({ a: 1 })
    expect(normalizeJsonArrayArg('{"a":1}', 'x')).toEqual([{ a: 1 }])
    expect(normalizeJsonArrayArg([{ a: 1 }], 'x')).toEqual([{ a: 1 }])
  })

  it('fails loud on malformed JSON strings and wrong shapes', () => {
    expect(() => normalizeJsonRecordArg('{broken', 'x')).toThrow(/不是合法 JSON/)
    expect(() => normalizeJsonRecordArg([1, 2], 'x')).toThrow(/必须是对象/)
    expect(() => requireStringArg('  ', 'x')).toThrow(/非空字符串/)
    expect(requireStringArg(' v ', 'x')).toBe('v')
  })

  it('metisError produces the canonical error body', () => {
    const err = metisError('NOT_FOUND', 'missing')
    expect(err).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'missing', retryable: false } })
    expect(metisError('RATE_LIMITED', 'slow').error.retryable).toBe(true)
    expect(() => metisError('NOT_A_CODE' as never, 'x')).toThrow(/unknown METIS error code/)
  })
})

describe('data layer reference integrity (fail loud, no partial states)', () => {
  it('rejects claims/excerpts/links referencing unknown records', async () => {
    const data = await makeStore()
    const project = data.createProject({ title: 'boundary' })
    expect(() => data.createClaim('rp-unknown', 'x')).toThrow(/unknown research project/)
    expect(() => data.createClaim(project.id, '   ')).toThrow(/empty/)
    const claim = data.createClaim(project.id, 'claim', { claimType: 'literature_finding' })
    expect(claim.claimType).toBe('literature_finding')

    expect(() => data.addEvidenceExcerpt({ evidenceId: 'ev-none', content: 'x' })).toThrow(/unknown evidence/)
    expect(() => data.linkClaimEvidence(claim.id, 'ev-none')).toThrow(/unknown evidence/)
    expect(() => data.linkClaimEvidence('claim-none', 'ev-none', 'contradicts')).toThrow(/unknown claim/)
    expect(() => data.linkClaimEvidence(claim.id, 'ev-none', 'maybe' as never)).toThrow(/relation/)
    expect(() => data.linkClaimEvidence(claim.id, 'ev-none', 'supports', 1.5)).toThrow(/confidence/)
  })

  it('rejects funding drafts and templates with unknown references', async () => {
    const data = await makeStore()
    const project = data.createProject({ title: 'funding boundary' })
    expect(() => data.saveFundingTemplate({ templateId: 'bad id!', version: 1, template: {} })).toThrow(/invalid templateId/)
    expect(() => data.saveFundingTemplate({ templateId: 't', version: 0, template: {} })).toThrow(/positive integer/)
    expect(() => data.saveFundingSectionDraft({
      projectId: project.id, templateId: 't', sectionId: 's', draftText: 'x', usedEvidenceIds: ['ev-none'],
    })).toThrow(/unknown evidence/)
    expect(() => data.saveFundingSectionDraft({
      projectId: 'rp-none', templateId: 't', sectionId: 's', draftText: 'x', usedEvidenceIds: [],
    })).toThrow(/unknown project/)
    expect(() => data.saveFundingSectionDraft({
      projectId: project.id, templateId: 't', sectionId: 's', draftText: '  ', usedEvidenceIds: [],
    })).toThrow(/empty/)
  })

  it('rejects submission cases and updates with unknown references or statuses', async () => {
    const data = await makeStore()
    expect(() => data.createSubmissionCase({ projectId: 'rp-none' })).toThrow(/unknown project/)
    const project = data.createProject({ title: 'submission boundary' })
    const caseRecord = data.createSubmissionCase({ projectId: project.id })
    expect(caseRecord.status).toBe('researching')
    expect(() => data.updateSubmissionCase(caseRecord.id, { status: 'unknown' as never })).toThrow(/unknown submission status/)
    const updated = data.updateSubmissionCase(caseRecord.id, { status: 'submitted', notes: 'done' })
    expect(updated?.status).toBe('submitted')
    const gap = data.submissionGapCheck(caseRecord.id)
    expect(gap.caseRecord.id).toBe(caseRecord.id)
    expect(gap.unverifiedRequirementSets).toBe(0)
  })

  it('enforces version-1 artifact registration inputs', async () => {
    const data = await makeStore()
    const project = data.createProject({ title: 'artifact boundary' })
    expect(() => data.registerArtifact({
      type: 'paper', title: 'x', workspacePath: 'a.md', projectId: 'rp-none', source: 's',
    })).toThrow(/unknown research project/)
    const artifact = data.registerArtifact({
      type: 'paper', title: 'x', workspacePath: 'a.md', projectId: project.id, source: 's',
      contentHash: 'abc', createdBy: 'model',
    })
    expect(artifact.versions[0]?.contentHash).toBe('abc')
  })
})
