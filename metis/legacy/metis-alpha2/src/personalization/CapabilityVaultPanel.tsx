/**
 * CapabilityVaultPanel — 能力库（任务7 7B/7D，2026-09-08 刘总澄清集成语义）。
 *
 * 【入库不注入】本面板展示 vault 中全部预置技能/MCP 目录条目；安装只是把
 * 某条技能写入个人化定义清单（可绑定），**不注入任何运行上下文**——只有
 * Workflow 步骤显式绑定（step.skillIds）后，Step Runtime 才在执行时加载。
 * MCP 目录条目仅元数据展示：配置端点后经既有 MCP 激活通道绑定，默认不启动。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type VaultKind = 'skill' | 'mcp';

interface VaultEntryMeta {
  id: string; kind: VaultKind; name: string; description: string;
  sourceId: string; sourceRepo: string; originalPath: string;
  license: string | null; licenseStatus: string;
  domains: string[]; researchStages: string[]; tags: string[];
  contentDigest: string; included: boolean; exclusionReason: string | null;
  installedDefinitionId: string | null; importedAt: number; updatedAt: number;
}

interface VaultEntryDetail extends VaultEntryMeta { systemPrompt?: string }

interface VaultSourceInfo {
  id: string; repo: string; name: string; expansion: 'per_skill' | 'single';
  domains: string[]; researchStages: string[]; licenseStatus: 'verified' | 'unverified';
  notes?: string; vaultCount: number;
}

interface VaultStats { total: number; skills: number; mcps: number; installed: number; sources: number }

export function CapabilityVaultPanel({ zh, initialKind = 'skill', lockKind = false, onInstalled }: {
  zh: boolean;
  initialKind?: VaultKind;
  /** 刘总 2026-09：技能页只保留技能条目、MCP 页只保留 MCP 目录，锁定时隐藏切换 tab。 */
  lockKind?: boolean;
  onInstalled?: (definitionId: string) => void;
}) {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [sources, setSources] = useState<VaultSourceInfo[]>([]);
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [kind, setKind] = useState<VaultKind>(initialKind);
  const [keyword, setKeyword] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [importingSource, setImportingSource] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultEntryDetail | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const debounceRef = useRef<number | null>(null);

  const loadOverview = useCallback(async () => {
    const [sourcesRes, statsRes] = await Promise.all([
      window.metis?.capabilityVaultSources?.(),
      window.metis?.capabilityVaultStats?.(),
    ]);
    if (sourcesRes?.ok && sourcesRes.sources) setSources(sourcesRes.sources);
    if (statsRes?.ok && statsRes.stats) setStats(statsRes.stats);
  }, []);

  const loadEntries = useCallback(async (nextKind: VaultKind, nextKeyword: string, nextSourceId: string) => {
    const res = await window.metis?.capabilityVaultList?.({
      kind: nextKind,
      keyword: nextKeyword.trim() || undefined,
      sourceId: nextSourceId || undefined,
      limit: 200,
    });
    if (res?.ok && res.entries) setEntries(res.entries);
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void loadEntries(kind, keyword, sourceId);
    }, 250);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [kind, keyword, sourceId, loadEntries]);

  const importSource = async (id: string) => {
    setImportingSource(id);
    setMessage(null);
    try {
      const res = await window.metis?.capabilityVaultImportSource?.(id);
      if (res?.ok) {
        setMessage({
          tone: 'ok',
          text: zh
            ? `已导入「${id}」：有效技能 ${res.imported} 条，未通过核验 ${res.excluded} 条（正文过短或缺实质内容）。`
            : `Imported "${id}": ${res.imported} skills, ${res.excluded} excluded.`,
        });
      } else {
        setMessage({ tone: 'error', text: `${zh ? '导入失败' : 'Import failed'}: ${res?.error ?? 'unknown'}` });
      }
      await Promise.all([loadOverview(), loadEntries(kind, keyword, sourceId)]);
    } finally {
      setImportingSource(null);
    }
  };

  const importAllSources = async () => {
    setMessage({ tone: 'ok', text: zh ? '正在逐源导入全部预置仓库（受 GitHub 限流影响可能较慢）…' : 'Importing all sources…' });
    let okCount = 0;
    let failCount = 0;
    for (const source of sources) {
      try {
        const res = await window.metis?.capabilityVaultImportSource?.(source.id);
        if (res?.ok) okCount += 1; else failCount += 1;
      } catch {
        failCount += 1;
      }
    }
    setMessage({
      tone: failCount > 0 ? 'error' : 'ok',
      text: zh
        ? `全量导入完成：成功 ${okCount} 源，失败 ${failCount} 源${failCount > 0 ? '（失败源可单独重试）' : ''}。`
        : `Bulk import done: ${okCount} ok, ${failCount} failed.`,
    });
    await Promise.all([loadOverview(), loadEntries(kind, keyword, sourceId)]);
  };

  const install = async (entry: VaultEntryMeta) => {
    setBusyId(entry.id);
    setMessage(null);
    try {
      const res = await window.metis?.capabilityVaultInstall?.(entry.id);
      if (res?.ok && res.definitionId) {
        setMessage({ tone: 'ok', text: zh ? `「${entry.name}」已入库为可绑定技能。它不会注入任何对话——只有在场景步骤中绑定后，执行时才加载。` : `Installed as bindable skill.` });
        onInstalled?.(res.definitionId);
      } else if (res?.code === 'already_installed') {
        setMessage({ tone: 'ok', text: zh ? '该技能已安装。' : 'Already installed.' });
      } else if (res?.code === 'excluded') {
        setMessage({ tone: 'error', text: `${zh ? '该条目未通过导入核验' : 'Excluded'}: ${res.message ?? ''}` });
      } else {
        setMessage({ tone: 'error', text: `${zh ? '安装失败' : 'Install failed'}: ${res?.message ?? res?.code ?? 'unknown'}` });
      }
      await Promise.all([loadOverview(), loadEntries(kind, keyword, sourceId)]);
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (entry: VaultEntryMeta) => {
    setBusyId(entry.id);
    setMessage(null);
    try {
      const res = await window.metis?.capabilityVaultUninstall?.(entry.id);
      if (res?.ok) {
        setMessage({ tone: 'ok', text: zh ? '已卸载：对应技能定义已停用（可在技能清单中手动重开）。' : 'Uninstalled.' });
      } else {
        setMessage({ tone: 'error', text: `${zh ? '卸载失败' : 'Uninstall failed'}: ${res?.error ?? 'unknown'}` });
      }
      await Promise.all([loadOverview(), loadEntries(kind, keyword, sourceId)]);
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (entry: VaultEntryMeta) => {
    const res = await window.metis?.capabilityVaultGetDetail?.(entry.id);
    if (res?.ok && res.entry) setDetail(res.entry);
    else setMessage({ tone: 'error', text: `${zh ? '详情获取失败' : 'Detail failed'}: ${res?.error ?? 'unknown'}` });
  };

  return (
    <div className="personalization-installer" data-testid="vault-panel">
      <div className="personalization-installer__header">
        <h4>{zh ? '能力库（预置技能 · MCP 目录）' : 'Capability Vault (preset skills · MCP catalog)'}</h4>
        <p className="personalization-installer__hint">
          {zh
            ? '预置内容仅存于能力库，平时零上下文暴露：不写入任何对话、不注入任何提示词。只有安装并在场景步骤中绑定后，执行该步骤时才动态加载。'
            : 'Vault entries stay out of context until installed AND bound to a workflow step.'}
        </p>
        {stats && (
          <p className="vault-stats" data-testid="vault-stats">
            {zh
              ? `已入库 ${stats.total} 条（技能 ${stats.skills} · MCP 目录 ${stats.mcps}）· 已安装 ${stats.installed} · 覆盖 ${stats.sources} 个来源仓库`
              : `${stats.total} entries (${stats.skills} skills · ${stats.mcps} MCP) · ${stats.installed} installed · ${stats.sources} sources`}
          </p>
        )}
      </div>

      <div className="vault-filters">
        {!lockKind && <div className="vault-filters__kind" role="tablist">
          <button
            type="button"
            className={kind === 'skill' ? 'vault-kind-btn vault-kind-btn--active' : 'vault-kind-btn'}
            onClick={() => setKind('skill')}
          >
            {zh ? '技能条目' : 'Vault skills'}
          </button>
          <button
            type="button"
            className={kind === 'mcp' ? 'vault-kind-btn vault-kind-btn--active' : 'vault-kind-btn'}
            onClick={() => setKind('mcp')}
          >
            {zh ? '目录条目（MCP）' : 'Vault MCP catalog'}
          </button>
        </div>}
        <input
          type="search"
          className="vault-filters__search"
          data-testid="vault-search-input"
          placeholder={zh ? '搜索名称 / 描述 / 标签 / 仓库…' : 'Search name / description / tags / repo…'}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <select
          className="vault-filters__source"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          <option value="">{zh ? '全部来源' : 'All sources'}</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>{source.name}（{source.vaultCount}）</option>
          ))}
        </select>
      </div>

      {message && (
        <p className={message.tone === 'ok' ? 'vault-message vault-message--ok' : 'vault-message vault-message--error'} data-testid="vault-message">
          {message.text}
        </p>
      )}

      <div className="vault-sources">
        <div className="vault-sources__head">
          <h5 className="personalization-browse-section">{zh ? '预置来源仓库' : 'Preset source repos'}</h5>
          <button
            type="button"
            className="vault-import-all"
            data-testid="vault-import-all"
            disabled={sources.length === 0 || importingSource !== null}
            onClick={() => void importAllSources()}
          >
            {zh ? '一键导入全部来源' : 'Import all sources'}
          </button>
        </div>
        <div className="vault-sources__grid">
          {sources.map((source) => (
            <div key={source.id} className="vault-source-row">
              <span className="vault-source-row__name" title={source.repo}>{source.name}</span>
              <span className="vault-source-row__count">{source.vaultCount > 0 ? `${source.vaultCount}` : '—'}</span>
              <button
                type="button"
                className="vault-source-row__btn"
                data-testid={`vault-source-import-${source.id}`}
                disabled={importingSource !== null}
                onClick={() => void importSource(source.id)}
              >
                {importingSource === source.id ? (zh ? '导入中…' : 'Importing…') : source.vaultCount > 0 ? (zh ? '重新导入' : 'Re-import') : (zh ? '导入' : 'Import')}
              </button>
            </div>
          ))}
          {sources.length === 0 && (
            <p className="personalization-installer__hint">{zh ? '来源清单加载失败或为空。' : 'No sources loaded.'}</p>
          )}
        </div>
      </div>

      <h5 className="personalization-browse-section">
        {kind === 'skill' ? (zh ? '技能条目' : 'Skill entries') : (zh ? 'MCP 目录条目（仅元数据，不安装不启动）' : 'MCP catalog entries (metadata only)')}
      </h5>
      <div className="personalization-cards" data-testid="vault-entries">
        {entries.map((entry) => (
          <article key={entry.id} className="personalization-card vault-card" data-testid="vault-entry">
            <div className="personalization-card__body">
              <div className="personalization-card__meta">
                <span>{entry.sourceRepo}</span>
                {!entry.included && <span className="vault-pill vault-pill--excluded">{zh ? '未通过核验' : 'excluded'}</span>}
                {entry.installedDefinitionId && <span className="vault-pill vault-pill--installed">{zh ? '已安装' : 'installed'}</span>}
                <span className={entry.licenseStatus === 'verified' ? 'vault-pill vault-pill--license-ok' : 'vault-pill'}>
                  license: {entry.licenseStatus === 'verified' ? (zh ? '已核验' : 'verified') : (zh ? '待核验' : 'unverified')}
                </span>
              </div>
              <strong>{entry.name}</strong>
              <span className="personalization-card__description">{entry.description || entry.originalPath}</span>
              {entry.tags.length > 0 && (
                <div className="personalization-card__tags">
                  {entry.tags.slice(0, 6).map((tag) => (
                    <span key={tag} className="personalization-tag">{tag}</span>
                  ))}
                </div>
              )}
              <div className="vault-card__actions">
                <button type="button" className="vault-card__btn" onClick={() => void openDetail(entry)} data-testid="vault-detail-btn">
                  {zh ? '查看详情' : 'Details'}
                </button>
                {entry.kind === 'skill' && entry.included && !entry.installedDefinitionId && (
                  <button
                    type="button"
                    className="vault-card__btn vault-card__btn--primary"
                    data-testid="vault-install-btn"
                    disabled={busyId === entry.id}
                    onClick={() => void install(entry)}
                  >
                    {busyId === entry.id ? (zh ? '安装中…' : 'Installing…') : (zh ? '安装为可绑定技能' : 'Install as bindable skill')}
                  </button>
                )}
                {entry.kind === 'skill' && entry.installedDefinitionId && (
                  <button
                    type="button"
                    className="vault-card__btn"
                    data-testid="vault-uninstall-btn"
                    disabled={busyId === entry.id}
                    onClick={() => void uninstall(entry)}
                  >
                    {zh ? '卸载' : 'Uninstall'}
                  </button>
                )}
                {entry.kind === 'mcp' && (
                  <span className="vault-card__note">
                    {zh ? '在 MCP 库配置端点后绑定；默认不启动。' : 'Configure endpoint in MCP library to bind; not started by default.'}
                  </span>
                )}
              </div>
            </div>
          </article>
        ))}
        {entries.length === 0 && (
          <p className="personalization-installer__hint" data-testid="vault-empty">
            {zh
              ? '尚无条目——先在上方导入来源仓库（可一键导入全部）。'
              : 'No entries yet — import a source repo above.'}
          </p>
        )}
      </div>

      {detail && (
        <div className="vault-detail" data-testid="vault-detail-body">
          <div className="vault-detail__head">
            <strong>{detail.name}</strong>
            <span className="vault-detail__path">{detail.originalPath}</span>
            <button type="button" className="vault-detail__close" onClick={() => setDetail(null)}>
              {zh ? '关闭' : 'Close'}
            </button>
          </div>
          {detail.exclusionReason && (
            <p className="vault-message vault-message--error">{detail.exclusionReason}</p>
          )}
          <p className="vault-detail__meta">
            {detail.sourceRepo} · digest {detail.contentDigest} · {detail.domains.join(' / ') || '—'}
          </p>
          <pre className="vault-detail__body">{(detail.systemPrompt ?? '').slice(0, 8000) || (zh ? '（无正文）' : '(empty)')}</pre>
        </div>
      )}
    </div>
  );
}

export default CapabilityVaultPanel;
