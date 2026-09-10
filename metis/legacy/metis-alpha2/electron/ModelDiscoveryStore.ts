/**
 * 免费模型发现与邮箱池的持久化（2026-08-23）。
 *
 * 两个独立文件，均在 DATA_DIR 下：
 *  - model-discovery.v1.json：扫描源配置、最近一次发现结果、已接入标记
 *  - mailbox-pool.v1.json：注册邮箱池（授权码为 safeStorage 密文）
 *
 * 与 ProviderProfileStore 不同，这两个文件不承载高价值凭据的完整性 MAC
 * （授权码本身已是 OS 级加密密文；模型列表是可重扫的缓存数据），采用
 * 轻量 JSON 原子写即可。接入动作仍走正规 profile save 路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredModel, DiscoverySource } from '../engine/providers/discovery/ProviderDiscoveryService.js';
import type { StationRunState } from '../engine/providers/discovery/AutoRegisterScheduler.js';
import type { MailboxAccount } from '../engine/mail/MailboxPool.js';

const DISCOVERY_FILE = 'model-discovery.v1.json';
const MAILBOX_FILE = 'mailbox-pool.v1.json';

export interface AttachedFreeModel {
  /** 关联的 profile id（经正规 save 写入 provider-profiles） */
  profileId: string;
  discoveryKey: string;
  sourceName: string;
  modelId: string;
  attachedAt: number;
  disabled: boolean;
  todayUsedCount: number;
  lastUsedAt: number | null;
  quotaState: 'normal' | 'low' | 'exhausted' | 'disabled';
}

export interface DiscoveryStoreData {
  version: 1;
  sources: DiscoverySource[];
  lastScanAt: number | null;
  models: DiscoveredModel[];
  attached: AttachedFreeModel[];
  /** 自动注册批次中各站点的最新状态（按规范化 baseUrl 键）。 */
  stationStates?: Record<string, StationRunState>;
}

export class ModelDiscoveryStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  #discoveryPath(): string {
    return path.join(this.#dataDir, DISCOVERY_FILE);
  }

  read(): DiscoveryStoreData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#discoveryPath(), 'utf8')) as DiscoveryStoreData;
      if (parsed.version === 1) return parsed;
    } catch { /* 首次或损坏时返回空结构 */ }
    return { version: 1, sources: [], lastScanAt: null, models: [], attached: [], stationStates: {} };
  }

  write(data: DiscoveryStoreData): void {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const temporary = path.join(this.#dataDir, '.' + DISCOVERY_FILE + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ ...data, version: 1 }, null, 2), 'utf8');
    fs.renameSync(temporary, this.#discoveryPath());
  }

  upsertScan(sources: DiscoverySource[], models: DiscoveredModel[]): void {
    const data = this.read();
    // 源配置合并保留（按 id）。
    for (const source of sources) {
      const index = data.sources.findIndex((item) => item.id === source.id);
      if (index >= 0) data.sources[index] = source;
      else data.sources.push(source);
    }
    // 发现结果整体替换为最新一轮（历史无保留价值，健康度由 attached 维护）。
    data.models = models;
    data.lastScanAt = Date.now();
    this.write(data);
  }

  markAttached(profileId: string, discoveryKey: string, sourceName: string, modelId: string): AttachedFreeModel {
    const data = this.read();
    const entry: AttachedFreeModel = {
      profileId,
      discoveryKey,
      sourceName,
      modelId,
      attachedAt: Date.now(),
      disabled: false,
      todayUsedCount: 0,
      lastUsedAt: null,
      quotaState: 'normal',
    };
    data.attached = [...data.attached.filter((item) => item.profileId !== profileId), entry];
    this.write(data);
    return entry;
  }

  detach(profileId: string): boolean {
    const data = this.read();
    const before = data.attached.length;
    data.attached = data.attached.filter((item) => item.profileId !== profileId);
    this.write(data);
    return data.attached.length < before;
  }

  setDisabled(profileId: string, disabled: boolean): boolean {
    const data = this.read();
    const entry = data.attached.find((item) => item.profileId === profileId);
    if (!entry) return false;
    entry.disabled = disabled;
    entry.quotaState = disabled ? 'disabled' : 'normal';
    this.write(data);
    return true;
  }

  recordUsage(profileId: string): void {
    const data = this.read();
    const entry = data.attached.find((item) => item.profileId === profileId);
    if (!entry) return;
    entry.todayUsedCount += 1;
    entry.lastUsedAt = Date.now();
    this.write(data);
  }

  setQuotaState(profileId: string, state: AttachedFreeModel['quotaState']): void {
    const data = this.read();
    const entry = data.attached.find((item) => item.profileId === profileId);
    if (!entry) return;
    entry.quotaState = state;
    this.write(data);
  }

  /** 记录/覆盖自动注册站点状态。 */
  upsertStationState(state: StationRunState): void {
    const data = this.read();
    data.stationStates = { ...(data.stationStates ?? {}), [state.baseUrl]: state };
    this.write(data);
  }

  listStationStates(): Record<string, StationRunState> {
    return this.read().stationStates ?? {};
  }
}

export interface MailboxPoolFile {
  version: 1;
  accounts: MailboxAccount[];
}

export class MailboxPoolStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  #path(): string {
    return path.join(this.#dataDir, MAILBOX_FILE);
  }

  read(): MailboxPoolFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#path(), 'utf8')) as MailboxPoolFile;
      if (parsed.version === 1 && Array.isArray(parsed.accounts)) return parsed;
    } catch { /* 首次 */ }
    return { version: 1, accounts: [] };
  }

  write(data: MailboxPoolFile): void {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const temporary = path.join(this.#dataDir, '.' + MAILBOX_FILE + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ ...data, version: 1 }, null, 2), 'utf8');
    fs.renameSync(temporary, this.#path());
  }

  add(account: MailboxAccount): { ok: true } | { ok: false; code: string } {
    const data = this.read();
    if (data.accounts.length >= 5) return { ok: false, code: 'mailbox_pool_limit' };
    if (data.accounts.some((item) => item.user === account.user)) return { ok: false, code: 'mailbox_duplicate' };
    data.accounts.push(account);
    this.write(data);
    return { ok: true };
  }

  remove(id: string): boolean {
    const data = this.read();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((item) => item.id !== id);
    this.write(data);
    return data.accounts.length < before;
  }

  list(): MailboxAccount[] {
    return this.read().accounts;
  }

  updateStatus(id: string, ok: boolean): void {
    const data = this.read();
    const account = data.accounts.find((item) => item.id === id);
    if (!account) return;
    account.lastCheckedAt = Date.now();
    if (ok) account.lastOkAt = Date.now();
    this.write(data);
  }
}
