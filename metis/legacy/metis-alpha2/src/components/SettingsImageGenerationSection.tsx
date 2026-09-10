import { useCallback, useEffect, useState } from 'react';
import {
  ImageGenerationSettingsSchema,
  ImageGenerationSettingsUpdateSchema,
  OutcomeImageSettingsGetResultSchema,
  type ImageGenerationSettings,
} from '../../engine/runtime/OutcomeRuntimeContract.js';
import './SettingsImageGenerationSection.css';

const OUTCOME_IMAGE_SECRET = 'OUTCOME_IMAGE_API_KEY';
const QUALITY_OPTIONS = [
  ['standard', '标准'],
  ['hd', '高清'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
] as const;

type SettingsSaveFailureCode = 'invalid_request' | 'storage_unavailable' | 'secret_not_found' | 'settings_write_failed';

type SettingsSaveResult =
  | { ok: true; settings: ImageGenerationSettings }
  | { ok: false; code: SettingsSaveFailureCode };

type ImageSettingsBridge = {
  getOutcomeImageSettings?: () => Promise<unknown>;
  setOutcomeImageSettings?: (settings: {
    provider: string;
    model: string;
    endpoint: string;
    defaultQuality: ImageGenerationSettings['defaultQuality'];
    apiKeyRef: '${secret:OUTCOME_IMAGE_API_KEY}' | null;
  }) => Promise<unknown>;
  listPersonalizationSecrets?: (request: {
    contractVersion: 1;
    operationId: string;
  }) => Promise<unknown>;
  setPersonalizationSecret?: (request: {
    contractVersion: 1;
    operationId: string;
    expectedRevision: number;
    name: string;
    value: string;
  }) => Promise<unknown>;
};

type VaultListResult = {
  ok: boolean;
  revision?: number;
  secrets?: Array<{ name?: string }>;
  code?: string;
};

type VaultSetResult = {
  ok: boolean;
  revision?: number;
  code?: string;
};

type Notice = { tone: 'error' | 'success' | 'info'; text: string } | null;

function imageBridge(): ImageSettingsBridge {
  return (window.metis ?? {}) as unknown as ImageSettingsBridge;
}

function decodeVaultList(value: unknown): VaultListResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean') return null;
  return {
    ok: raw.ok,
    revision: typeof raw.revision === 'number' ? raw.revision : undefined,
    secrets: Array.isArray(raw.secrets)
      ? raw.secrets.filter((item): item is { name?: string } => !!item && typeof item === 'object')
      : undefined,
    code: typeof raw.code === 'string' ? raw.code : undefined,
  };
}

function decodeVaultSet(value: unknown): VaultSetResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean') return null;
  return {
    ok: raw.ok,
    revision: typeof raw.revision === 'number' ? raw.revision : undefined,
    code: typeof raw.code === 'string' ? raw.code : undefined,
  };
}

function decodeSettingsSave(value: unknown): SettingsSaveResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.ok === true) {
    const settings = ImageGenerationSettingsSchema.safeParse(raw.settings);
    return settings.success ? { ok: true, settings: settings.data } : null;
  }
  if (raw.ok !== false || typeof raw.code !== 'string') return null;
  if (raw.code === 'invalid_request' || raw.code === 'storage_unavailable' || raw.code === 'secret_not_found' || raw.code === 'settings_write_failed') {
    return { ok: false, code: raw.code };
  }
  return null;
}

function userFacingSaveError(code: SettingsSaveFailureCode): string {
  switch (code) {
    case 'invalid_request': return '图片生成设置未通过校验，未保存。';
    case 'storage_unavailable': return '图片生成设置存储当前不可用，未保存。';
    case 'secret_not_found': return '已引用的图片 API 密钥不存在，请重新输入后保存。';
    case 'settings_write_failed': return '图片生成设置写入失败，未保存。';
    default: return '图片生成设置保存失败，未保存。';
  }
}

