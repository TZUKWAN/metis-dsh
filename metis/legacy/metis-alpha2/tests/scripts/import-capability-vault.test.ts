/**
 * 运维脚本（非单测）：把 CAPABILITY_SOURCES 注册表中的全部 58 个技能源
 * 真实拉取并写入刘总的运行库 capability_vault（2026-09-05 刘总指令：继续导入没导入的技能）。
 *
 * 与应用内「一键导入全部来源」按钮走完全相同的管线：
 *   CapabilityVaultService.importSource → fetchAndExpandSource → 逐 SKILL.md 展开 → 幂等 upsert
 *   （importSource 同时会把 MCP 目录 63 条元数据一并入库）。
 *
 * 运行方式：npx vitest run scripts/import-capability-vault.test.ts
 * 安全性：WAL 模式 + busy_timeout，与运行中的应用并发安全；upsert 幂等可重复执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CapabilityVaultService } from '../../electron/CapabilityVaultService.js';
import { CAPABILITY_SOURCES, type CapabilitySourceSpec, type GitHubFetcher } from '../../engine/capabilities/CapabilityImporter.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';

const DB_PATH = path.join(process.env.APPDATA ?? '', 'metis-workbench', 'metis-data', 'metis.db');
// Optional local token: this drill talks to the REAL GitHub and the REAL user
// database, so it only runs when explicitly provisioned (gh_token.txt or
// GITHUB_TOKEN). Everywhere else it reports a clean skip.
const GH_TOKEN_FILE = 'C:/Users/lauze/AppData/Local/Temp/gh_token.txt';
const TOKEN = (fs.existsSync(GH_TOKEN_FILE) ? fs.readFileSync(GH_TOKEN_FILE, 'utf8').trim() : '')
  || process.env.GITHUB_TOKEN || '';
// Real-network + real-database drill: skip entirely without provisioned credentials.
const HAS_TOKEN = TOKEN.length > 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFetcher(): GitHubFetcher {
  return async (url) => {
    const headers: Record<string, string> = {
      'User-Agent': 'METIS-CapabilityVault',
      'Accept': 'application/vnd.github+json',
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, { headers });
        if (response.ok) return await response.text();
        // 限流/服务端瞬时错误：退避重试；4xx 客户端错误不重试。
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          lastError = `github_${response.status}`;
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 2500 * (attempt + 1));
          continue;
        }
        throw new Error(`github_${response.status}`);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(1500 * (attempt + 1));
      }
    }
    throw new Error(lastError || 'github_fetch_failed');
  };
}

interface SourceOutcome {
  id: string;
  ok: boolean;
  imported: number;
  excluded: number;
  error?: string;
  ms: number;
}

describe.skipIf(!HAS_TOKEN)(/* real-network drill */'Capability Vault 全量导入（运维脚本）', () => {
  it('imports every registered source into the live database', { timeout: 1_200_000 }, async () => {
    expect(fs.existsSync(DB_PATH), `运行库不存在：${DB_PATH}`).toBe(true);
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 30000');
    db.exec(SCHEMA_SQL); // 幂等：保证 capability_vault 表在旧库上存在
    const vault = new CapabilityVaultService(db);
    const fetcher = makeFetcher();

    const outcomes: SourceOutcome[] = [];
    for (const source of CAPABILITY_SOURCES as readonly CapabilitySourceSpec[]) {
      const started = Date.now();
      const result = await vault.importSource(source.id, fetcher, TOKEN || undefined);
      outcomes.push({
        id: source.id,
        ok: result.ok,
        imported: result.imported,
        excluded: result.excluded,
        error: result.error,
        ms: Date.now() - started,
      });
      console.log(`[${outcomes.length}/${CAPABILITY_SOURCES.length}] ${source.id}: ${result.ok ? `+${result.imported} skills` : `FAILED (${result.error})`}`);
      await sleep(150);
    }

    // 失败源统一重试一轮（网络抖动恢复）。
    const failedFirstPass = outcomes.filter((outcome) => !outcome.ok);
    for (const failure of failedFirstPass) {
      await sleep(1000);
      const retry = await vault.importSource(failure.id, fetcher, TOKEN || undefined);
      if (retry.ok) {
        failure.ok = true;
        failure.imported = retry.imported;
        failure.excluded = retry.excluded;
        failure.error = undefined;
        console.log(`[retry] ${failure.id}: +${retry.imported} skills`);
      } else {
        failure.error = retry.error;
      }
    }

    const succeeded = outcomes.filter((outcome) => outcome.ok);
    const stillFailed = outcomes.filter((outcome) => !outcome.ok);
    const stats = vault.stats();
    console.log('── 汇总 ──');
    console.log(`成功 ${succeeded.length} / ${CAPABILITY_SOURCES.length} 源；仍失败 ${stillFailed.length} 源`);
    for (const failure of stillFailed) console.log(`  失败: ${failure.id} → ${failure.error}`);
    console.log(`库内总量: ${stats.total} 条（技能 ${stats.skills} · MCP ${stats.mcps}）· 已安装 ${stats.installed}`);

    expect(succeeded.length).toBeGreaterThan(0);
    db.close();
  });
});
