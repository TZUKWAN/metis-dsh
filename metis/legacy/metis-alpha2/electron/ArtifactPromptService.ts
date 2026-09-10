import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { ARTIFACT_PROMPT_DEFINITIONS, getArtifactPromptDefinition, type ArtifactPromptDefinition, type ArtifactPromptPack } from '../engine/artifacts/prompts/ArtifactPromptRegistry.js';

/**
 * 成果提示词工程服务(2026-09-05 刘总要求,任务4)。
 *
 * Default(prompt definition)+ User Override 分离;override 保存产生 revision;
 * 恢复默认只 disable/删除 override,出厂 prompt 永不丢失;升级通过 baseVersion
 * 感知,不覆盖用户内容。
 */

export interface ArtifactPromptOverrideRow {
  promptId: string;
  content: string;
  enabled: boolean;
  baseVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactPromptRevisionRow {
  id: string;
  promptId: string;
  content: string;
  createdAt: number;
  source: 'manual' | 'assistant' | 'import';
  note: string;
}

export interface ArtifactPromptView {
  definition: ArtifactPromptDefinition;
  override: ArtifactPromptOverrideRow | null;
  /** 当前生效内容:enabled override 或 default。 */
  effectiveContent: string;
  /** default 是否已升级(override.baseVersion < definition.version)。 */
  defaultUpgraded: boolean;
  status: 'default' | 'customized' | 'disabled';
}

const MAX_PROMPT_CHARS = 20_000;

export class ArtifactPromptService {
  constructor(private readonly db: Database) {}

  listViews(): ArtifactPromptView[] {
    return ARTIFACT_PROMPT_DEFINITIONS.map((definition) => this.getView(definition.id)!);
  }

  getView(promptId: string): ArtifactPromptView | null {
    const definition = getArtifactPromptDefinition(promptId);
    if (!definition) return null;
    const override = this.getOverride(promptId);
    const enabled = override?.enabled === true;
    const effectiveContent = override && enabled ? override.content : definition.defaultPrompt;
    return {
      definition,
      override,
      effectiveContent,
      defaultUpgraded: Boolean(override && override.baseVersion < definition.version),
      status: !override ? 'default' : enabled ? 'customized' : 'disabled',
    };
  }

  /** Resolver 入口:返回当前生效的行为 prompt(无 override 或停用 → default)。 */
  resolve(promptId: string): string | null {
    const definition = getArtifactPromptDefinition(promptId);
    if (!definition) return null;
    const override = this.getOverride(promptId);
    if (override && override.enabled) return override.content;
    return definition.defaultPrompt;
  }

