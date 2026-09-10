/**
 * 免费模型中心的主进程服务（2026-08-23 刘总需求）。
 * 组合 ProviderProfileStore（正规接入路径）+ ModelDiscoveryStore（发现缓存）
 * + MailboxPoolStore（邮箱池），为 IPC 层提供完整能力。
 *
 * 接入动作永远走 providerProfiles 正规 save 路径（key 加密 + 文件完整性 MAC）；
 * 删除走正规 delete 路径。本类不做任何绕过存储完整性的操作。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { ModelDiscoveryStore, type AttachedFreeModel } from './ModelDiscoveryStore.js';
import { MailboxPoolStore } from './ModelDiscoveryStore.js';
import { scanFreeModels } from '../engine/providers/discovery/ProviderDiscoveryService.js';
import { discoverCommunityStations } from '../engine/providers/discovery/CommunitySourceDiscovery.js';
import {
  AutoRegisterScheduler,
  type AutoRegisterMailboxReader,
  type AutoRegisterProgress,
  type StationRunState,
  type VerificationCandidate,
} from '../engine/providers/discovery/AutoRegisterScheduler.js';
import { NewApiClient } from '../engine/providers/discovery/NewAPIClient.js';
import {
  OMNIROUTE_DEFAULT_BASE_URL,
  OMNIROUTE_DEFAULT_PASSWORD,
  omniRouteCreateApiKey,
  omniRouteKeyWorks,
  omniRouteLaunchSpec,
  omniRouteLogin,
  probeOmniRoute,
} from '../engine/providers/discovery/OmniRouteGateway.js';
import { decodeMimeText, extractVerification, MAILBOX_PRESETS } from '../engine/mail/MailboxPool.js';
import type { ProviderProfileStore } from './ProviderProfileStore.js';

export interface FreeModelIpcDeps {
  dataDir: string;
  decryptProfileKey(profileId: string): string | null;
  providerProfileStore: ProviderProfileStore;
  encryptSecret(plain: string): string;
  decryptSecret(cipher: string): string;
  /** 正规删除入口：main 注入 providerProfiles:delete 的 store 调用。 */
  deleteProfile(id: string, revision: number): Promise<boolean>;
  /** 自动注册进度上报（main 注入：转发到渲染窗口）。 */
  emitAutoRegisterProgress?(snapshot: AutoRegisterProgress): void;
}

interface SaveOutcome {
  ok: boolean;
  profileId?: string;
  code?: string;
}

export class FreeModelService {
  readonly #discovery: ModelDiscoveryStore;
  readonly #mailboxes: MailboxPoolStore;
  readonly #deps: FreeModelIpcDeps;

  constructor(deps: FreeModelIpcDeps) {
    this.#deps = deps;
    this.#discovery = new ModelDiscoveryStore(deps.dataDir);
    this.#mailboxes = new MailboxPoolStore(deps.dataDir);
  }

