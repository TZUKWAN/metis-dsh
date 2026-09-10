/**
 * SettingsMarketTokensSection — 市场/集成令牌统一管理（设置页）。
 *
 * 复用主进程加密凭据库（PersonalizationSecretVault，OS 安全存储）：
 * 值绝不回显，界面只显示“已配置/未配置”。市场请求（技能市场、MCP 市场、
 * GitHub 搜索/下载）从同一凭据库按名称读取令牌；未配置时走匿名限额。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';

/** 预置令牌清单：名称即加密凭据库中的 secret 名（大写/下划线，与 MCP 环境变量同规则）。 */
const TOKEN_SLOTS: ReadonlyArray<{ name: string; labelZh: string; labelEn: string; hintZh: string; hintEn: string; url: string; urlLabel: string; requiredZh: string; requiredEn: string }> = [
  {
    name: 'MARKET_GITHUB_TOKEN',
    labelZh: 'GitHub 访问令牌',
    labelEn: 'GitHub access token',
    hintZh: '技能/MCP 市场搜索与下载走 GitHub API；无令牌时使用匿名限额（每小时 60 次搜索）。',
    hintEn: 'Market search/download uses the GitHub API; without a token the anonymous quota applies.',
    url: 'https://github.com/settings/tokens',
    urlLabel: 'github.com/settings/tokens',
    requiredZh: '非必须：不配置也可用，仅受匿名限额。',
    requiredEn: 'Optional: works without one, just rate-limited.',
  },
  {
    name: 'MARKET_SKILLHUB_TOKEN',
    labelZh: 'skillhub.cn 令牌',
    labelEn: 'skillhub.cn token',
    hintZh: '该站点暂无公开匿名 API，令牌不影响当前市场能力。',
    hintEn: 'No public anonymous API on this site; the token does not change current market capabilities.',
    url: 'https://skillhub.cn',
    urlLabel: 'skillhub.cn',
    requiredZh: '无需配置：当前不接入该源。',
    requiredEn: 'Not needed: this source is not integrated.',
  },
  {
    name: 'MARKET_MCPMARKET_CN_TOKEN',
    labelZh: 'mcpmarket.cn 令牌',
    labelEn: 'mcpmarket.cn token',
    hintZh: '匿名搜索/详情已可用；令牌仅用于该站自身的登录态能力，不影响 Metis 搜索。',
    hintEn: 'Anonymous search/detail already works; the token only affects that site’s own login-gated features.',
    url: 'https://mcpmarket.cn',
    urlLabel: 'mcpmarket.cn',
    requiredZh: '非必须：搜索/详情无需令牌。',
    requiredEn: 'Optional: search/detail works without one.',
  },
  {
    name: 'MARKET_MCPMARKET_COM_TOKEN',
    labelZh: 'mcpmarket.com 令牌',
    labelEn: 'mcpmarket.com token',
    hintZh: '该站点被边缘防护拦截，Metis 当前无法访问，令牌不影响当前能力。',
    hintEn: 'The site is blocked by edge protection; Metis cannot reach it, so the token has no effect now.',
    url: 'https://mcpmarket.com',
    urlLabel: 'mcpmarket.com',
    requiredZh: '无需配置：当前不可访问。',
    requiredEn: 'Not needed: the site is unreachable now.',
  },
];

