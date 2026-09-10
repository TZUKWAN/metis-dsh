import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CAPABILITY_SOURCES,
  fetchAndExpandSource,
  expandSourceSkills,
  contentDigest,
  type CapabilitySourceSpec,
  type ExpandedCapabilityManifest,
  type GitHubFetcher,
  type RepoSkillFile,
} from '../engine/capabilities/CapabilityImporter.js';
import { MCP_CATALOG } from '../engine/capabilities/McpCatalog.js';

/**
 * Capability Vault（任务7 7B/7D 落地，2026-09-08 刘总澄清集成语义）：
 *
 * 【入库不注入】全部清单仓库的技能展开后存入 capability_vault 表——**平时
 * 不写入任何上下文**（不进 personalization registry、不进 promptStack、
 * 不进 ToolRegistry）。只有用户把某条目安装为技能并在 Workflow 步骤绑定
 * （step.skillIds）时，才经既有 Step Runtime 动态加载（allowedTools 同理）。
 *
 * MCP 目录条目仅元数据：不安装、不启动、不注入；用户经 MCP 库配置端点后才
 * 成为可绑定 McpDefinition，且默认仍不启动。
 */

export interface VaultEntry {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  sourceId: string;
  sourceRepo: string;
  originalPath: string;
  license: string | null;
  licenseStatus: string;
  domains: string[];
  researchStages: string[];
  tags: string[];
  contentDigest: string;
  included: boolean;
  exclusionReason: string | null;
  installedDefinitionId: string | null;
  importedAt: number;
  updatedAt: number;
  /** 仅 getDetail 返回；列表接口绝不带出正文（元数据目录原则）。 */
  systemPrompt?: string;
}

interface VaultRow {
  id: string; kind: string; name: string; description: string;
  source_id: string; source_repo: string; original_path: string;
  license: string | null; license_status: string;
  domains_json: string; stages_json: string; tags_json: string;
  content_digest: string; system_prompt: string;
  included: number; exclusion_reason: string | null;
  installed_definition_id: string | null;
  imported_at: number; updated_at: number;
}