  listSources(): Array<{ id: string; kind: string; name: string; baseUrl: string; enabled: boolean; hasKey: boolean }> {
    return this.#discovery.read().sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      baseUrl: source.baseUrl,
      enabled: source.enabled,
      hasKey: Boolean(source.encryptedKey),
    }));
  }

  addSource(input: { name: string; baseUrl: string; apiKey?: string }): { ok: true; id: string } | { ok: false; code: string } {
    const name = input.name.trim().slice(0, 100);
    const baseUrl = input.baseUrl.trim();
    if (!name || !baseUrl.startsWith('http')) return { ok: false, code: 'invalid_request' };
    const data = this.#discovery.read();
    if (data.sources.some((item) => item.baseUrl === baseUrl)) return { ok: false, code: 'duplicate_source' };
    const source = {
      id: 'src-' + randomUUID(),
      kind: 'newapi' as const,
      name,
      baseUrl,
      encryptedKey: input.apiKey ? this.#deps.encryptSecret(input.apiKey) : undefined,
      enabled: true,
    };
    data.sources.push(source);
    this.#discovery.write(data);
    return { ok: true, id: source.id };
  }

  removeSource(id: string): boolean {
    const data = this.#discovery.read();
    const before = data.sources.length;
    data.sources = data.sources.filter((item) => item.id !== id);
    this.#discovery.write(data);
    return data.sources.length < before;
  }

  /**
   * 每日调度入口：距上次扫描超过 staleHours 小时则后台补扫一次（含探活）。
   * 返回是否实际执行了扫描。
   */
  async scanIfStale(staleHours = 20): Promise<boolean> {
    const data = this.#discovery.read();
    if (data.lastScanAt && Date.now() - data.lastScanAt < staleHours * 3_600_000) return false;
    await this.scanNow(true);
    return true;
  }

  /** 内置源兜底：OpenRouter 永远可用（公开 models API），首次扫描前自动注入。 */
  private ensureBuiltinSources(data: { sources: Array<{ id: string; kind: string; name: string; baseUrl: string; enabled: boolean; encryptedKey?: string }> }): void {
    if (!data.sources.some((source) => source.kind === 'openrouter')) {
      data.sources.push({
        id: 'openrouter-builtin',
        kind: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        enabled: true,
      });
    }
    // OmniRoute（刘总 2026-08-24 指定）：本地自托管网关项目，非注册站点。
    if (!data.sources.some((source) => source.kind === 'omniroute')) {
      data.sources.push({
        id: 'omniroute-local',
        kind: 'omniroute',
        name: 'OmniRoute 本地网关',
        baseUrl: OMNIROUTE_DEFAULT_BASE_URL,
        enabled: true,
      });
    }
  }

  async scanNow(probe: boolean): Promise<{ count: number }> {
    const data = this.#discovery.read();
    this.ensureBuiltinSources(data);
    const keysBySource = new Map<string, string | undefined>();
    for (const source of data.sources) {
      if (source.kind === 'openrouter') {
        keysBySource.set(source.id, this.#openrouterActiveKey() ?? undefined);
      } else if (source.encryptedKey) {
        let decrypted: string | undefined;
        try { decrypted = this.#deps.decryptSecret(source.encryptedKey); } catch { decrypted = undefined; }
        keysBySource.set(source.id, decrypted);
      }
    }
    const models = await scanFreeModels({ sources: data.sources, keysBySource, probe });
    this.#discovery.upsertScan(data.sources, models);
    return { count: models.length };
  }

  /** 自动发现社区公益中转站并添加为扫描源。 */
  async discoverCommunitySources(): Promise<{ found: number; added: number; stations: Array<{ baseUrl: string; name: string; modelCount: number; latencyMs: number }> }> {
    const data = this.#discovery.read();
    const existingUrls = new Set(data.sources.map((source) => source.baseUrl.replace(/\/+$/u, '')));
    const stations = await discoverCommunityStations({ excludeBaseUrls: [...existingUrls], maxStations: 20 });
    let added = 0;
    for (const station of stations) {
      const source = {
        id: 'src-community-' + randomUUID(),
        kind: 'newapi' as const,
        name: station.name.slice(0, 100),
        baseUrl: station.baseUrl,
        enabled: true,
      };
      data.sources.push(source);
      added += 1;
    }
    if (added > 0) this.#discovery.write(data);
    return { found: stations.length, added, stations };
  }

  listDiscoveries(): Array<Record<string, unknown>> {
    const data = this.#discovery.read();
    const attachedByKey = new Map(data.attached.map((entry) => [entry.discoveryKey, entry]));
    return data.models.map((model) => ({
      key: model.key,
      sourceName: model.sourceName,
      sourceKind: model.sourceKind,
      modelId: model.modelId,
      freeTierNote: model.freeTierNote,
      latencyMs: model.latencyMs,
      probeOk: model.probeOk,
      probedAt: model.probedAt,
      discoveredAt: model.discoveredAt,
      attachedProfileId: attachedByKey.get(model.key)?.profileId ?? null,
      quotaState: attachedByKey.get(model.key)?.quotaState ?? null,
    }));
  }

  listAttached(): AttachedFreeModel[] {
    return this.#discovery.read().attached;
  }

  /**
   * 把发现的模型接入为正式 profile：走 providerProfiles 正规 save
   * （key 加密 + 文件 MAC）。OpenRouter 模型复用已激活 profile 的 key；
   * revision 冲突时重读重试一次。幂等：重复接入返回既有 profile。
   */
  async attachModel(discoveryKey: string): Promise<{ ok: true; profileId: string } | { ok: false; code: string }> {
    const data = this.#discovery.read();
    const model = data.models.find((item) => item.key === discoveryKey);
    if (!model) return { ok: false, code: 'model_not_found' };
    const source = data.sources.find((item) => item.id === model.sourceId);
    let apiKey: string | null = null;
    if (model.sourceKind === 'openrouter') {
      apiKey = this.#openrouterActiveKey();
    } else if (model.sourceKind === 'omniroute') {
      // 本地网关默认无鉴权；有 key 则解密使用。
      try { apiKey = source?.encryptedKey ? this.#deps.decryptSecret(source.encryptedKey) : 'local'; } catch { apiKey = 'local'; }
    } else if (source?.encryptedKey) {
      try { apiKey = this.#deps.decryptSecret(source.encryptedKey); } catch { apiKey = null; }
    }
    if (!apiKey || !source) return { ok: false, code: 'api_key_unavailable' };
    const baseUrl = model.sourceKind === 'openrouter' ? 'https://openrouter.ai/api/v1' : source.baseUrl;

    const listedNow = this.#deps.providerProfileStore.list();
    const existing = data.attached.find((item) => item.discoveryKey === discoveryKey);
    if (existing && listedNow.ok && listedNow.value.profiles.some((profile) => profile.id === existing.profileId)) {
      return { ok: true, profileId: existing.profileId };
    }

    const displayName = ('free-' + model.modelId).slice(0, 96);
    const firstAttempt = await this.saveWithRevision(this.currentRevision(), displayName, baseUrl, model.modelId, apiKey);
    if (firstAttempt.ok && firstAttempt.profileId) {
      this.#discovery.markAttached(firstAttempt.profileId, discoveryKey, model.sourceName, model.modelId);
      return { ok: true, profileId: firstAttempt.profileId };
    }
    if (firstAttempt.code !== 'revision_conflict') return { ok: false, code: firstAttempt.code ?? 'save_failed' };
    // revision 竞争：重读后重试一次。
    const retried = await this.saveWithRevision(this.currentRevision(), displayName, baseUrl, model.modelId, apiKey);
    if (retried.ok && retried.profileId) {
      this.#discovery.markAttached(retried.profileId, discoveryKey, model.sourceName, model.modelId);
      return { ok: true, profileId: retried.profileId };
    }
    return { ok: false, code: retried.code ?? 'save_failed' };
  }

  private async saveWithRevision(revision: number, displayName: string, baseUrl: string, modelId: string, apiKey: string): Promise<SaveOutcome> {
    const request = {
      contractVersion: 1,
      operationId: randomUUID(),
      expectedRevision: revision,
      name: displayName,
      baseUrl,
      model: modelId,
      vision: false,
      maxContextTokens: 0,
      keyMode: 'replace',
      newApiKey: apiKey,
      timeout: 1_800_000,
      maxRetries: 20,
      retryBackoffSeconds: 1,
    };
    const saved = await this.#deps.providerProfileStore.save(request as Parameters<ProviderProfileStore['save']>[0]);
    if (!saved.ok) return { ok: false, code: saved.code ?? 'save_failed' };
    return { ok: true, profileId: saved.value.profile.id };
  }

  private currentRevision(): number {
    const listed = this.#deps.providerProfileStore.list();
    return listed.ok ? listed.value.revision : 0;
  }

  async detachModel(profileId: string): Promise<{ removedAttachment: boolean; deletedProfile: boolean }> {
    const removedAttachment = this.#discovery.detach(profileId);
    const deletedProfile = await this.#deps.deleteProfile(profileId, this.currentRevision());
    return { removedAttachment, deletedProfile };
  }

  setDisabled(profileId: string, disabled: boolean): boolean {
    return this.#discovery.setDisabled(profileId, disabled);
  }

  recordUsage(profileId: string): void {
    this.#discovery.recordUsage(profileId);
  }

  setQuotaState(profileId: string, state: AttachedFreeModel['quotaState']): void {
    this.#discovery.setQuotaState(profileId, state);
  }

  #openrouterActiveKey(): string | null {
    try {
      const listed = this.#deps.providerProfileStore.list();
      if (!listed.ok) return null;
      const active = listed.value.profiles.find((profile) => profile.isActive && /openrouter/iu.test(profile.name))
        ?? listed.value.profiles.find((profile) => profile.isActive);
      if (!active) return null;
      return this.#deps.decryptProfileKey(active.id);
    } catch {
      return null;
    }
  }

  // ── 自动注册（分批，每批 5 站，刘总 2026-08-24 需求） ──

  #autoRegisterRunning = false;
  #mailboxCursor = 0;

  listStationStates(): Record<string, StationRunState> {
    return this.#discovery.listStationStates();
  }

  /**
   * 跑一批自动注册：候选为未处理/失败的 newapi 启用源（available 与 skipped 不再重试），
   * 每批最多 5 个；邮箱池轮转取号；进度实时持久化并上报。
   */
  async runAutoRegisterBatch(): Promise<{ ok: true; progress: AutoRegisterProgress } | { ok: false; code: string }> {
    if (this.#autoRegisterRunning) return { ok: false, code: 'batch_running' };
    const accounts = this.#mailboxes.list();
    if (accounts.length === 0) return { ok: false, code: 'no_mailbox' };
    const account = accounts[this.#mailboxCursor % accounts.length];
    this.#mailboxCursor = (this.#mailboxCursor + 1) % Math.max(accounts.length, 1);
    let mailboxSecret = '';
    try { mailboxSecret = this.#deps.decryptSecret(account.encryptedSecret); } catch { return { ok: false, code: 'decrypt_failed' }; }

    const data = this.#discovery.read();
    const states = data.stationStates ?? {};
    const normalize = (url: string): string => url.replace(/\/+$/u, '');
    const pending = data.sources
      .filter((source) => source.kind === 'newapi' && source.enabled)
      .filter((source) => {
        const phase = states[normalize(source.baseUrl)]?.phase;
        return phase !== 'available' && phase !== 'skipped';
      })
      .sort((a, b) => {
        // 未处理站优先于失败重试站。
        const rank = (source: typeof a): number => (states[normalize(source.baseUrl)]?.phase === 'failed' ? 1 : 0);
        return rank(a) - rank(b);
      })
      .slice(0, 5);
    if (pending.length === 0) return { ok: false, code: 'no_pending_stations' };

    this.#autoRegisterRunning = true;
    try {
      const mailboxReader: AutoRegisterMailboxReader = {
        fetchVerificationCandidates: (user, sinceMs) =>
          this.#fetchVerificationCandidates(account.host, account.port, user, mailboxSecret, sinceMs),
      };
      const scheduler = new AutoRegisterScheduler({
        client: new NewApiClient(),
        mailboxReader,
        mailboxUser: account.user,
        onProgress: (snapshot) => {
          for (const station of snapshot.stations) this.#discovery.upsertStationState(station);
          this.#deps.emitAutoRegisterProgress?.(snapshot);
        },
      });
      const { progress, outcomes } = await scheduler.runBatch(
        pending.map((source) => ({
          baseUrl: source.baseUrl,
          name: source.name,
          existingUsername: states[normalize(source.baseUrl)]?.username ?? null,
        })),
      );
      // 成功站点：源绑定 key（正规加密存储），模型并入发现列表。
      const fresh = this.#discovery.read();
      for (const outcome of outcomes) {
        if (outcome.state.phase !== 'available' || !outcome.apiKey) continue;
        const index = fresh.sources.findIndex((source) => source.baseUrl.replace(/\/+$/u, '') === outcome.state.baseUrl);
        if (index < 0) continue;
        const source = fresh.sources[index]!;
        source.encryptedKey = this.#deps.encryptSecret(outcome.apiKey);
        if (outcome.state.systemName && source.name !== outcome.state.systemName) source.name = outcome.state.systemName.slice(0, 100);
        const others = fresh.models.filter((model) => model.sourceId !== source.id);
        const added = outcome.models.map((modelId) => ({
          key: source.id + '|' + modelId,
          sourceId: source.id,
          sourceName: source.name,
          sourceKind: 'newapi' as const,
          modelId,
          freeTierNote: '自动注册 · ' + (outcome.state.balanceUsd !== null ? '体验余额 $' + outcome.state.balanceUsd : '公益免费'),
          latencyMs: null,
          probeOk: null,
          probedAt: null,
          discoveredAt: Date.now(),
        }));
        fresh.models = [...others, ...added];
      }
      this.#discovery.write(fresh);
      return { ok: true, progress };
    } finally {
      this.#autoRegisterRunning = false;
    }
  }

  /** 连接邮箱拉取验证候选（验证码/链接）。每轮独立连接，QQ/163 对该频率可接受。 */
  async #fetchVerificationCandidates(host: string, port: number, user: string, secret: string, sinceMs: number): Promise<VerificationCandidate[]> {
    const client = new ImapFlow({
      host, port,
      secure: true,
      auth: { user, pass: secret },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });
    await client.connect();
    try {
      // 2026-08-24 实证：QQ 会把中转站验证邮件判进 Junk 垃圾箱（米醋API 验证邮件实测落入 Junk），
      // 必须同时遍历收件箱与垃圾箱，否则永远等不到验证码。
      const folders = ['INBOX', 'Junk'];
      const results: VerificationCandidate[] = [];
      for (const folder of folders) {
        try {
          const meta: Array<{ uid: number; date: number; from: string; subject: string }> = [];
          const listLock = await client.getMailboxLock(folder);
          try {
            for await (const message of client.fetch('1:*', { uid: true, envelope: true })) {
              meta.push({
                uid: message.uid,
                date: message.envelope?.date ? new Date(message.envelope.date).getTime() : 0,
                from: message.envelope?.from?.[0]?.address ?? '',
                subject: message.envelope?.subject ?? '',
              });
            }
          } finally { listLock.release(); }
          const newest = meta.sort((a, b) => b.date - a.date).slice(0, 8);
          const bodyLock = await client.getMailboxLock(folder);
          try {
            for (const item of newest) {
              if (item.date > 0 && item.date < sinceMs - 120_000) continue;
              const downloaded = await client.download(item.uid, undefined, { uid: true, maxBytes: 131_072 });
              let bodyText = '';
              if (downloaded && downloaded.content) {
                for await (const chunk of downloaded.content) {
                  bodyText += String(chunk);
                  if (bodyText.length > 120_000) break;
                }
              }
              const verification = extractVerification(decodeMimeText(bodyText));
              results.push({
                codes: verification.codes.slice(0, 4),
                links: verification.links.slice(0, 6),
                from: item.from,
                subject: item.subject,
                date: item.date,
              });
            }
          } finally { bodyLock.release(); }
        } catch { /* 单文件夹失败（如无 Junk）不阻塞其他文件夹 */ }
      }
      return results;
    } finally {
      try { await client.logout(); } catch { try { client.close(); } catch { /* noop */ } }
    }
  }

  // ── OmniRoute 本地网关 ──

  async omniRouteStatus(): Promise<{ running: boolean; models: string[]; latencyMs: number | null; keyConfigured: boolean; error?: string }> {
    const probe = await probeOmniRoute((url, init) => fetch(url, init as never));
    const source = this.#discovery.read().sources.find((item) => item.kind === 'omniroute');
    return { ...probe, keyConfigured: Boolean(source?.encryptedKey) };
  }

  /**
   * 刘总 2026-08-24：网关就绪后自动登录（默认 CHANGEME）→ 创建/复用 API key →
   * 加密写进 omniroute 源，实现「开箱即可用」的内置体验。
   * 幂等：已有可用 key 直接复用，不重复创建。
   */
  async ensureOmniRouteKey(): Promise<{ ok: boolean; keyConfigured: boolean; error?: string }> {
    const fetchLike = (url: string, init?: Record<string, unknown>) => fetch(url, init as never);
    const data = this.#discovery.read();
    this.ensureBuiltinSources(data);
    const source = data.sources.find((item) => item.kind === 'omniroute');
    if (!source) return { ok: false, keyConfigured: false, error: 'omniroute_source_missing' };
    // 已有 key 且可用 → 复用。
    if (source.encryptedKey) {
      try {
        const existing = this.#deps.decryptSecret(source.encryptedKey);
        if (await omniRouteKeyWorks(fetchLike, source.baseUrl, existing)) return { ok: true, keyConfigured: true };
      } catch { /* 解密失败则重建 */ }
    }
    const login = await omniRouteLogin(fetchLike, source.baseUrl, OMNIROUTE_DEFAULT_PASSWORD);
    if (!login.ok) {
      return { ok: false, keyConfigured: false, error: 'dashboard 登录失败（若您改过默认密码，请在控制台手动创建 key 并填入扫描源）：' + login.error };
    }
    const created = await omniRouteCreateApiKey(fetchLike, source.baseUrl, login.cookie, 'metis-auto');
    if (!created.ok) return { ok: false, keyConfigured: false, error: '创建 API key 失败：' + created.error };
    source.encryptedKey = this.#deps.encryptSecret(created.key);
    this.#discovery.write(data);
    return { ok: true, keyConfigured: true };
  }

  /** 引导启动本地 OmniRoute（npx -y omniroute@latest），轮询就绪最长 90 秒；就绪后自动配置 API key。 */
  async omniRouteStart(): Promise<{ running: boolean; models: string[]; latencyMs: number | null; started: boolean; keyConfigured: boolean; error?: string }> {
    const before = await this.omniRouteStatus();
    if (before.running) {
      const ensured = await this.ensureOmniRouteKey();
      return { ...before, started: false, keyConfigured: ensured.keyConfigured, error: ensured.ok ? before.error : ensured.error };
    }
    const spec = omniRouteLaunchSpec();
    try {
      fs.mkdirSync(this.#deps.dataDir, { recursive: true });
      const logPath = path.join(this.#deps.dataDir, 'omniroute.log');
      const out = fs.openSync(logPath, 'a');
      const child = spawn(spec.command, spec.args, {
        shell: true,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', out, out],
      });
      child.unref();
    } catch (error) {
      return { running: false, models: [], latencyMs: null, started: false, keyConfigured: false, error: '启动失败：' + String(error instanceof Error ? error.message : error) };
    }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const status = await this.omniRouteStatus();
      if (status.running) {
        const ensured = await this.ensureOmniRouteKey();
        return { ...status, started: true, keyConfigured: ensured.keyConfigured, error: ensured.ok ? status.error : ensured.error };
      }
    }
    return {
      running: false,
      models: [],
      latencyMs: null,
      started: true,
      keyConfigured: false,
      error: '已发起启动但 90 秒内未就绪（首次 npx 需下载安装包，可稍后刷新状态）',
    };
  }

  // ── 邮箱池 ──

  addMailbox(input: { kind: string; label?: string; user: string; authorizationCode: string; host?: string; port?: number }): { ok: true; id: string } | { ok: false, code: string } {
    const host = input.host || MAILBOX_PRESETS[input.kind]?.host;
    if (!host) return { ok: false, code: 'unsupported_mailbox_kind' };
    const user = input.user.trim().toLowerCase();
    if (!user.includes('@') || user.includes(' ') || user.length < 5) return { ok: false, code: 'invalid_email' };
    if (!input.authorizationCode || input.authorizationCode.length < 6) return { ok: false, code: 'invalid_authorization_code' };
    const added = this.#mailboxes.add({
      id: 'mb-' + randomUUID(),
      label: (input.label?.trim() || user.split('@')[0]).slice(0, 60),
      host: input.host || MAILBOX_PRESETS[input.kind]?.host || '',
      port: input.port || MAILBOX_PRESETS[input.kind]?.port || 993,
      user,
      encryptedSecret: this.#deps.encryptSecret(input.authorizationCode),
      createdAt: Date.now(),
      lastCheckedAt: null,
      lastOkAt: null,
    });
    if (!added.ok) return { ok: false, code: added.code };
    const addedAccount = this.#mailboxes.list().find((item) => item.user === user);
    return { ok: true, id: addedAccount?.id ?? '' };
  }

  listMailboxes(): Array<{ id: string; label: string; user: string; host: string; createdAt: number; lastCheckedAt: number | null; lastOkAt: number | null; healthy: boolean }> {
    return this.#mailboxes.list().map((account) => ({
      id: account.id,
      label: account.label,
      user: account.user,
      host: account.host,
      createdAt: account.createdAt,
      lastCheckedAt: account.lastCheckedAt,
      lastOkAt: account.lastOkAt,
      healthy: account.lastOkAt !== null,
    }));
  }

  removeMailbox(id: string): boolean {
    return this.#mailboxes.remove(id);
  }

  async testAndFetchMailbox(id: string): Promise<{ ok: boolean; mails?: Array<{ from: string; subject: string; date: number; codes: string[]; links: string[] }>; error?: string }> {
    const accounts = this.#mailboxes.list();
    const account = accounts.find((item) => item.id === id);
    if (!account) return { ok: false, error: 'not_found' };
    let secret: string;
    try {
      secret = this.#deps.decryptSecret(account.encryptedSecret);
    } catch {
      this.#mailboxes.updateStatus(id, false);
      return { ok: false, error: 'decrypt_failed' };
    }
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: true,
      auth: { user: account.user, pass: secret },
      logger: false,
    });
    try {
      await client.connect();
      const mails: Array<{ from: string; subject: string; date: number; codes: string[]; links: string[] }> = [];
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const message of client.fetch('1:*', { uid: true, envelope: true })) {
          if (mails.length >= 10) break;
          // 只取正文头部若干 KB 用于验证码/链接提取，避免大附件拖慢。
          const downloaded = await client.download(message.uid, undefined, { uid: true, maxBytes: 131072 });
          let bodyText = '';
          if (downloaded && downloaded.content) {
            for await (const chunk of downloaded.content) {
              bodyText += String(chunk);
              if (bodyText.length > 120_000) break;
            }
          }
          const decodedBody = decodeMimeText(bodyText);
          mails.push({
            from: message.envelope?.from?.[0]?.address ?? '',
            subject: message.envelope?.subject ?? '',
            date: message.envelope?.date ? new Date(message.envelope.date).getTime() : 0,
            codes: extractCodes(decodedBody),
            links: extractLinks(decodedBody),
          });
        }
      } finally {
        lock.release();
      }
      this.#mailboxes.updateStatus(id, true);
      return { ok: true, mails };
    } catch (error) {
      this.#mailboxes.updateStatus(id, false);
      return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) };
    } finally {
      try { await client.logout(); } catch { try { client.close(); } catch { /* noop */ } }
    }
  }
}

function extractCodes(bodyText: string): string[] {
  const codes = new Set<string>();
  for (const match of bodyText.matchAll(/(?:验证码|verification code|code)[^0-9A-Za-z]{0,16}([0-9]{4,8})/giu)) codes.add(match[1]!);
  if (codes.size === 0) {
    for (const match of bodyText.matchAll(/\b(\d{6})\b/gu)) codes.add(match[1]!);
  }
  return [...codes].slice(0, 4);
}

function extractLinks(bodyText: string): string[] {
  const raw = bodyText.match(/https?:\/\/[^\s"'<>)]+/gu) ?? [];
  const cleaned = [...new Set(raw.map((link) => link.replace(/[.,;!?]+$/u, '')))];
  return cleaned.slice(0, 3);
}
