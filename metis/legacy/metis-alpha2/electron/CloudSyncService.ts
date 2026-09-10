/**
 * CloudSyncService — WebDAV 云备份/恢复（T33）。
 *
 * 用户自填 WebDAV 服务器（坚果云/NextCloud 等）—— 无平台账户依赖。
 *   - 备份：sqlite 快照（先本地拷贝避免写锁）→ PUT 到 {url}/metis-backup-{date}.db
 *   - 恢复：GET 最新备份 → 校验 SQLite 文件头 → 落 restore-staging，App 下次
 *     启动时自动完成替换（替换前先另存一份当前库，可回滚）。
 * 密码用 Electron safeStorage 加密存储。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, safeStorage } from 'electron';

const SQLITE_HEADER = 'SQLite format 3';

export interface CloudSyncConfig {
  url: string;
  username: string;
  /** base64(safeStorage.encrypt(password))；未加密时为明文兼容字段。 */
  passwordEnc: string;
}

export class CloudSyncService {
  private readonly dataDir: string;
  private readonly dbPath: string;

  constructor(dataDir: string, dbPath: string) {
    this.dataDir = dataDir;
    this.dbPath = dbPath;
  }

  private configPath(): string {
    return path.join(this.dataDir, 'cloud-sync.json');
  }

  private stagingPath(): string {
    return path.join(this.dataDir, 'metis.db.restore-staging');
  }

  loadConfig(): CloudSyncConfig | null {
    try {
      const raw = fs.readFileSync(this.configPath(), 'utf8');
      const parsed = JSON.parse(raw) as CloudSyncConfig;
      if (parsed && typeof parsed.url === 'string' && parsed.url.startsWith('http')) {
        return { url: parsed.url.replace(/\/+$/u, ''), username: parsed.username ?? '', passwordEnc: parsed.passwordEnc ?? '' };
      }
    } catch { /* 未配置 */ }
    return null;
  }

  saveConfig(url: string, username: string, password: string): CloudSyncConfig | null {
    if (!url.trim().startsWith('http') || !password) return null;
    const config: CloudSyncConfig = {
      url: url.trim().replace(/\/+$/u, ''),
      username: username.trim(),
      passwordEnc: safeStorage.isEncryptionAvailable()
        ? Buffer.from(safeStorage.encryptString(password)).toString('base64')
        : Buffer.from(password, 'utf8').toString('base64'),
    };
    fs.writeFileSync(this.configPath(), JSON.stringify(config, null, 1), 'utf8');
    return config;
  }

  clearConfig(): void {
    try { fs.rmSync(this.configPath(), { force: true }); } catch { /* ignore */ }
  }

