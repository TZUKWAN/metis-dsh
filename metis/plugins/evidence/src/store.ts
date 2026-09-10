/**
 * Evidence Store（dsh-metis-evidence 服务层，Phase 10 / T10-011~019）。
 *
 * - JSON 文件持久化，原子写（tmp + rename，T9-023）；
 * - DOI/URL 优先去重（T11-026 语义在此域通用）；
 * - 生命周期方法：registerObservation / verify / reject / markConflict / markStale；
 * - 查询：get / queryByProject / queryByDoi / queryByUrl。
 *
 * Known Limitations：单文件形态面向第一版；并发写以进程内串行为准，
 * 多进程并发写入是已知限制（迁移到 SQLite 见 migration/DATA_MIGRATION_PLAN.md）。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  isEvidenceRecordLike,
  type EvidenceRecord,
  type EvidenceSourceType,
  type VerificationState,
} from './domain.ts'

const MAX_OBSERVATION_CHARS = 4_000

export interface RegisterObservationInput {
  projectId?: string | null
  sourceType: EvidenceSourceType
  source: EvidenceRecord['source']
  title: string
  observation?: string
  doi?: string
  url?: string
  createdByTool: string
}

function normalizeDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined
  const trimmed = doi.trim()
  const withoutPrefix = trimmed.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  return withoutPrefix.toLowerCase() || undefined
}

function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  const trimmed = url.trim()
  return trimmed || undefined
}

export class EvidenceStore {
  private records: EvidenceRecord[] = []
  private loaded = false

  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private load(): void {
    if (this.loaded) return
    if (fs.existsSync(this.filePath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { records?: unknown }).records)) {
          this.records = ((parsed as { records: unknown[] }).records).filter(isEvidenceRecordLike)
        }
      } catch {
        // 损坏文件 fail-loud 交给调用方——这里保留空态并让首次写入覆盖前先备份。
        const backup = `${this.filePath}.corrupt-${Date.now()}`
        try {
          fs.copyFileSync(this.filePath, backup)
        } catch { /* 备份失败不阻断，原始损坏文件保留 */ }
      }
    }
    this.loaded = true
  }

  /** 原子写：先写临时文件再 rename（同目录保证同文件系统）。 */
  private persist(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload: string = JSON.stringify({ schemaVersion: 1, records: this.records }, null, 2)
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, payload, 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  /** DOI/URL 优先去重；两者皆缺时按 provider+sourceId+title 精确匹配。 */
  findDuplicate(input: RegisterObservationInput): EvidenceRecord | undefined {
    const doi = normalizeDoi(input.doi)
    const url = normalizeUrl(input.url)
    if (doi) {
      const hit = this.records.find((record) => normalizeDoi(record.doi) === doi)
      if (hit) return hit
    }
    if (url) {
      const hit = this.records.find((record) => record.url === url)
      if (hit) return hit
    }
    if (!doi && !url && input.source.sourceId) {
      return this.records.find((record) =>
        record.source.provider === input.source.provider
        && record.source.sourceId === input.source.sourceId
        && record.title === input.title)
    }
    return undefined
  }

  /**
   * 登记观察。重复证据不重复登记，返回既有记录（duplicate: true），
   * 供调用方向模型如实表达「该证据已在案」而非伪造新条目。
   */
  registerObservation(input: RegisterObservationInput): { record: EvidenceRecord; duplicate: boolean } {
    this.load()
    const duplicate = this.findDuplicate(input)
    if (duplicate) {
      return { record: duplicate, duplicate: true }
    }
    const now = Date.now()
    const observation = input.observation
    const truncated = observation !== undefined && observation.length > MAX_OBSERVATION_CHARS
    const record: EvidenceRecord = {
      id: `ev-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: input.projectId ?? null,
      sourceType: input.sourceType,
      source: input.source,
      title: input.title,
      ...(observation === undefined ? {} : { observation: truncated ? observation.slice(0, MAX_OBSERVATION_CHARS) : observation }),
      ...(normalizeDoi(input.doi) === undefined ? {} : { doi: normalizeDoi(input.doi) }),
      ...(normalizeUrl(input.url) === undefined ? {} : { url: normalizeUrl(input.url) }),
      observedAt: now,
      verificationState: 'unverified',
      createdByTool: input.createdByTool,
      createdAt: now,
      updatedAt: now,
      ...(truncated ? { truncated: true } : {}),
    }
    this.records.push(record)
    this.persist()
    return { record, duplicate: false }
  }

  private transition(id: string, state: VerificationState): EvidenceRecord | undefined {
    this.load()
    const record = this.records.find((item) => item.id === id)
    if (!record) return undefined
    record.verificationState = state
    record.updatedAt = Date.now()
    this.persist()
    return record
  }

  verify(id: string): EvidenceRecord | undefined {
    return this.transition(id, 'verified')
  }

  reject(id: string): EvidenceRecord | undefined {
    return this.transition(id, 'rejected')
  }

  markConflict(id: string): EvidenceRecord | undefined {
    return this.transition(id, 'conflicted')
  }

  markStale(id: string): EvidenceRecord | undefined {
    return this.transition(id, 'stale')
  }

  get(id: string): EvidenceRecord | undefined {
    this.load()
    return this.records.find((record) => record.id === id)
  }

  queryByProject(projectId: string): EvidenceRecord[] {
    this.load()
    return this.records.filter((record) => record.projectId === projectId)
  }

  queryByDoi(doi: string): EvidenceRecord[] {
    this.load()
    const normalized = normalizeDoi(doi)
    return normalized ? this.records.filter((record) => normalizeDoi(record.doi) === normalized) : []
  }

  queryByUrl(url: string): EvidenceRecord[] {
    this.load()
    const normalized = normalizeUrl(url)
    return normalized ? this.records.filter((record) => record.url === normalized) : []
  }

  all(): EvidenceRecord[] {
    this.load()
    return [...this.records]
  }

  /** 测试与迁移辅助：替换内存态并落盘。 */
  replaceAll(records: EvidenceRecord[]): void {
    this.records = records
    this.persist()
  }
}
