import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

// 本机诊断 drill：直读真实用户数据库（capability_vault 行数）。
// 依赖本机数据存在——CI/其它机器上显式跳过，而非报错。
const LOCAL_DB = path.join(process.env.APPDATA ?? '', 'metis-workbench', 'metis-data', 'metis.db');
const HAS_LOCAL_DB = fs.existsSync(LOCAL_DB);

describe.skipIf(!HAS_LOCAL_DB)('诊断', () => {
  it('prints resolved db path', () => {
    const DB_PATH = path.join(process.env.APPDATA ?? '', 'metis-workbench', 'metis-data', 'metis.db');
    console.log('APPDATA =', JSON.stringify(process.env.APPDATA));
    console.log('DB_PATH =', DB_PATH);
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) n FROM capability_vault').get() as { n: number };
    console.log('capability_vault rows =', row.n);
    expect(row.n).toBeGreaterThan(0);
    db.close();
  });
});
