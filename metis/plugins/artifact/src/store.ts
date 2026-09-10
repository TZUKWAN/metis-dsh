/**
 * Artifact Store（dsh-metis-artifact 服务层，Phase 18 / T18-018~029）。
 * JSON 原子持久化；版本条目只增不减；重复 id 拒绝（fail-loud）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACT_TYPES, type ArtifactRecord, type ArtifactType, type ArtifactVersionEntry } from './domain.js'

export interface RegisterInput {
  id?: string
  type: ArtifactType
  title: string
  path: string
  projectId?: string | null
  source: string
  status?: ArtifactRecord['status']
  mimeType?: string
  note?: string
}

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value)
}

export class ArtifactStore {
  private records: ArtifactRecord[] = []
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
          this.records = ((parsed as { records: unknown[] }).records).filter(
            (item): item is ArtifactRecord =>
              typeof item === 'object' && item !== null
              && typeof (item as { id?: unknown }).id === 'string'
              && Array.isArray((item as { versions?: unknown }).versions),
          )
        }
      } catch {
        const backup = `${this.filePath}.corrupt-${Date.now()}`
        try {
          fs.copyFileSync(this.filePath, backup)
        } catch { /* 保留原始损坏文件 */ }
      }
    }
    this.loaded = true
  }

  private persist(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, records: this.records }, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  /** 登记已有文件为 Artifact（T18-020）。重复 id 抛错（fail-loud，不做静默覆盖）。 */
  register(input: RegisterInput): ArtifactRecord {
    this.load()
    const now = Date.now()
    const id = input.id?.trim() || `art-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (this.records.some((record) => record.id === id)) {
      throw new Error(`artifact id 已存在: ${id}（如需新版本请使用 artifact_version）`)
    }
    const versionEntry: ArtifactVersionEntry = {
      version: 1,
      path: input.path,
      createdAt: now,
      ...(input.note ? { note: input.note } : {}),
    }
    const record: ArtifactRecord = {
      id,
      type: input.type,
      title: input.title,
      path: input.path,
      projectId: input.projectId ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      status: input.status ?? 'draft',
      versions: [versionEntry],
    }
    this.records.push(record)
    this.persist()
    return record
  }

  /** 登记新版本：版本号 +1，历史条目保留（T18-027/029 可追溯）。 */
  addVersion(id: string, path: string, note?: string): ArtifactRecord | undefined {
    this.load()
    const record = this.records.find((item) => item.id === id)
    if (!record) return undefined
    const version = record.version + 1
    const entry: ArtifactVersionEntry = { version, path, createdAt: Date.now(), ...(note ? { note } : {}) }
    record.versions.push(entry)
    record.version = version
    record.path = path
    record.updatedAt = Date.now()
    this.persist()
    return record
  }

  updateMetadata(id: string, patch: { title?: string; status?: ArtifactRecord['status']; projectId?: string | null }): ArtifactRecord | undefined {
    this.load()
    const record = this.records.find((item) => item.id === id)
    if (!record) return undefined
    if (patch.title !== undefined) record.title = patch.title
    if (patch.status !== undefined) record.status = patch.status
    if (patch.projectId !== undefined) record.projectId = patch.projectId
    record.updatedAt = Date.now()
    this.persist()
    return record
  }

  get(id: string): ArtifactRecord | undefined {
    this.load()
    return this.records.find((item) => item.id === id)
  }

  list(filter?: { projectId?: string; type?: ArtifactType }): ArtifactRecord[] {
    this.load()
    return this.records.filter((record) =>
      (filter?.projectId === undefined || record.projectId === filter.projectId)
      && (filter?.type === undefined || record.type === filter.type))
  }
}