  private decryptPassword(config: CloudSyncConfig): string {
    const bytes = Buffer.from(config.passwordEnc, 'base64');
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(bytes);
      } catch { /* fallthrough：可能是在未加密机器上保存的 */ }
    }
    return bytes.toString('utf8');
  }

  private authHeaders(config: CloudSyncConfig): Record<string, string> {
    const token = Buffer.from(`${config.username}:${this.decryptPassword(config)}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  backupObjectName(): string {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    return `metis-backup-${stamp}.db`;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const config = this.loadConfig();
    if (!config) return { ok: false, error: 'not_configured' };
    try {
      const response = await fetch(`${config.url}/`, {
        method: 'OPTIONS',
        headers: this.authHeaders(config),
        signal: AbortSignal.timeout(15_000),
      });
      // 401/403 = 凭据错误；其他非异常状态都算可达。
      if (response.status === 401 || response.status === 403) return { ok: false, error: 'auth_failed' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err).slice(0, 120) };
    }
  }

  async backupNow(): Promise<{ ok: boolean; objectName?: string; error?: string }> {
    const config = this.loadConfig();
    if (!config) return { ok: false, error: 'not_configured' };
    if (!fs.existsSync(this.dbPath)) return { ok: false, error: 'db_not_found' };
    try {
      // 先拷贝快照（避免上传期间数据库写入造成文件锁/不一致）。
      const snapshotPath = path.join(this.dataDir, `cloud-upload-${Date.now()}.tmp`);
      fs.copyFileSync(this.dbPath, snapshotPath);
      const objectName = this.backupObjectName();
      const response = await fetch(`${config.url}/${encodeURIComponent(objectName)}`, {
        method: 'PUT',
        headers: { ...this.authHeaders(config), 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(fs.readFileSync(snapshotPath)),
        signal: AbortSignal.timeout(120_000),
      });
      fs.rmSync(snapshotPath, { force: true });
      if (!response.ok) return { ok: false, error: `http_${response.status}` };
      return { ok: true, objectName };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
    }
  }

  /** 下载远端备份名列表（PROPFIND Depth:1 解析 <D:href>）。 */
  async listBackups(): Promise<string[]> {
    const config = this.loadConfig();
    if (!config) return [];
    try {
      const response = await fetch(`${config.url}/`, {
        method: 'PROPFIND',
        headers: { ...this.authHeaders(config), Depth: '1', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return [];
      const xml = await response.text();
      const names = [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/gu)]
        .map((match) => decodeURIComponent(match[1]!.split('/').pop() ?? ''))
        .filter((name) => /^metis-backup-\d{8}-\d{4}\.db$/u.test(name));
      return [...new Set(names)].sort().reverse().slice(0, 20);
    } catch {
      return [];
    }
  }

  /** 恢复：下载指定备份 → 校验 SQLite 头 → 暂存（下次启动替换）。 */
  async stageRestore(objectName: string): Promise<{ ok: boolean; error?: string }> {
    const config = this.loadConfig();
    if (!config) return { ok: false, error: 'not_configured' };
    if (!/^metis-backup-\d{8}-\d{4}\.db$/u.test(objectName)) return { ok: false, error: 'invalid_name' };
    try {
      const response = await fetch(`${config.url}/${encodeURIComponent(objectName)}`, {
        headers: this.authHeaders(config),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) return { ok: false, error: `http_${response.status}` };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.subarray(0, 15).toString('utf8') !== SQLITE_HEADER) {
        return { ok: false, error: 'not_sqlite_file' };
      }
      fs.writeFileSync(this.stagingPath(), bytes);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
    }
  }

  /** App 启动时调用：存在暂存则（备份当前库后）替换。返回是否执行了替换。
   *  任务1（§八）：必须早于 PersistenceStore 构造调用（main.ts 启动管线第一步），
   *  替换后的数据库由 PersistenceStore 的启动健康检查校验；返回 rollbackPath 供
   *  main.ts 写 restore intent，替换库损坏时用户可回滚。 */
  applyStagedRestoreIfNeeded(): { applied: boolean; rollbackPath?: string } {
    try {
      const staging = this.stagingPath();
      if (!fs.existsSync(staging)) return { applied: false };
      const bytes = fs.readFileSync(staging);
      if (bytes.subarray(0, 15).toString('utf8') !== SQLITE_HEADER) {
        fs.rmSync(staging, { force: true });
        return { applied: false };
      }
      let rollbackPath: string | undefined;
      if (fs.existsSync(this.dbPath)) {
        rollbackPath = path.join(this.dataDir, `metis-pre-restore-${Date.now()}.db`);
        fs.copyFileSync(this.dbPath, rollbackPath);
      }
      fs.copyFileSync(staging, this.dbPath);
      fs.rmSync(staging, { force: true });
      console.log('[CloudSync] Staged restore applied; previous database kept as metis-pre-restore-*.db');
      return { applied: true, rollbackPath };
    } catch (err) {
      console.warn('[CloudSync] Staged restore failed:', (err as Error).message);
      return { applied: false };
    }
  }

  registerIpc(): void {
    ipcMain.handle('cloudSync:getConfig', () => {
      const config = this.loadConfig();
      return config ? { url: config.url, username: config.username, configured: true } : { configured: false };
    });
    ipcMain.handle('cloudSync:saveConfig', (_event, raw: unknown) => {
      const input = raw as { url?: unknown; username?: unknown; password?: unknown };
      if (typeof input?.url !== 'string' || typeof input?.password !== 'string') return { ok: false };
      return this.saveConfig(input.url, typeof input.username === 'string' ? input.username : '', input.password)
        ? { ok: true }
        : { ok: false };
    });
    ipcMain.handle('cloudSync:clearConfig', () => { this.clearConfig(); return { ok: true }; });
    ipcMain.handle('cloudSync:test', () => this.testConnection());
    ipcMain.handle('cloudSync:backup', () => this.backupNow());
    ipcMain.handle('cloudSync:listBackups', () => this.listBackups());
    ipcMain.handle('cloudSync:stageRestore', (_event, rawName: unknown) =>
      typeof rawName === 'string' ? this.stageRestore(rawName) : { ok: false, error: 'invalid_name' });
  }
}
