/**
 * CloudSyncSection — 设置页云备份区块（T33）。
 *
 * 用户自填 WebDAV（坚果云/NextCloud）：测试连接、立即备份、
 * 列出云端备份、选择恢复（暂存后重启生效）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import './CloudSyncSection.css';

export default function CloudSyncSection() {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(false);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const config = await window.metis?.getCloudSyncConfig?.();
    if (config?.configured) {
      setConfigured(true);
      setUrl(config.url ?? '');
      setUsername(config.username ?? '');
      const list = await window.metis?.listCloudBackups?.();
      if (Array.isArray(list)) setBackups(list);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void window.metis?.getCloudSyncConfig?.().then(async (config) => {
      if (!alive) return;
      if (config?.configured) {
        setConfigured(true);
        setUrl(config.url ?? '');
        setUsername(config.username ?? '');
        const list = await window.metis?.listCloudBackups?.();
        if (alive && Array.isArray(list)) setBackups(list);
      }
    });
    return () => { alive = false; };
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    const result = await window.metis?.saveCloudSyncConfig?.({ url, username, password });
    setBusy(false);
    setNotice(result?.ok ? t('cloudSync.savedNotice') : t('cloudSync.invalidConfig'));
    if (result?.ok) void reload();
  }, [url, username, password, t, reload]);

  const test = useCallback(async () => {
    setBusy(true);
    const result = await window.metis?.testCloudSync?.();
    setBusy(false);
    setNotice(result?.ok ? t('cloudSync.testOk') : t('cloudSync.testFailed', { error: result?.error ?? '' }));
  }, [t]);

  const backup = useCallback(async () => {
    setBusy(true);
    const result = await window.metis?.backupToCloud?.();
    setBusy(false);
    setNotice(result?.ok
      ? t('cloudSync.backupOk', { name: result.objectName ?? '' })
      : t('cloudSync.backupFailed', { error: result?.error ?? '' }));
    if (result?.ok) void reload();
  }, [t, reload]);

  const restore = useCallback(async (name: string) => {
    setBusy(true);
    const result = await window.metis?.stageCloudRestore?.(name);
    setBusy(false);
    setNotice(result?.ok ? t('cloudSync.restoreStaged') : t('cloudSync.restoreFailed', { error: result?.error ?? '' }));
  }, [t]);

  const clear = useCallback(async () => {
    await window.metis?.clearCloudSyncConfig?.();
    setConfigured(false);
    setPassword('');
    setBackups([]);
    setNotice(t('cloudSync.cleared'));
  }, [t]);

  return (
    <div className="settings-group" data-testid="cloud-sync-section" data-settings-section="cloud-sync">
      <h3>{t('cloudSync.title')}</h3>
      <p className="cloud-sync__hint">{t('cloudSync.hint')}</p>
      <div className="cloud-sync__row">
        <input className="settings-input" placeholder="https://dav.jianguoyun.com/dav/" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="cloud-sync-url" />
      </div>
      <div className="cloud-sync__row">
        <input className="settings-input" placeholder={t('cloudSync.username')} value={username} onChange={(e) => setUsername(e.target.value)} data-testid="cloud-sync-username" />
        <input className="settings-input" type="password" placeholder={configured ? t('cloudSync.passwordSet') : t('cloudSync.password')} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="cloud-sync-password" />
      </div>
      <div className="cloud-sync__actions">
        <button type="button" className="btn-primary btn-sm" disabled={busy || !url || !password} onClick={() => void save()} data-testid="cloud-sync-save">{t('cloudSync.save')}</button>
        <button type="button" className="btn-secondary btn-sm" disabled={busy || !configured} onClick={() => void test()} data-testid="cloud-sync-test">{t('settings.testConnection')}</button>
        <button type="button" className="btn-secondary btn-sm" disabled={busy || !configured} onClick={() => void backup()} data-testid="cloud-sync-backup">{t('cloudSync.backupNow')}</button>
        {configured && <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void clear()}>{t('cloudSync.clear')}</button>}
      </div>
      {notice && <div role="status" data-testid="cloud-sync-notice" className="cloud-sync__notice">{notice}</div>}
      {configured && backups.length > 0 && (
        <ul className="cloud-sync__backups" data-testid="cloud-sync-backups">
          {backups.map((name) => (
            <li key={name}>
              <span>{name}</span>
              <button type="button" className="btn-sm btn-secondary" disabled={busy} onClick={() => void restore(name)} data-testid="cloud-sync-restore">{t('cloudSync.restore')}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
