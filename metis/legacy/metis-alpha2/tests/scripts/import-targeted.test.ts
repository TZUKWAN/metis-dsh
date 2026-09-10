/** 运维脚本：定向导入 6 个新增 WenyuChiou 技能源 + 重导 5 个扁平/目录形态源。 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CapabilityVaultService } from '../../electron/CapabilityVaultService.js';
import { CAPABILITY_SOURCES } from '../../engine/capabilities/CapabilityImporter.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';

const DB_PATH = path.join(process.env.APPDATA ?? '', 'metis-workbench', 'metis-data', 'metis.db');
const TOKEN = process.env.GITHUB_TOKEN || '';

function makeFetcher() {
  return async (url: string): Promise<string> => {
    const headers: Record<string, string> = { 'User-Agent': 'METIS-CapabilityVault', 'Accept': 'application/vnd.github+json' };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(url, { headers });
        if (response.ok) return await response.text();
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          lastError = `github_${response.status}`;
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(`github_${response.status}`);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    throw new Error(lastError || 'github_fetch_failed');
  };
}

// Real-network drill (hits GitHub): skip without provisioned credentials.
   describe.skipIf(!TOKEN)('定向导入', () => {
  it('imports 6 new wenyuchiou repos + re-imports 5 flat/catalog sources', { timeout: 900_000 }, async () => {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 30000');
    db.exec(SCHEMA_SQL);
    const vault = new CapabilityVaultService(db);
    const fetcher = makeFetcher();
    const targets = [
      'wenyuchiou-research-hub', 'wenyuchiou-academic-writing', 'wenyuchiou-zotero',
      'wenyuchiou-codex-delegate', 'wenyuchiou-antigravity-delegate', 'wenyuchiou-agent-collab',
      'ai-research-skills', 'academic-paper-skill', 'lcrawfurd-skills', 'paper-framework-figure-studio', 'socialverse',
    ];
    for (const id of targets) {
      const source = CAPABILITY_SOURCES.find((item) => item.id === id);
      expect(source, `${id} 不在注册表`).toBeTruthy();
      const result = await vault.importSource(id, fetcher, TOKEN || undefined);
      console.log(`[import] ${id}: ok=${result.ok} imported=${result.imported} excluded=${result.excluded} error=${result.error ?? '-'}`);
      expect(result.ok, `${id}: ${result.error}`).toBe(true);
    }
    const stats = vault.stats();
    console.log(`库内总量: ${stats.total}（技能 ${stats.skills} · MCP ${stats.mcps}）· 来源数 ${stats.sources}`);
    db.close();
  });
});