  getOverride(promptId: string): ArtifactPromptOverrideRow | null {
    const row = this.db.prepare('SELECT * FROM outcome_prompt_overrides WHERE prompt_id = ?').get(promptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      promptId: row.prompt_id as string,
      content: row.content as string,
      enabled: row.enabled === 1,
      baseVersion: row.base_version as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  saveOverride(input: { promptId: string; content: string; enabled?: boolean; source?: 'manual' | 'assistant' | 'import'; note?: string }): { ok: true; view: ArtifactPromptView } | { ok: false; code: string } {
    const definition = getArtifactPromptDefinition(input.promptId);
    if (!definition || !definition.editable) return { ok: false, code: 'unknown_prompt' };
    const content = input.content;
    if (typeof content !== 'string' || content.length > MAX_PROMPT_CHARS) return { ok: false, code: 'invalid_content' };
    if (content.trim() === definition.defaultPrompt.trim()) return this.resetOverride(input.promptId);
    const now = Date.now();
    const existing = this.getOverride(input.promptId);
    this.db.prepare(
      'INSERT INTO outcome_prompt_overrides (prompt_id, content, enabled, base_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(prompt_id) DO UPDATE SET content = excluded.content, enabled = excluded.enabled, updated_at = excluded.updated_at',
    ).run(input.promptId, content, input.enabled === false ? 0 : 1, definition.version, existing?.createdAt ?? now, now);
    this.db.prepare(
      'INSERT INTO outcome_prompt_revisions (id, prompt_id, content, created_at, source, note) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`rev_${randomUUID().replace(/-/g, '').slice(0, 20)}`, input.promptId, content, now, input.source ?? 'manual', input.note ?? '');
    return { ok: true, view: this.getView(input.promptId)! };
  }

  /** 停用 override(回到 default 但保留用户内容)。 */
  setEnabled(promptId: string, enabled: boolean): { ok: true; view: ArtifactPromptView } | { ok: false; code: string } {
    const existing = this.getOverride(promptId);
    if (!existing) return { ok: false, code: 'no_override' };
    this.db.prepare('UPDATE outcome_prompt_overrides SET enabled = ?, updated_at = ? WHERE prompt_id = ?').run(enabled ? 1 : 0, Date.now(), promptId);
    return { ok: true, view: this.getView(promptId)! };
  }

  /** 恢复默认:删除 override;历史 revision 保留(文档第八节:恢复默认永久可用)。 */
  resetOverride(promptId: string): { ok: true; view: ArtifactPromptView } | { ok: false; code: string } {
    if (!getArtifactPromptDefinition(promptId)) return { ok: false, code: 'unknown_prompt' };
    this.db.prepare('DELETE FROM outcome_prompt_overrides WHERE prompt_id = ?').run(promptId);
    return { ok: true, view: this.getView(promptId)! };
  }

  listRevisions(promptId: string): ArtifactPromptRevisionRow[] {
    const rows = this.db.prepare('SELECT * FROM outcome_prompt_revisions WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 50').all(promptId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      promptId: row.prompt_id as string,
      content: row.content as string,
      createdAt: row.created_at as number,
      source: row.source as ArtifactPromptRevisionRow['source'],
      note: row.note as string,
    }));
  }

  /** 恢复旧版本:生成新 revision,不删除后续历史(文档第二十四节)。 */
  restoreRevision(promptId: string, revisionId: string): { ok: true; view: ArtifactPromptView } | { ok: false; code: string } {
    const revision = this.db.prepare('SELECT * FROM outcome_prompt_revisions WHERE id = ? AND prompt_id = ?').get(revisionId, promptId) as Record<string, unknown> | undefined;
    if (!revision) return { ok: false, code: 'revision_not_found' };
    return this.saveOverride({ promptId, content: revision.content as string, source: 'manual', note: `恢复自 ${revisionId.slice(-8)}` });
  }

  exportPack(): ArtifactPromptPack {
    const prompts = ARTIFACT_PROMPT_DEFINITIONS
      .map((definition) => ({ definition, override: this.getOverride(definition.id) }))
      .filter((item): item is { definition: ArtifactPromptDefinition; override: ArtifactPromptOverrideRow } => item.override !== null)
      .map(({ definition, override }) => ({
        promptId: definition.id,
        content: override.content,
        baseVersion: override.baseVersion,
        enabled: override.enabled,
      }));
    return { schemaVersion: 1, createdAt: Date.now(), prompts };
  }

  importPack(pack: unknown): { ok: true; applied: string[]; unknownIds: string[] } | { ok: false; code: string } {
    if (typeof pack !== 'object' || pack === null) return { ok: false, code: 'invalid_pack' };
    const candidate = pack as { schemaVersion?: unknown; prompts?: unknown };
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.prompts)) return { ok: false, code: 'invalid_pack' };
    const applied: string[] = [];
    const unknownIds: string[] = [];
    for (const entry of candidate.prompts as Array<Record<string, unknown>>) {
      const promptId = typeof entry.promptId === 'string' ? entry.promptId : '';
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (!promptId || !content) continue;
      const definition = getArtifactPromptDefinition(promptId);
      if (!definition) {
        unknownIds.push(promptId);
        continue;
      }
      const result = this.saveOverride({
        promptId,
        content,
        enabled: entry.enabled !== false,
        source: 'import',
      });
      if (result.ok) applied.push(promptId);
    }
    return { ok: true, applied, unknownIds };
  }
}
