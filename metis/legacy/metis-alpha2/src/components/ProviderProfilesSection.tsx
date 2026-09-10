import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import FreeModelCenter from '../personalization/FreeModelCenter.js';
import type {
  ProviderProfileSaveRequest,
  ProviderProfileSummary,
} from '../../engine/runtime/ProviderProfileContract.js';

type FormState = {
  id: string | null;
  name: string;
  baseUrl: string;
  model: string;
  vision: boolean;
  maxContextTokens: number;
  timeout: number;
  maxRetries: number;
  apiKey: string;
};

type Notice = { kind: 'success' | 'error' | 'info'; message: string } | null;

// timeout/maxRetries 默认值（2026-09-06 P0 遗留）：与 ProviderProfileStore.save 的
// 缺省语义对齐（30s/2），这里给更贴近真实使用的 10 分钟/2 次——:free 渠道推理慢，
// 10 分钟足够一次完整生成，同时不会像 30 分钟那样把失败拖成黑盒。
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 2;

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  vision: false,
  maxContextTokens: 0,
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  apiKey: '',
};

function operationId(action: string): string {
  return `provider-profile-${action}-${Date.now().toString(36)}`;
}

export default function ProviderProfilesSection() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([]);
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState<'idle' | 'loading' | 'saving' | 'testing' | 'switching' | 'deleting'>('loading');
  const [notice, setNotice] = useState<Notice>(null);
  // 免费API二级窗口 + 连接方式选择（2026-08-23 刘总需求：手动配置 / 扫描免费 两种模式）。
  const [freeModelsOpen, setFreeModelsOpen] = useState(false);
  const [connectionModeOpen, setConnectionModeOpen] = useState(false);

  const activeProfile = useMemo(() => profiles.find((profile) => profile.isActive) ?? null, [profiles]);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === form.id) ?? null,
    [form.id, profiles],
  );

  const load = useCallback(async (preserveSelection = true) => {
    const metis = window.metis;
    if (!metis?.providerProfilesList) {
      setNotice({ kind: 'error', message: zh ? '安全模型连接服务不可用。' : 'Secure model connection service is unavailable.' });
      setBusy('idle');
      return;
    }
    setBusy('loading');
    try {
      const response = await metis.providerProfilesList({ contractVersion: 1, operationId: operationId('list') });
      if (!response.ok) {
        setNotice({ kind: 'error', message: zh ? `无法读取模型连接（${response.code}）。` : `Could not load model connections (${response.code}).` });
        return;
      }
      setProfiles(response.profiles);
      setRevision(response.revision);
      if (!preserveSelection) setForm(EMPTY_FORM);
      if (!preserveSelection) {
        const profile = response.profiles.find((item) => item.isActive) ?? response.profiles[0];
        if (profile) selectProfile(profile);
      }
    } catch {
      setNotice({ kind: 'error', message: zh ? '读取模型连接时发生错误。' : 'An error occurred while loading model connections.' });
    } finally {
      setBusy('idle');
    }
  }, [zh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Defer so the async load runs after the effect commit instead of
      // synchronously during it (keeps React Compiler memoization valid).
      await Promise.resolve();
      if (cancelled) return;
      await load(false);
    })();
    return () => { cancelled = true; };
  }, [load]);

  function selectProfile(profile: ProviderProfileSummary) {
    setForm({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      vision: profile.vision,
      maxContextTokens: profile.maxContextTokens,
      timeout: profile.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: profile.maxRetries ?? DEFAULT_MAX_RETRIES,
      apiKey: '',
    });
  }

  function startNew() {
    setForm(EMPTY_FORM);
    setNotice(null);
  }

  function patchForm(patch: Partial<FormState>) {
    setForm((previous) => ({ ...previous, ...patch }));
  }

  const save = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.providerProfilesSave) {
      setNotice({ kind: 'error', message: zh ? '安全模型连接服务不可用。' : 'Secure model connection service is unavailable.' });
      return;
    }
    // 密钥框为空且是已保存连接 → keyMode 'saved'（保留原钥）；输入了新值 → 'replace'。
    const replacingKey = form.apiKey.trim() !== '';
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim() || (!form.id && !replacingKey)) {
      setNotice({ kind: 'error', message: zh ? '请填写连接名称、接口地址、模型和 API 密钥。' : 'Enter a connection name, API URL, model, and API key.' });
      return;
    }
    setBusy('saving');
    setNotice(null);
    const request: ProviderProfileSaveRequest = {
      contractVersion: 1,
      operationId: operationId('save'),
      expectedRevision: revision,
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      vision: form.vision,
      maxContextTokens: Math.max(0, Math.floor(form.maxContextTokens || 0)),
      timeout: Math.max(1_000, Math.floor(form.timeout || DEFAULT_TIMEOUT_MS)),
      maxRetries: Math.max(0, Math.floor(form.maxRetries ?? DEFAULT_MAX_RETRIES)),
      keyMode: form.id && !replacingKey ? 'saved' : 'replace',
      ...(replacingKey ? { newApiKey: form.apiKey.trim() } : {}),
    };
    try {
      const response = await metis.providerProfilesSave(request);
      if (!response.ok) {
        setNotice({ kind: 'error', message: zh ? `保存失败（${response.code}）。` : `Save failed (${response.code}).` });
        if (response.code === 'revision_conflict') await load(false);
        return;
      }
      setRevision(response.revision);
      setForm((previous) => ({
        ...previous,
        id: response.profile?.id ?? previous.id,
        apiKey: '',
      }));
      setNotice({ kind: 'success', message: zh ? '模型连接已安全保存。' : 'Model connection saved securely.' });
      await load(true);
    } catch {
      setNotice({ kind: 'error', message: zh ? '保存模型连接时发生错误。' : 'An error occurred while saving the model connection.' });
    } finally {
      setBusy('idle');
    }
  }, [form, load, revision, zh]);

  const testConnection = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.setupProbe) {
      setNotice({ kind: 'error', message: zh ? '连接测试服务不可用。' : 'Connection testing is unavailable.' });
      return;
    }
    const testingNewKey = form.apiKey.trim() !== '';
    if (!testingNewKey && !form.id) {
      setNotice({ kind: 'error', message: zh ? '请输入 API 密钥后再测试。' : 'Enter an API key before testing.' });
      return;
    }
    if (!testingNewKey && (!selectedProfile || !selectedProfile.isActive)) {
      setNotice({ kind: 'info', message: zh ? '密钥框为空时只能测试当前正在使用的连接；请先切换到此连接，或直接输入 API 密钥后测试。' : 'With an empty key box only the active connection can be probed; switch to this connection first, or enter an API key.' });
      return;
    }
    setBusy('testing');
    setNotice(null);
    try {
      const response = await metis.setupProbe({
        version: 1,
        operationId: operationId('test'),
        keyMode: testingNewKey ? 'replace' : 'saved',
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        ...(testingNewKey ? { newApiKey: form.apiKey.trim() } : {}),
      });
      if (response?.success) {
        setNotice({ kind: 'success', message: zh ? '连接已验证，可安全保存。' : 'Connection verified and ready to save.' });
      } else {
        const code = response && 'recovery' in response ? response.recovery?.code : 'probe_failed';
        setNotice({ kind: 'error', message: zh ? `连接测试失败（${code}）。` : `Connection test failed (${code}).` });
      }
    } catch {
      setNotice({ kind: 'error', message: zh ? '连接测试时发生错误。' : 'An error occurred during the connection test.' });
    } finally {
      setBusy('idle');
    }
  }, [form, selectedProfile, zh]);

  const switchProfile = useCallback(async (profile: ProviderProfileSummary) => {
    const metis = window.metis;
    if (!metis?.providerProfilesSwitch || profile.isActive) return;
    setBusy('switching');
    setNotice(null);
    try {
      const response = await metis.providerProfilesSwitch({
        contractVersion: 1,
        operationId: operationId('switch'),
        expectedRevision: revision,
        id: profile.id,
      });
      if (!response.ok) {
        setNotice({ kind: 'error', message: zh ? `切换失败（${response.code}）。` : `Switch failed (${response.code}).` });
        if (response.code === 'revision_conflict') await load(false);
        return;
      }
      setRevision(response.revision);
      setNotice({ kind: 'success', message: zh ? `已切换至「${profile.name}」。` : `Switched to “${profile.name}”.` });
      await load(false);
    } catch {
      setNotice({ kind: 'error', message: zh ? '切换模型连接时发生错误。' : 'An error occurred while switching the model connection.' });
    } finally {
      setBusy('idle');
    }
  }, [load, revision, zh]);

  const deleteProfile = useCallback(async (profile: ProviderProfileSummary) => {
    const metis = window.metis;
    if (!metis?.providerProfilesDelete) return;
    if (profile.isActive) {
      setNotice({ kind: 'info', message: zh ? '当前连接不能直接删除；请先明确切换到另一连接。' : 'The current connection cannot be deleted directly; switch to another connection first.' });
      return;
    }
    setBusy('deleting');
    setNotice(null);
    try {
      const response = await metis.providerProfilesDelete({
        contractVersion: 1,
        operationId: operationId('delete'),
        expectedRevision: revision,
        id: profile.id,
      });
      if (!response.ok) {
        setNotice({ kind: 'error', message: zh ? `删除失败（${response.code}）。` : `Delete failed (${response.code}).` });
        return;
      }
      if (form.id === profile.id) startNew();
      setRevision(response.revision);
      setNotice({ kind: 'success', message: zh ? '模型连接已删除。' : 'Model connection deleted.' });
      await load(true);
    } catch {
      setNotice({ kind: 'error', message: zh ? '删除模型连接时发生错误。' : 'An error occurred while deleting the model connection.' });
    } finally {
      setBusy('idle');
    }
  }, [form.id, load, revision, zh]);

  const isBusy = busy !== 'idle';

  return (
    <section className="settings-group provider-profiles" aria-labelledby="provider-profiles-title">
      <div className="settings-section-heading">
        <div>
          <p className="settings-section-kicker">{zh ? '连接' : 'Connections'}</p>
          <h3 id="provider-profiles-title">{zh ? '模型连接' : 'Model connections'}</h3>
        </div>
        <button type="button" className="btn-sm btn-secondary" onClick={() => setConnectionModeOpen(true)} disabled={isBusy} data-testid="provider-profile-new">
          {zh ? '新增连接' : 'New connection'}
        </button>
      </div>
      <p className="settings-hint">{zh ? '每个连接独立保存模型、上下文窗口和加密密钥。当前连接会在下次启动时自动恢复。' : 'Each connection keeps its model, context window, and encrypted key separately. The current connection is restored at startup.'}</p>

      <div className="provider-profiles__layout">
        <div className="provider-profiles__list" aria-label={zh ? '已保存的模型连接' : 'Saved model connections'}>
          {profiles.length === 0 && (
            <p className="provider-profiles__empty">{zh ? '尚未保存模型连接。' : 'No model connections saved yet.'}</p>
          )}
          {profiles.map((profile) => (
            <div key={profile.id} className={`provider-profile-row ${form.id === profile.id ? 'selected' : ''}`}>
              <button
                type="button"
                className="provider-profile-row__select"
                onClick={() => { selectProfile(profile); setNotice(null); }}
                aria-pressed={form.id === profile.id}
              >
                <span className="provider-profile-row__name">{profile.name}</span>
                <span className="provider-profile-row__model">{profile.model}</span>
                {profile.isActive && <span className="provider-profile-row__active">{zh ? '当前' : 'Current'}</span>}
              </button>
              <div className="provider-profile-row__actions">
                {!profile.isActive && <button type="button" className="btn-sm btn-secondary" onClick={() => void switchProfile(profile)} disabled={isBusy}>{zh ? '切换' : 'Switch'}</button>}
                <button type="button" className="btn-sm btn-secondary" onClick={() => void deleteProfile(profile)} disabled={isBusy} aria-label={zh ? `删除 ${profile.name}` : `Delete ${profile.name}`}>{zh ? '删除' : 'Delete'}</button>
              </div>
            </div>
          ))}
        </div>

        <div className="provider-profiles__editor">
          <label className="settings-label">
            {zh ? '连接名称' : 'Connection name'}
            <input className="settings-input" value={form.name} onChange={(event) => patchForm({ name: event.target.value })} disabled={isBusy} autoComplete="off" data-testid="provider-profile-name" />
          </label>
          <label className="settings-label">
            {zh ? 'API 地址' : 'API base URL'}
            <input className="settings-input" value={form.baseUrl} onChange={(event) => patchForm({ baseUrl: event.target.value })} disabled={isBusy} autoComplete="off" spellCheck={false} data-testid="provider-profile-baseurl" />
          </label>
          <label className="settings-label">
            {zh ? '模型名称' : 'Model'}
            <input className="settings-input" value={form.model} onChange={(event) => patchForm({ model: event.target.value })} disabled={isBusy} autoComplete="off" spellCheck={false} data-testid="provider-profile-model" />
          </label>
          <div className="provider-profiles__two-col">
            <label className="settings-label">
              {zh ? '最大上下文（0 = 自动）' : 'Max context (0 = auto)'}
              <input className="settings-input" type="number" min={0} step={1000} value={form.maxContextTokens || ''} onChange={(event) => patchForm({ maxContextTokens: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} disabled={isBusy} />
            </label>
            <label className="provider-profiles__check">
              <input type="checkbox" checked={form.vision} onChange={(event) => patchForm({ vision: event.target.checked })} disabled={isBusy} />
              {zh ? '支持图像理解' : 'Supports vision'}
            </label>
          </div>
          <div className="provider-profiles__two-col">
            <label className="settings-label">
              {zh ? '请求超时（毫秒）' : 'Request timeout (ms)'}
              <input className="settings-input" type="number" min={1000} step={1000} value={form.timeout} onChange={(event) => patchForm({ timeout: Math.max(1_000, Math.floor(Number(event.target.value) || 0)) })} disabled={isBusy} data-testid="provider-profile-timeout" />
            </label>
            <label className="settings-label">
              {zh ? '失败重试次数' : 'Max retries'}
              <input className="settings-input" type="number" min={0} step={1} value={form.maxRetries} onChange={(event) => patchForm({ maxRetries: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} disabled={isBusy} data-testid="provider-profile-maxretries" />
            </label>
          </div>
          <label className="settings-label">
            {zh ? 'API 密钥' : 'API key'}
            {/* 常驻密码框：已保存时框内以加密点占位，可直接输入新值覆盖；留空保存则保留原钥。 */}
            <input
              type="password"
              className="settings-input"
              value={form.apiKey}
              onChange={(event) => patchForm({ apiKey: event.target.value })}
              placeholder={form.id ? '••••••••（已安全保存；输入新值即更换）' : ''}
              disabled={isBusy}
              autoComplete="new-password"
              spellCheck={false}
              data-testid="provider-profile-apikey"
            />
          </label>
          <div className="settings-actions">
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={isBusy} data-testid="provider-profile-save">
              {busy === 'saving' ? (zh ? '保存中…' : 'Saving…') : (zh ? '安全保存' : 'Save securely')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => void testConnection()} disabled={isBusy}>
              {busy === 'testing' ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试连接' : 'Test connection')}
            </button>
          </div>
        </div>
      </div>
      {notice && <div className={`provider-profiles__notice provider-profiles__notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live="polite" data-testid="provider-profile-notice">{notice.message}</div>}
      {activeProfile && <p className="provider-profiles__footnote">{zh ? `当前：${activeProfile.name} · ${activeProfile.model}` : `Current: ${activeProfile.name} · ${activeProfile.model}`}</p>}
      {connectionModeOpen && (
        <div className="connection-mode-overlay" role="presentation">
          <div className="connection-mode-dialog" role="dialog" aria-modal="true" aria-label={zh ? '选择连接方式' : 'Choose connection method'}>
            <h3>{zh ? '新增模型连接' : 'New model connection'}</h3>
            <p>{zh ? '请选择连接的接入方式：' : 'Choose how to add the connection:'}</p>
            <div className="connection-mode-options">
              <button type="button" className="connection-mode-option" data-testid="connection-mode-manual" onClick={() => { setConnectionModeOpen(false); startNew(); }}>
                <strong>{zh ? '手动配置 API' : 'Manual configuration'}</strong>
                <span>{zh ? '使用自己的 API 服务与密钥，手动填写接口地址、模型和密钥。' : 'Use your own API service and key; fill in endpoint, model and key manually.'}</span>
              </button>
              <button type="button" className="connection-mode-option" data-testid="connection-mode-free" onClick={() => { setConnectionModeOpen(false); setFreeModelsOpen(true); }}>
                <strong>{zh ? '扫描免费API' : 'Scan free APIs'}</strong>
                <span>{zh ? '自动发现互联网公开的免费模型渠道并接入。存在第三方数据与稳定性风险，请谨慎评估。' : 'Auto-discover public free model channels. Third-party privacy and stability risks apply.'}</span>
              </button>
            </div>
            <button type="button" className="btn-sm btn-secondary" onClick={() => setConnectionModeOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
          </div>
        </div>
      )}
      {freeModelsOpen && (
        <div className="free-api-overlay" role="presentation">
          <div className="free-api-window" role="dialog" aria-modal="true" aria-label={zh ? '免费API' : 'Free API'}>
            <header className="free-api-window__header">
              <div><strong>{zh ? '免费API — 扫描与接入' : 'Free API - scan and attach'}</strong><small>{zh ? '每日自动发现互联网公开的免费模型渠道；接入前请阅读安全风险声明。' : 'Daily discovery of public free model channels; read the security notice before attaching.'}</small></div>
              <button type="button" className="free-api-window__close" onClick={() => setFreeModelsOpen(false)} aria-label={zh ? '关闭' : 'Close'}>×</button>
            </header>
            <div className="free-api-window__body">
              <FreeModelCenter zh={zh} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