export default function SettingsMarketTokensSection() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [revision, setRevision] = useState(0);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const list = window.metis?.listPersonalizationSecrets;
    if (!list) {
      setStatus(zh ? '加密凭据库不可用。' : 'Encrypted credential vault unavailable.');
      return;
    }
    try {
      const response = await list({ contractVersion: 1, operationId: crypto.randomUUID() });
      if (!response.ok) {
        setStatus(`${zh ? '无法读取凭据元数据' : 'Credential metadata unavailable'}: ${response.code}`);
        return;
      }
      setRevision(response.revision);
      setConfigured(new Set(response.secrets.map((secret) => secret.name)));
      setStatus('');
    } catch {
      setStatus(zh ? '无法连接加密凭据库，请重试。' : 'The encrypted credential vault could not be reached.');
    }
  }, [zh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; };
  }, [load]);

  const save = async (name: string) => {
    const setSecret = window.metis?.setPersonalizationSecret;
    const value = values[name] ?? '';
    if (!setSecret) return;
    if (!value.trim()) {
      setStatus(zh ? '请先填写令牌值。' : 'Enter the token value first.');
      return;
    }
    setBusy(true);
    try {
      const response = await setSecret({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        name,
        value: value.trim(),
      });
      if (!response.ok) {
        setStatus(`${zh ? '保存失败' : 'Save failed'}: ${response.code}`);
        if (response.code === 'revision_conflict') await load();
        return;
      }
      setValues((current) => ({ ...current, [name]: '' }));
      setRevision(response.revision);
      setStatus(zh ? `已加密保存 ${name}；值不会回显。` : `${name} saved encrypted; the value is never displayed.`);
      await load();
    } catch {
      setStatus(zh ? '保存未完成，请重试。' : 'Save did not complete. Retry.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    const removeSecret = window.metis?.removePersonalizationSecret;
    if (!removeSecret) return;
    setBusy(true);
    try {
      const response = await removeSecret({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        name,
      });
      if (!response.ok) {
        setStatus(`${zh ? '删除失败' : 'Remove failed'}: ${response.code}`);
        if (response.code === 'revision_conflict') await load();
        return;
      }
      setRevision(response.revision);
      setStatus(zh ? `已删除 ${name}。` : `${name} removed.`);
      await load();
    } catch {
      setStatus(zh ? '删除未完成，请重试。' : 'Remove did not complete. Retry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-group" data-testid="market-tokens-section">
      <h3>{zh ? '市场 / 集成令牌' : 'Market & integration tokens'}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {zh
          ? '技能市场、MCP 市场与 GitHub 检索使用的访问令牌统一在此配置。值经操作系统安全存储加密，界面不回显。'
          : 'Access tokens for the skill market, MCP market, and GitHub lookups are configured here. Values are encrypted through OS secure storage and never displayed.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {TOKEN_SLOTS.map((slot) => {
          const isConfigured = configured.has(slot.name);
          return (
            <div key={slot.name} data-testid={`market-token-${slot.name}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>{zh ? slot.labelZh : slot.labelEn}</strong>
                <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{slot.name}</code>
                <span
                  data-testid={`market-token-state-${slot.name}`}
                  style={{ fontSize: 11, color: isConfigured ? 'var(--status-completed)' : 'var(--text-secondary)' }}
                >
                  {isConfigured ? (zh ? '已配置' : 'Configured') : (zh ? '未配置' : 'Not configured')}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>{zh ? slot.hintZh : slot.hintEn}</p>
              <p style={{ margin: 0, fontSize: 12 }}>
                <a href={slot.url} onClick={(event) => { event.preventDefault(); void window.metis?.openExternal?.(slot.url); }} style={{ color: 'var(--primary)' }}>{slot.urlLabel}</a>
                <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>{zh ? slot.requiredZh : slot.requiredEn}</span>
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={values[slot.name] ?? ''}
                  disabled={busy}
                  aria-label={zh ? slot.labelZh : slot.labelEn}
                  data-testid={`market-token-input-${slot.name}`}
                  style={{ flex: '1 1 260px', minWidth: 220 }}
                  onChange={(event) => setValues((current) => ({ ...current, [slot.name]: event.target.value }))}
                />
                <button
                  type="button"
                  className="btn-sm btn-primary"
                  disabled={busy || !(values[slot.name] ?? '').trim()}
                  data-testid={`market-token-save-${slot.name}`}
                  onClick={() => void save(slot.name)}
                >
                  {zh ? '加密保存' : 'Save encrypted'}
                </button>
                {isConfigured && (
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    disabled={busy}
                    data-testid={`market-token-remove-${slot.name}`}
                    onClick={() => void remove(slot.name)}
                  >
                    {zh ? '删除' : 'Remove'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {status && (
        <p role="status" aria-live="polite" data-testid="market-tokens-status" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
          {status}
        </p>
      )}
    </div>
  );
}