export default function SettingsImageGenerationSection() {
  const [settings, setSettings] = useState<ImageGenerationSettings | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [defaultQuality, setDefaultQuality] = useState<ImageGenerationSettings['defaultQuality']>('standard');
  const [apiKey, setApiKey] = useState('');
  const [vaultRevision, setVaultRevision] = useState<number | null>(null);
  const [vaultHasKey, setVaultHasKey] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'unavailable'>('loading');
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const api = imageBridge();
    if (!api.getOutcomeImageSettings || !api.listPersonalizationSecrets) {
      setPhase('unavailable');
      setNotice({ tone: 'error', text: '成果图片生成设置服务或加密凭据库不可用；没有读取或保存任何配置。' });
      return;
    }
    setPhase('loading');
    setNotice(null);
    try {
      const [rawSettings, rawSecrets] = await Promise.all([
        api.getOutcomeImageSettings(),
        api.listPersonalizationSecrets({ contractVersion: 1, operationId: crypto.randomUUID() }),
      ]);
      const parsedSettings = OutcomeImageSettingsGetResultSchema.safeParse(rawSettings);
      const parsedSecrets = decodeVaultList(rawSecrets);
      if (!parsedSettings.success) {
        setPhase('unavailable');
        setNotice({ tone: 'error', text: '成果图片生成设置响应无效，未显示或修改配置。' });
        return;
      }
      if (!parsedSettings.data.ok) {
        setPhase('unavailable');
        setNotice({ tone: 'error', text: `成果图片生成设置当前不可读取：${parsedSettings.data.code}。未显示或修改配置。` });
        return;
      }
      if (!parsedSecrets?.ok || parsedSecrets.revision === undefined || !parsedSecrets.secrets) {
        setPhase('unavailable');
        setNotice({ tone: 'error', text: `无法读取加密凭据库元数据${parsedSecrets?.code ? `：${parsedSecrets.code}` : ''}；未显示或修改配置。` });
        return;
      }
      setSettings(parsedSettings.data.settings);
      setProvider(parsedSettings.data.settings.provider);
      setModel(parsedSettings.data.settings.model);
      setEndpoint(parsedSettings.data.settings.endpoint);
      setDefaultQuality(parsedSettings.data.settings.defaultQuality);
      setVaultRevision(parsedSecrets.revision);
      setVaultHasKey(parsedSecrets.secrets.some((secret) => secret.name === OUTCOME_IMAGE_SECRET));
      setPhase('ready');
    } catch {
      setPhase('unavailable');
      setNotice({ tone: 'error', text: '无法读取成果图片生成设置；没有显示或修改配置。' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => { if (!cancelled) await load(); });
    return () => { cancelled = true; };
  }, [load]);

  const save = async () => {
    const api = imageBridge();
    if (!api.setOutcomeImageSettings || !api.setPersonalizationSecret || vaultRevision === null || !settings) {
      setNotice({ tone: 'error', text: '成果图片生成设置服务尚未就绪，未保存。' });
      return;
    }
    const trimmedKey = apiKey.trim();
    const hasStoredKey = settings.hasApiKey === true && vaultHasKey === true;
    const update = ImageGenerationSettingsUpdateSchema.safeParse({
      provider: provider.trim(),
      model: model.trim(),
      endpoint: endpoint.trim(),
      defaultQuality,
      apiKeyRef: trimmedKey || hasStoredKey ? '${secret:OUTCOME_IMAGE_API_KEY}' : null,
    });
    if (!update.success) {
      setNotice({ tone: 'error', text: '请填写有效的服务商、模型和接口地址（如填写接口地址，必须使用 HTTPS）后再保存。' });
      return;
    }
    setPhase('saving');
    setNotice(null);
    let revision = vaultRevision;
    try {
      if (trimmedKey) {
        const secretResult = decodeVaultSet(await api.setPersonalizationSecret({
          contractVersion: 1,
          operationId: crypto.randomUUID(),
          expectedRevision: revision,
          name: OUTCOME_IMAGE_SECRET,
          value: trimmedKey,
        }));
        if (!secretResult?.ok || secretResult.revision === undefined) {
          if (secretResult?.code === 'revision_conflict') await load();
          else setPhase('ready');
          setNotice({ tone: 'error', text: `图片 API 密钥未保存${secretResult?.code ? `：${secretResult.code}` : ''}。` });
          return;
        }
        revision = secretResult.revision;
        setVaultRevision(revision);
        setVaultHasKey(true);
      }
      const saved = decodeSettingsSave(await api.setOutcomeImageSettings(update.data));
      if (!saved?.ok) {
        setPhase('ready');
        setNotice({
          tone: 'error',
          text: saved
            ? `${userFacingSaveError(saved.code)}${trimmedKey ? '图片 API 密钥已单独保存到加密凭据库。' : ''}`
            : '图片生成设置响应无效，未确认保存结果。',
        });
        return;
      }
      setSettings(saved.settings);
      setProvider(saved.settings.provider);
      setModel(saved.settings.model);
      setEndpoint(saved.settings.endpoint);
      setDefaultQuality(saved.settings.defaultQuality);
      setApiKey('');
      setVaultHasKey(saved.settings.hasApiKey);
      setPhase('ready');
      setNotice({ tone: 'success', text: '成果图片生成配置已保存。未执行外部 Provider 连通性测试。' });
    } catch {
      setPhase('ready');
      setNotice({ tone: 'error', text: '保存成果图片生成配置时发生错误，未确认配置已保存。' });
    }
  };

  const isBusy = phase === 'loading' || phase === 'saving';
  const stateLabel = phase === 'loading'
    ? '正在读取'
    : phase === 'unavailable'
      ? '状态不可用'
      : settings?.hasApiKey && vaultHasKey
        ? '已配置'
        : '未配置';
  const stateKind = phase === 'ready'
    ? settings?.hasApiKey && vaultHasKey ? 'configured' : 'unconfigured'
    : phase;

  return (
    <section className="settings-group settings-image-generation" aria-labelledby="image-generation-settings-title" data-testid="image-generation-settings-section">
      <div className="settings-section-heading">
        <div>
          <p className="settings-section-kicker">成果</p>
          <h3 id="image-generation-settings-title">成果图片生成</h3>
        </div>
        <span className={`settings-image-generation__state settings-image-generation__state--${stateKind}`} data-testid="image-generation-settings-state">
          {stateLabel}
        </span>
      </div>
      <p className="settings-hint">
        为 Word 和 PPT 成果中的图片生成配置独立模型。API 密钥仅写入现有加密凭据库，界面不会回显，也不会在此页面伪造连通性结果。
      </p>

      <div className="settings-image-generation__grid">
        <label className="settings-label">
          <span>服务商</span>
          <input className="settings-input" value={provider} disabled={isBusy || phase === 'unavailable'} data-testid="image-generation-provider" placeholder="例如 openai" onChange={(event) => setProvider(event.target.value)} />
        </label>
        <label className="settings-label">
          <span>模型</span>
          <input className="settings-input" value={model} disabled={isBusy || phase === 'unavailable'} data-testid="image-generation-model" placeholder="例如 gpt-image-1" onChange={(event) => setModel(event.target.value)} />
        </label>
        <label className="settings-label settings-image-generation__endpoint">
          <span>接口地址</span>
          <input className="settings-input" type="url" value={endpoint} disabled={isBusy || phase === 'unavailable'} data-testid="image-generation-endpoint" placeholder="https://api.example.com/v1/images/generations" onChange={(event) => setEndpoint(event.target.value)} />
        </label>
        <label className="settings-label">
          <span>默认质量</span>
          <select className="settings-input" value={defaultQuality} disabled={isBusy || phase === 'unavailable'} data-testid="image-generation-quality" onChange={(event) => setDefaultQuality(event.target.value as ImageGenerationSettings['defaultQuality'])}>
            {QUALITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {/* 刘总要求：密钥降级为普通表单一行，与默认质量并排；说明压缩为一行小字，不再用大卡片。 */}
        <label className="settings-label">
          <span>图片 API 密钥</span>
          <input className="settings-input" type="password" autoComplete="new-password" value={apiKey} disabled={isBusy || phase === 'unavailable'} data-testid="image-generation-api-key" placeholder={settings?.hasApiKey && vaultHasKey ? '输入新密钥以替换' : '输入 API 密钥'} onChange={(event) => setApiKey(event.target.value)} />
          <small className="settings-image-generation__field-hint">
            {settings?.hasApiKey && vaultHasKey ? '已安全存储；输入新密钥即替换，原值不会显示。' : '密钥仅写入加密凭据库 OUTCOME_IMAGE_API_KEY，原值不会显示。'}
          </small>
        </label>
      </div>

      <div className="settings-actions">
        <button type="button" className="btn-sm btn-primary" disabled={isBusy || phase === 'unavailable'} data-testid="image-generation-save" onClick={() => void save()}>
          {phase === 'saving' ? '保存中…' : '保存图片生成配置'}
        </button>
        <button type="button" className="btn-sm btn-secondary" disabled={isBusy} data-testid="image-generation-reload" onClick={() => void load()}>
          重新读取
        </button>
      </div>
      {notice && <p role="status" aria-live="polite" data-testid="image-generation-settings-notice" className={`settings-image-generation__notice settings-image-generation__notice--${notice.tone}`}>{notice.text}</p>}
    </section>
  );
}