function rowToEntry(row: VaultRow, withBody = false): VaultEntry {
  const parse = (json: string): string[] => {
    try {
      const value = JSON.parse(json) as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch { return []; }
  };
  return {
    id: row.id, kind: row.kind as 'skill' | 'mcp', name: row.name, description: row.description,
    sourceId: row.source_id, sourceRepo: row.source_repo, originalPath: row.original_path,
    license: row.license, licenseStatus: row.license_status,
    domains: parse(row.domains_json), researchStages: parse(row.stages_json), tags: parse(row.tags_json),
    contentDigest: row.content_digest,
    included: row.included === 1, exclusionReason: row.exclusion_reason,
    installedDefinitionId: row.installed_definition_id,
    importedAt: row.imported_at, updatedAt: row.updated_at,
    ...(withBody ? { systemPrompt: row.system_prompt } : {}),
  };
}

export interface VaultInstallResult {
  ok: boolean;
  code?: 'not_found' | 'excluded' | 'already_installed' | 'install_failed';
  definitionId?: string;
  message?: string;
}

export class CapabilityVaultService {
  constructor(private readonly db: Database.Database) {}

  /** 导入一个来源仓库的全部技能（fetcher 注入；网络失败如实抛出）。 */
  async importSource(sourceId: string, fetcher: GitHubFetcher, token?: string): Promise<{ ok: boolean; imported: number; excluded: number; error?: string }> {
    const source = CAPABILITY_SOURCES.find((candidate) => candidate.id === sourceId);
    if (!source) return { ok: false, imported: 0, excluded: 0, error: 'unknown_source' };
    let manifests: ExpandedCapabilityManifest[];
    try {
      manifests = await fetchAndExpandSource(source, fetcher, token);
    } catch (error) {
      return { ok: false, imported: 0, excluded: 0, error: error instanceof Error ? error.message : String(error) };
    }
    const now = Date.now();
    const upsert = this.db.prepare(`INSERT INTO capability_vault
      (id, kind, name, description, source_id, source_repo, original_path, license, license_status,
       domains_json, stages_json, tags_json, content_digest, system_prompt, included, exclusion_reason,
       installed_definition_id, imported_at, updated_at)
      VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, license=excluded.license,
        license_status=excluded.license_status, content_digest=excluded.content_digest,
        system_prompt=excluded.system_prompt, included=excluded.included,
        exclusion_reason=excluded.exclusion_reason, updated_at=excluded.updated_at`);
    let imported = 0;
    let excluded = 0;
    const tx = this.db.transaction(() => {
      for (const manifest of manifests) {
        upsert.run(
          manifest.id, manifest.name, manifest.description, sourceId, manifest.sourceRepo,
          manifest.originalPath, manifest.license, manifest.licenseStatus,
          JSON.stringify(manifest.domains), JSON.stringify(manifest.researchStages), JSON.stringify(manifest.tags),
          manifest.contentDigest, manifest.systemPrompt, manifest.included ? 1 : 0,
          manifest.exclusionReason ?? null, now, now,
        );
        if (manifest.included) imported += 1; else excluded += 1;
      }
      // MCP 目录条目（元数据注册，kind='mcp'，system_prompt 恒空）
      for (const entry of MCP_CATALOG) {
        const mcpId = `mcp-catalog:${entry.id}`;
        this.db.prepare(`INSERT INTO capability_vault
          (id, kind, name, description, source_id, source_repo, original_path, license, license_status,
           domains_json, stages_json, tags_json, content_digest, system_prompt, included, exclusion_reason,
           installed_definition_id, imported_at, updated_at)
          VALUES (?, 'mcp', ?, ?, 'mcp-catalog', ?, '', NULL, 'unverified', ?, ?, ?, ?, '', 1, NULL, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET description=excluded.description, updated_at=excluded.updated_at`)
          .run(mcpId, `[MCP] ${entry.name}`, entry.capability, entry.repo,
            JSON.stringify([entry.category]), JSON.stringify([]), JSON.stringify([entry.level, `level:${entry.level}`]),
            contentDigest(`${entry.id}:${entry.repo}`), now, now);
      }
    });
    tx();
    return { ok: true, imported, excluded };
  }

  /** 本地文件展开导入（无网络路径：用户手选目录/预包数据）。 */
  importLocalFiles(sourceId: string, files: RepoSkillFile[]): { ok: boolean; imported: number; excluded: number; error?: string } {
    const source = CAPABILITY_SOURCES.find((candidate) => candidate.id === sourceId);
    if (!source) return { ok: false, imported: 0, excluded: 0, error: 'unknown_source' };
    const manifests = expandSourceSkills(source, files);
    const now = Date.now();
    const upsert = this.db.prepare(`INSERT INTO capability_vault
      (id, kind, name, description, source_id, source_repo, original_path, license, license_status,
       domains_json, stages_json, tags_json, content_digest, system_prompt, included, exclusion_reason,
       installed_definition_id, imported_at, updated_at)
      VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, license=excluded.license,
        content_digest=excluded.content_digest, system_prompt=excluded.system_prompt,
        included=excluded.included, exclusion_reason=excluded.exclusion_reason, updated_at=excluded.updated_at`);
    let imported = 0;
    let excluded = 0;
    const tx = this.db.transaction(() => {
      for (const manifest of manifests) {
        upsert.run(
          manifest.id, manifest.name, manifest.description, sourceId, manifest.sourceRepo,
          manifest.originalPath, manifest.license, manifest.licenseStatus,
          JSON.stringify(manifest.domains), JSON.stringify(manifest.researchStages), JSON.stringify(manifest.tags),
          manifest.contentDigest, manifest.systemPrompt, manifest.included ? 1 : 0,
          manifest.exclusionReason ?? null, now, now,
        );
        if (manifest.included) imported += 1; else excluded += 1;
      }
    });
    tx();
    return { ok: true, imported, excluded };
  }

  /** 目录检索：仅元数据，绝不带出 systemPrompt。 */
  search(options: { keyword?: string; sourceId?: string; kind?: 'skill' | 'mcp'; stage?: string; limit?: number } = {}): VaultEntry[] {
    const rows = this.db.prepare('SELECT * FROM capability_vault ORDER BY imported_at DESC, name ASC').all() as VaultRow[];
    const keyword = options.keyword?.trim().toLowerCase();
    const result: VaultEntry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row, false);
      if (options.sourceId && entry.sourceId !== options.sourceId) continue;
      if (options.kind && entry.kind !== options.kind) continue;
      if (options.stage && !entry.researchStages.includes(options.stage)) continue;
      if (keyword) {
        const haystack = `${entry.name} ${entry.description} ${entry.tags.join(' ')} ${entry.sourceRepo}`.toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      result.push(entry);
      if (result.length >= (options.limit ?? 200)) break;
    }
    return result;
  }

  /** 详情：含 systemPrompt（安装预览用；仅单条）。 */
  getDetail(id: string): VaultEntry | null {
    const row = this.db.prepare('SELECT * FROM capability_vault WHERE id = ?').get(id) as VaultRow | undefined;
    return row ? rowToEntry(row, true) : null;
  }

  stats(): { total: number; skills: number; mcps: number; installed: number; sources: number } {
    const row = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'skill' THEN 1 ELSE 0 END) AS skills,
      SUM(CASE WHEN kind = 'mcp' THEN 1 ELSE 0 END) AS mcps,
      SUM(CASE WHEN installed_definition_id IS NOT NULL THEN 1 ELSE 0 END) AS installed,
      COUNT(DISTINCT source_id) AS sources
      FROM capability_vault`).get() as { total: number; skills: number | null; mcps: number | null; installed: number | null; sources: number };
    return { total: row.total ?? 0, skills: row.skills ?? 0, mcps: row.mcps ?? 0, installed: row.installed ?? 0, sources: row.sources ?? 0 };
  }

  listSources(): Array<CapabilitySourceSpec & { vaultCount: number }> {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM capability_vault WHERE source_id = ?').all();
    void count;
    const counts = new Map<string, number>();
    for (const row of this.db.prepare('SELECT source_id, COUNT(*) AS n FROM capability_vault GROUP BY source_id').all() as Array<{ source_id: string; n: number }>) {
      counts.set(row.source_id, row.n);
    }
    return CAPABILITY_SOURCES.map((source) => ({ ...source, vaultCount: counts.get(source.id) ?? 0 }));
  }

  /**
   * 安装为可绑定技能：写入 personalization definitions（enabled）。
   * 【零暴露契约】安装≠注入——安装后技能只出现在场景构建器的可绑定清单里；
   * prompt 注入仍只发生在 Workflow 步骤绑定（step.skillIds）并执行时
   * （ScenarioWorkflowService composeManifestSystemPrompt 按 step 解析）。
   * installPersonalizationSkill 由调用方注入（避免 engine→electron 依赖）。
   */
  install(
    id: string,
    installPersonalizationSkill: (input: { id: string; name: string; description: string; systemPrompt: string; tags: string[] }) => { ok: boolean; definitionId?: string; error?: string },
  ): VaultInstallResult {
    const row = this.db.prepare('SELECT * FROM capability_vault WHERE id = ?').get(id) as VaultRow | undefined;
    if (!row) return { ok: false, code: 'not_found' };
    if (row.included !== 1) return { ok: false, code: 'excluded', message: row.exclusion_reason ?? '该条目未通过导入核验' };
    if (row.kind !== 'skill') return { ok: false, code: 'excluded', message: 'MCP 目录条目请在 MCP 库中配置端点后绑定' };
    if (row.installed_definition_id) return { ok: false, code: 'already_installed', definitionId: row.installed_definition_id };
    const entry = rowToEntry(row, true);
    const result = installPersonalizationSkill({
      id: `skill:vault:${row.id}`,
      name: entry.name,
      description: `${entry.description}（来源：${entry.sourceRepo}）`,
      systemPrompt: entry.systemPrompt ?? '',
      tags: entry.tags,
    });
    if (!result.ok || !result.definitionId) return { ok: false, code: 'install_failed', message: result.error };
    this.db.prepare('UPDATE capability_vault SET installed_definition_id = ?, updated_at = ? WHERE id = ?')
      .run(result.definitionId, Date.now(), id);
    return { ok: true, definitionId: result.definitionId };
  }

  uninstall(id: string): boolean {
    const row = this.db.prepare('SELECT installed_definition_id FROM capability_vault WHERE id = ?').get(id) as { installed_definition_id: string | null } | undefined;
    if (!row?.installed_definition_id) return false;
    this.db.prepare('UPDATE capability_vault SET installed_definition_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
    return true;
  }
}

/** 生成 vault 行 id 的稳定辅助（导入器之外复用）。 */
export function vaultEntryId(sourceId: string, path: string): string {
  return `${sourceId}:${path}`;
}

export { CAPABILITY_SOURCES, fetchAndExpandSource, expandSourceSkills, contentDigest, MCP_CATALOG };
export type { CapabilitySourceSpec, ExpandedCapabilityManifest, GitHubFetcher, RepoSkillFile };
export function newVaultRequestId(): string { return randomUUID(); }
