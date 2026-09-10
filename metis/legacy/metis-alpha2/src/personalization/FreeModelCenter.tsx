import './FreeModelCenter.css';
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, TestTube2, Power, AlertTriangle } from 'lucide-react';

/**
 * 免费模型中心（2026-08-23 刘总需求）。
 * 顶部常驻安全风险声明；四个区块：邮箱池 / 发现列表 / 已配置模型 / 扫描源。
 * 所有操作走真实桥接；失败如实显示原因，绝不伪造成功。
 */

interface DiscoveryRow {
  key: string;
  sourceName: string;
  sourceKind: string;
  modelId: string;
  freeTierNote: string;
  latencyMs: number | null;
  probeOk: boolean | null;
  probedAt: number | null;
  attachedProfileId: string | null;
  quotaState: string | null;
}

interface AttachedRow {
  profileId: string;
  sourceName: string;
  modelId: string;
  attachedAt: number;
  disabled: boolean;
  todayUsedCount: number;
  quotaState: string;
}

interface MailboxRow {
  id: string;
  label: string;
  user: string;
  host: string;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
  healthy: boolean;
}

interface SourceRow {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
}

interface StationStateRow {
  baseUrl: string;
  name: string;
  phase: string;
  message: string;
  balanceQuota: number | null;
  balanceUsd: number | null;
  modelCount: number;
  username: string | null;
  systemName: string;
  updatedAt: number;
}

interface AutoRegisterProgressRow {
  running: boolean;
  batchTotal: number;
  batchDone: number;
  stations: StationStateRow[];
}

type MetisBridge = {
  freeModelListSources?: () => Promise<SourceRow[]>;
  freeModelAddSource?: (input: { name: string; baseUrl: string; apiKey?: string }) => Promise<{ ok: boolean; code?: string }>;
  freeModelRemoveSource?: (id: string) => Promise<boolean>;
  freeModelScan?: (probe: boolean) => Promise<{ count: number }>;
  freeModelDiscoverCommunity?: () => Promise<{ found: number; added: number; stations: Array<{ baseUrl: string; name: string; modelCount: number; latencyMs: number }> }>;
  freeModelListDiscoveries?: () => Promise<DiscoveryRow[]>;
  freeModelListAttached?: () => Promise<AttachedRow[]>;
  freeModelAttach?: (discoveryKey: string) => Promise<{ ok: boolean; profileId?: string; code?: string }>;
  freeModelDetach?: (profileId: string) => Promise<{ removedAttachment: boolean; deletedProfile: boolean }>;
  freeModelSetDisabled?: (profileId: string, disabled: boolean) => Promise<boolean>;
  mailboxAdd?: (input: { kind: string; label?: string; user: string; authorizationCode: string }) => Promise<{ ok: boolean; code?: string }>;
  mailboxList?: () => Promise<MailboxRow[]>;
  mailboxRemove?: (id: string) => Promise<boolean>;
  mailboxTestFetch?: (id: string) => Promise<{ ok: boolean; mails?: Array<{ from: string; subject: string; codes: string[] }>; error?: string }>;
  freeModelAutoRegisterBatch?: () => Promise<{ ok: boolean; code?: string }>;
  freeModelStationStates?: () => Promise<Record<string, StationStateRow>>;
  freeModelOmniRouteStatus?: () => Promise<{ running: boolean; models: string[]; latencyMs: number | null; keyConfigured: boolean; error?: string }>;
  freeModelOmniRouteStart?: () => Promise<{ running: boolean; models: string[]; latencyMs: number | null; started: boolean; keyConfigured: boolean; error?: string }>;
  onFreeModelAutoRegisterProgress?: (handler: (snapshot: AutoRegisterProgressRow) => void) => () => void;
};

function bridge(): MetisBridge | undefined {
  return (typeof window !== 'undefined' ? window.metis : undefined) as MetisBridge | undefined;
}

