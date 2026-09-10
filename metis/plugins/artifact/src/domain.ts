/**
 * Artifact 领域模型（dsh-metis-artifact，Phase 18 / T18-001~012）。
 *
 * 原则（T18-013~017）：真实文件保存在 DSH workspace（由用户/DSH Files 管理），
 * 本插件只维护**领域身份、版本与关系**，不复制文件内容；文件路径是
 * workspace 内的引用而非领域身份。
 */

export const ARTIFACT_TYPES = [
  'paper', 'report', 'proposal', 'review', 'dataset',
  'figure', 'presentation', 'spreadsheet', 'other',
] as const

export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value)
}

export type ArtifactStatus = 'draft' | 'review' | 'final'

export interface ArtifactVersionEntry {
  version: number
  /** 版本创建时的文件引用（workspace 相对路径）。 */
  path: string
  createdAt: number
  note?: string
}

export interface ArtifactRecord {
  id: string
  type: ArtifactType
  title: string
  /** 当前文件引用（workspace 内路径或 DSH Files 引用），非领域身份。 */
  path: string
  projectId: string | null
  /** metadata 版本：每次内容/路径变更 +1（T18-028：与文件版本分离，文件版本在 versions 里追溯）。 */
  version: number
  createdAt: number
  updatedAt: number
  source: string
  status: ArtifactStatus
  mimeType?: string
  /** 历史版本条目（T18-027~029）。 */
  versions: ArtifactVersionEntry[]
}

export interface ArtifactVersionRecord {
  artifactId: string
  version: number
  path: string
  createdAt: number
  note?: string
}