const PHASE_LABELS: Record<string, [string, string]> = {
  pending: ['待处理', 'pending'],
  probing: ['探活中', 'probing'],
  sending_code: ['发送验证码', 'sending code'],
  waiting_code: ['等待验证码', 'waiting for code'],
  registering: ['注册中', 'registering'],
  logging_in: ['登录中', 'logging in'],
  creating_token: ['创建令牌', 'creating token'],
  listing_models: ['获取模型', 'listing models'],
  verifying: ['实证免费性', 'verifying'],
  available: ['可用', 'available'],
  failed: ['失败', 'failed'],
  skipped: ['已跳过', 'skipped'],
};

function phaseLabel(phase: string, zh: boolean): string {
  const pair = PHASE_LABELS[phase];
  return pair ? (zh ? pair[0]! : pair[1]!) : phase;
}

export default function FreeModelCenter({ zh }: { zh: boolean }) {
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([]);
  const [discoveries, setDiscoveries] = useState<DiscoveryRow[]>([]);
  const [attached, setAttached] = useState<AttachedRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [autoDiscovering, setAutoDiscovering] = useState(false);
  const [notice, setNotice] = useState('');
  const [newMailbox, setNewMailbox] = useState({ kind: 'qq', user: '', code: '', host: '', port: 993 });
  const [newSource, setNewSource] = useState({ name: '', baseUrl: '', apiKey: '' });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [stationStates, setStationStates] = useState<Record<string, StationStateRow>>({});
  const [autoRegistering, setAutoRegistering] = useState(false);
  const [omniRoute, setOmniRoute] = useState<{ running: boolean; modelCount: number; latencyMs: number | null; keyConfigured?: boolean; error?: string } | null>(null);
  const [omniStarting, setOmniStarting] = useState(false);

  const refreshAll = useCallback(async () => {
    const bridgeApi = bridge();
    if (!bridgeApi) return;
    try {
      const [mailboxesResult, discoveriesResult, attachedResult, sourcesResult, stationStatesResult] = await Promise.all([
        bridgeApi.mailboxList?.() ?? [],
        bridgeApi.freeModelListDiscoveries?.() ?? [],
        bridgeApi.freeModelListAttached?.() ?? [],
        bridgeApi.freeModelListSources?.() ?? [],
        bridgeApi.freeModelStationStates?.() ?? {},
      ]);
      setMailboxes(mailboxesResult);
      setDiscoveries(discoveriesResult);
      setAttached(attachedResult);
      setSources(sourcesResult);
      setStationStates(stationStatesResult);
    } catch {
      setNotice(zh ? '刷新失败，请重试。' : 'Refresh failed. Retry.');
    }
  }, [zh]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loader; setState happens after awaited IPC
    void refreshAll();
  }, [refreshAll]);

  // 订阅自动注册进度（主进程实时推送）。
  useEffect(() => {
    const subscribe = bridge()?.onFreeModelAutoRegisterProgress;
    if (!subscribe) return undefined;
    return subscribe((snapshot) => {
      setAutoRegistering(snapshot.running);
      setStationStates((previous) => {
        const next = { ...previous };
        for (const station of snapshot.stations) next[station.baseUrl] = station;
        return next;
      });
    });
  }, []);

  // 挂载时检测 OmniRoute 本地网关状态。
  useEffect(() => {
    void (async () => {
      const status = await bridge()?.freeModelOmniRouteStatus?.();
      if (status) setOmniRoute({ running: status.running, modelCount: status.models.length, latencyMs: status.latencyMs, keyConfigured: status.keyConfigured, error: status.error });
    })();
  }, []);

  const runScan = async (probe: boolean) => {
    const scan = bridge()?.freeModelScan;
    if (!scan || scanning) return;
    setScanning(true);
    setNotice(zh ? '正在扫描（探活可能需要几分钟）…' : 'Scanning (probing may take minutes)...');
    try {
      const result = await scan(probe);
      setNotice(zh ? '扫描完成，发现 ' + result.count + ' 个免费模型候选。' : 'Scan finished: ' + result.count + ' free model candidates.');
      await refreshAll();
    } catch {
      setNotice(zh ? '扫描失败，请稍后重试。' : 'Scan failed. Retry later.');
    } finally {
      setScanning(false);
    }
  };

  const attach = async (row: DiscoveryRow) => {
    const attachFn = bridge()?.freeModelAttach;
    if (!attachFn) return;
    const result = await attachFn(row.key);
    if (result.ok) {
      setNotice(zh ? '已接入：' + row.modelId : 'Attached: ' + row.modelId);
      await refreshAll();
    } else {
      setNotice(zh ? '接入失败：' + (result.code ?? '未知原因') : 'Attach failed: ' + (result.code ?? 'unknown'));
    }
  };

  const detach = async (row: AttachedRow) => {
    const detachFn = bridge()?.freeModelDetach;
    if (!detachFn) return;
    const result = await detachFn(row.profileId);
    setNotice(zh
      ? '已删除：' + row.modelId + '（配置移除=' + result.removedAttachment + '，profile 删除=' + result.deletedProfile + '）'
      : 'Detached: ' + row.modelId);
    await refreshAll();
  };

  const toggleDisabled = async (row: AttachedRow) => {
    const setter = bridge()?.freeModelSetDisabled;
    if (!setter) return;
    await setter(row.profileId, !row.disabled);
    await refreshAll();
  };

  const addMailbox = async () => {
    const add = bridge()?.mailboxAdd;
    if (!add) return;
    const result = await add({ kind: newMailbox.kind, user: newMailbox.user, authorizationCode: newMailbox.code });
    if (result.ok) {
      setNewMailbox((prev) => ({ ...prev, user: '', code: '' }));
      setNotice(zh ? '邮箱已加入池，正在验证连接…' : 'Mailbox added. Verifying connection...');
      await refreshAll();
      // 自动测试收取
      const addedItem = mailboxes.find((m) => m.user === newMailbox.user);
      if (addedItem) { await testMailbox(addedItem); }
    } else {
      setNotice(zh ? '添加失败：' + (result.code ?? '') : 'Add failed: ' + (result.code ?? ''));
    }
  };

  const testMailbox = async (row: MailboxRow) => {
    const test = bridge()?.mailboxTestFetch;
    if (!test || testingId) return;
    setTestingId(row.id);
    try {
      const result = await test(row.id);
      setTestResult((previous) => ({ ...previous, [row.id]: result.ok
        ? (zh ? '连接正常，收取 ' + (result.mails?.length ?? 0) + ' 封' : 'OK, fetched ' + (result.mails?.length ?? 0))
        : (zh ? '失败：' : 'Failed: ') + (result.error ?? '') }));
      await refreshAll();
    } finally {
      setTestingId(null);
    }
  };

  const autoDiscover = async () => {
    const discover = bridge()?.freeModelDiscoverCommunity;
    if (!discover || autoDiscovering) return;
    setAutoDiscovering(true);
    setNotice(zh ? '正在自动发现社区公益中转站（GitHub 搜索+探活，可能需要几分钟）…' : 'Auto-discovering community relay stations (GitHub search + probe, may take minutes)...');
    try {
      const result = await discover();
      setNotice(zh ? '自动发现完成：找到 ' + result.found + ' 个站点，新增 ' + result.added + ' 个扫描源。' : 'Discovery done: found ' + result.found + ', added ' + result.added + ' sources.');
      await refreshAll();
    } catch {
      setNotice(zh ? '自动发现失败，请稍后重试。' : 'Auto-discovery failed. Retry later.');
    } finally {
      setAutoDiscovering(false);
    }
  };

  const addSource = async () => {
    const add = bridge()?.freeModelAddSource;
    if (!add) return;
    const result = await add({ name: newSource.name, baseUrl: newSource.baseUrl, apiKey: newSource.apiKey || undefined });
    if (result.ok) {
      setNewSource({ name: '', baseUrl: '', apiKey: '' });
      setNotice(zh ? '扫描源已添加。' : 'Source added.');
      await refreshAll();
    } else {
      setNotice(zh ? '添加失败：' + (result.code ?? '') : 'Add failed: ' + (result.code ?? ''));
    }
  };

  const removeSource = async (id: string) => {
    await bridge()?.freeModelRemoveSource?.(id);
    await refreshAll();
  };

  const runAutoRegister = async () => {
    const run = bridge()?.freeModelAutoRegisterBatch;
    if (!run || autoRegistering) return;
    setAutoRegistering(true);
    setNotice(zh
      ? '自动注册批次进行中：每批最多 5 站，动作间隔 3~5 秒，人机验证站点自动跳过，验证码等待最长 150 秒…'
      : 'Auto-register batch running: up to 5 stations, 3-5s human-like pacing, CAPTCHA sites skipped...');
    try {
      const result = await run();
      if (result.ok) {
        setNotice(zh ? '本批处理完成，站点状态与模型已更新。' : 'Batch finished. Stations and models updated.');
      } else {
        const reasons: Record<string, string> = {
          no_mailbox: zh ? '请先在上方绑定注册邮箱（QQ/163 IMAP）。' : 'Bind a mailbox first.',
          no_pending_stations: zh ? '没有待处理站点；可先点「自动发现站点」。' : 'No pending stations; run auto-discover first.',
          batch_running: zh ? '已有批次在运行。' : 'A batch is already running.',
        };
        setNotice(zh ? '未能启动：' + (reasons[result.code ?? ''] ?? result.code ?? '未知原因') : 'Cannot start: ' + (result.code ?? 'unknown'));
      }
      await refreshAll();
    } catch {
      setNotice(zh ? '自动注册失败，请稍后重试。' : 'Auto-register failed. Retry later.');
    } finally {
      setAutoRegistering(false);
    }
  };

  const startOmniRoute = async () => {
    const start = bridge()?.freeModelOmniRouteStart;
    if (!start || omniStarting) return;
    setOmniStarting(true);
    setNotice(zh ? '正在启动本地 OmniRoute（首次运行需下载安装包，可能需要数分钟）…' : 'Starting local OmniRoute (first run downloads the package, may take minutes)...');
    try {
      const result = await start();
      setOmniRoute({ running: result.running, modelCount: result.models.length, latencyMs: result.latencyMs, keyConfigured: result.keyConfigured, error: result.error });
      setNotice(result.running
        ? (zh ? 'OmniRoute 已就绪：' + result.models.length + ' 个模型。执行「立即扫描」即可出现在发现列表。' : 'OmniRoute ready: ' + result.models.length + ' models. Run a scan to list them.')
        : (zh ? 'OmniRoute 未就绪：' + (result.error ?? '') : 'OmniRoute not ready: ' + (result.error ?? '')));
    } catch {
      setNotice(zh ? 'OmniRoute 启动失败。' : 'OmniRoute start failed.');
    } finally {
      setOmniStarting(false);
    }
  };

  return <div className="free-model-center" data-testid="free-model-center">
    <div className="free-model-warning" role="alert">
      <AlertTriangle size={16} />
      <div>
        <strong>{zh ? '安全风险声明' : 'Security notice'}</strong>
        <p>{zh
          ? '本功能用于接入互联网上公开免费的第三方模型服务，其中中转站为不受 METIS 控制的第三方平台。使用即表示您理解并接受：经其传输的全部内容（含研究资料）对该第三方可见；此类服务的可用性、稳定性与数据安全均不作任何保证；因使用本功能产生的任何后果由使用者自行承担。METIS 不推荐使用陌生中转站，仅为有需要的用户保留该能力。'
          : 'This feature connects to public free third-party model services. Relay stations are third-party platforms outside METIS control. All content sent through them (including research material) is visible to that third party. Availability, stability and data safety are not guaranteed. Use at your own risk. METIS does not recommend unknown relays; the capability is provided as-is.'}</p>
      </div>
    </div>

    {notice && <p className="free-model-notice" role="status">{notice}</p>}

    <section className="free-model-section" aria-label={zh ? '注册邮箱池' : 'Mailbox pool'}>
      <h3>{zh ? '注册邮箱池' : 'Mailbox pool'}</h3>
      <p className="free-model-hint">{zh ? '绑定 QQ / 网易邮箱（需在邮箱设置中开启 IMAP 并生成授权码）。授权码经操作系统级加密存储，仅用于自动收取注册验证邮件。最多 5 个。' : 'Bind QQ / NetEase mailboxes (enable IMAP and create an authorization code first). Codes are OS-encrypted; used only to fetch verification mails. Max 5.'}</p>
      {mailboxes.length === 0
        ? <p className="free-model-empty">{zh ? '还没有绑定邮箱。' : 'No mailboxes bound yet.'}</p>
        : <ul className="free-model-list">
            {mailboxes.map((mailbox) => <li key={mailbox.id}>
              <div className="free-model-row-main">
                <strong>{mailbox.label}</strong>
                <small>{mailbox.user} · {mailbox.host} · {mailbox.healthy ? '✓ 连接正常' : '尚未验证，点击测试收取验证'}</small>
              </div>
              <div className="free-model-row-ops">
                <button type="button" disabled={testingId === mailbox.id} onClick={() => void testMailbox(mailbox)}><TestTube2 size={13} />{zh ? '测试收取' : 'Test'}</button>
                <button type="button" onClick={() => void bridge()?.mailboxRemove?.(mailbox.id).then(() => refreshAll())}><Trash2 size={13} /></button>
              </div>
              {testResult[mailbox.id] && <small className="free-model-test-result">{testResult[mailbox.id]}</small>}
            </li>)}
          </ul>}
      <div className="free-model-add-form">
        <select value={newMailbox.kind} onChange={(event) => { const kind = event.target.value; setNewMailbox({ ...newMailbox, kind }); }} aria-label={zh ? '邮箱类型' : 'Mailbox kind'}>
          <option value="qq">QQ 邮箱</option>
          <option value="163">网易 163</option>
          <option value="126">网易 126</option>
          <option value="custom">自定义 (IMAP)</option>
        </select>
        <input value={newMailbox.user} onChange={(event) => setNewMailbox({ ...newMailbox, user: event.target.value })} placeholder={zh ? '邮箱地址' : 'email address'} aria-label={zh ? '邮箱地址' : 'Email address'} />
        {newMailbox.kind === 'custom' && (
          <>
            <input value={newMailbox.host || ''} onChange={(e2) => setNewMailbox({ ...newMailbox, host: e2.target.value })} placeholder={zh ? 'IMAP 主机 (如 imap.example.com)' : 'IMAP host'} aria-label={zh ? 'IMAP 主机' : 'IMAP host'} style={{ width: '100%' }} />
            <input type="number" value={newMailbox.port || 993} onChange={(e3) => setNewMailbox({ ...newMailbox, port: Number(e3.target.value) || 993 })} placeholder={zh ? '端口 (默认993)' : 'port (default 993)'} aria-label={zh ? 'IMAP 端口' : 'IMAP port'} style={{ width: '100%' }} />
          </>
        )}
        <input type="password" value={newMailbox.code} onChange={(event) => setNewMailbox({ ...newMailbox, code: event.target.value })} placeholder={zh ? 'IMAP 授权码' : 'IMAP auth code'} aria-label={zh ? 'IMAP 授权码' : 'IMAP auth code'} />
        <button type="button" onClick={() => void addMailbox()} disabled={!newMailbox.user.trim() || !newMailbox.code.trim()}><Plus size={13} />{zh ? '绑定' : 'Bind'}</button>
      </div>
    </section>

    <section className="free-model-section" aria-label={zh ? '自动注册扫描' : 'Auto register scan'}>
      <header className="free-model-section-header">
        <h3>{zh ? '自动注册扫描（每批 5 站）' : 'Auto-register scan (5 per batch)'}</h3>
        <button type="button" className="free-model-primary" onClick={() => void runAutoRegister()} disabled={autoRegistering || scanning}>
          <RefreshCw size={13} className={autoRegistering ? 'spin' : ''} />
          {autoRegistering ? (zh ? '注册流程进行中…' : 'Running…') : (zh ? '开始扫描并注册' : 'Scan & register')}
        </button>
      </header>
      <p className="free-model-hint">{zh
        ? '流程：探活 → 自动注册（统一密码 Metis123456）→ 邮箱收码 → 登录 → 创建令牌 → 列出免费模型与体验余额。操作间隔 3~5 秒模拟人工节奏；需要人机验证的站点自动跳过，绝不尝试绕过。'
        : 'Probe → register (shared password) → email code → login → create token → list free models and trial balance. Human-like 3-5s pacing; CAPTCHA sites are skipped, never bypassed.'}</p>
      {Object.keys(stationStates).length === 0
        ? <p className="free-model-empty">{zh ? '还没有站点状态；先在下方「扫描源」里自动发现站点，再开始扫描注册。' : 'No station states yet; auto-discover stations below first.'}</p>
        : <ul className="free-model-list">
            {Object.values(stationStates).sort((a, b) => a.name.localeCompare(b.name)).map((station) => <li key={station.baseUrl} data-phase={station.phase}>
              <div className="free-model-row-main">
                <strong>{station.systemName || station.name}</strong>
                <small>{station.baseUrl}{station.username ? ' · ' + station.username : ''}{station.phase === 'available' && station.balanceUsd !== null ? (zh ? ' · 体验余额 $' + station.balanceUsd : ' · balance $' + station.balanceUsd) : ''}{station.modelCount > 0 ? (zh ? ' · 模型 ' + station.modelCount + ' 个' : ' · ' + station.modelCount + ' models') : ''}</small>
                {station.message && <small className="free-model-test-result">{station.message}</small>}
              </div>
              <div className="free-model-row-ops"><span className={'free-model-chip phase-' + station.phase}>{phaseLabel(station.phase, zh)}</span></div>
            </li>)}
          </ul>}
    </section>

    <section className="free-model-section" aria-label={zh ? '发现列表' : 'Discoveries'}>
      <header className="free-model-section-header">
        <h3>{zh ? '发现列表（每日自动扫描）' : 'Discoveries (daily auto scan)'}</h3>
        <button type="button" className="free-model-primary" onClick={() => void runScan(true)} disabled={scanning}>
          <RefreshCw size={13} className={scanning ? 'spin' : ''} />{scanning ? (zh ? '扫描中…' : 'Scanning…') : (zh ? '立即扫描（含探活）' : 'Scan now (probe)')}
        </button>
      </header>
      {discoveries.length === 0
        ? <p className="free-model-empty">{zh ? '还没有扫描结果；点击上方按钮开始。' : 'No scan results yet; run a scan above.'}</p>
        : <ul className="free-model-list">
            {discoveries.map((row) => <li key={row.key}>
              <div className="free-model-row-main">
                <strong>{row.modelId}</strong>
                <small>{row.sourceName} · {row.freeTierNote}{row.latencyMs !== null ? ' · ' + row.latencyMs + 'ms' : ''}{row.probeOk === false ? (zh ? ' · 探活失败' : ' · probe failed') : ''}</small>
              </div>
              <div className="free-model-row-ops">
                {row.attachedProfileId
                  ? <small>{zh ? '已接入' : 'attached'}</small>
                  : <button type="button" onClick={() => void attach(row)} disabled={scanning}><Plus size={13} />{zh ? '接入' : 'Attach'}</button>}
              </div>
            </li>)}
          </ul>}
    </section>

    <section className="free-model-section" aria-label={zh ? '已配置模型' : 'Configured models'}>
      <header className="free-model-section-header"><h3>{zh ? '已配置模型' : 'Configured models'}</h3><small>{attached.length} 个</small></header>
      {attached.length === 0
        ? <p className="free-model-empty">{zh ? '还没有从发现列表接入模型。' : 'No models attached from discoveries.'}</p>
        : <ul className="free-model-list">
            {attached.map((row) => <li key={row.profileId} className={row.disabled ? 'disabled' : ''}>
              <div className="free-model-row-main">
                <strong>{row.modelId}</strong>
                <small>{row.sourceName} · {zh ? '今日用量' : 'today'} {row.todayUsedCount} · {row.quotaState === 'exhausted' ? (zh ? '额度已尽' : 'exhausted') : row.quotaState === 'disabled' ? (zh ? '已停用' : 'disabled') : (zh ? '正常' : 'normal')}</small>
              </div>
              <div className="free-model-row-ops">
                <button type="button" onClick={() => void toggleDisabled(row)}><Power size={13} />{row.disabled ? (zh ? '启用' : 'Enable') : (zh ? '停用' : 'Disable')}</button>
                <button type="button" onClick={() => void detach(row)} aria-label={zh ? '删除 ' + row.modelId : 'Delete ' + row.modelId}><Trash2 size={13} />{zh ? '删除' : 'Delete'}</button>
              </div>
            </li>)}
          </ul>}
    </section>

    <section className="free-model-section" aria-label={zh ? '扫描源' : 'Scan sources'}>
      <header className="free-model-section-header"><h3>{zh ? '扫描源' : 'Scan sources'}</h3><div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}><button type="button" className="free-model-primary" onClick={() => void autoDiscover()} disabled={autoDiscovering || scanning} style={{ fontSize: '11px', padding: '4px 8px' }}><RefreshCw size={11} className={autoDiscovering ? 'spin' : ''} />{autoDiscovering ? (zh ? '发现中…' : 'Discovering…') : (zh ? '自动发现站点' : 'Auto-discover')}</button><small>{sources.length} 个</small></div></header>
      <ul className="free-model-list">
        {sources.map((source) => <li key={source.id}>
          <div className="free-model-row-main"><strong>{source.name}</strong><small>{source.baseUrl}</small></div>
          <div className="free-model-row-ops">
            <button type="button" onClick={() => void removeSource(source.id)} aria-label={zh ? '删除源 ' + source.name : 'Delete source ' + source.name}><Trash2 size={13} /></button>
          </div>
        </li>)}
      </ul>
      <div className="free-model-add-form">
        <input value={newSource.name} onChange={(event) => setNewSource({ ...newSource, name: event.target.value })} placeholder={zh ? '站点名称' : 'name'} aria-label={zh ? '站点名称' : 'Source name'} />
        <input value={newSource.baseUrl} onChange={(event) => setNewSource({ ...newSource, baseUrl: event.target.value })} placeholder="https://…/v1" aria-label={zh ? '站点地址' : 'Base URL'} />
        <input type="password" value={newSource.apiKey} onChange={(event) => setNewSource({ ...newSource, apiKey: event.target.value })} placeholder={zh ? 'key（可选）' : 'key (optional)'} aria-label={zh ? '站点密钥' : 'API key'} />
        <button type="button" onClick={() => void addSource()} disabled={!newSource.name.trim() || !newSource.baseUrl.trim()}><Plus size={13} />{zh ? '添加' : 'Add'}</button>
      </div>
    </section>

    <section className="free-model-section" aria-label={zh ? 'OmniRoute 本地网关' : 'OmniRoute gateway'}>
      <header className="free-model-section-header">
        <h3>{zh ? 'OmniRoute 本地网关（开源项目）' : 'OmniRoute local gateway (open-source project)'}</h3>
        <span className={'free-model-chip ' + (omniRoute?.running ? 'phase-available' : omniRoute === null ? 'phase-pending' : 'phase-failed')}>
          {omniRoute === null
            ? (zh ? '检测中…' : 'checking…')
            : omniRoute.running
              ? (zh ? '运行中 · ' + omniRoute.modelCount + ' 个模型' + (omniRoute.keyConfigured ? ' · API key 已配置' : ' · 未配置key') : 'running · ' + omniRoute.modelCount + ' models' + (omniRoute.keyConfigured ? ' · key configured' : ''))
              : (zh ? '未运行' : 'stopped')}
        </span>
      </header>
      <p className="free-model-hint">{zh
        ? '注意：OmniRoute 是开源自托管 AI 网关「项目」，不是中转站聚合平台，无需注册账号。它在本地聚合 290 个 provider 的免费层（90+ 免费档），暴露 OpenAI 兼容 /v1 接口，零配置即可用。启动后会作为内置扫描源出现在发现列表中。'
        : 'Note: OmniRoute is an open-source self-hosted AI gateway PROJECT (not a relay aggregator; no signup needed). It aggregates free tiers of 290 providers behind a local OpenAI-compatible /v1 endpoint. Once running it appears as a builtin scan source.'}</p>
      <div className="free-model-add-form">
        <button type="button" onClick={() => void startOmniRoute()} disabled={omniStarting}>
          <Power size={13} />{omniStarting ? (zh ? '启动中…' : 'Starting…') : (zh ? '一键启动（npx omniroute）' : 'Start via npx omniroute')}
        </button>
        {omniRoute && !omniRoute.running && omniRoute.error && <small className="free-model-test-result">{omniRoute.error}</small>}
      </div>
    </section>
  </div>;
}
