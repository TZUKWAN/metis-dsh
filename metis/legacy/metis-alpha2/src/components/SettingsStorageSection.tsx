/**
 * SettingsStorageSection — user-configurable data directory (METIS storage location).
 *
 * All Metis data lives under one directory; the user may relocate it to any
 * folder (e.g. another drive). Changing location validates the target, writes
 * the location pointer and relaunches the app; the migration itself runs in
 * the main process before any data handle is opened and only deletes the old
 * directory after verifying the copy.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';

interface StorageLocationState {
  dataDir: string;
  defaultDir: string;
  usingDefault: boolean;
}

function truncatePath(p: string, max = 88): string {
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

const STORAGE_ERROR_KEYS: Record<string, string> = {
  invalid_path: 'storageErrorInvalidPath',
  symlink_rejected: 'storageErrorSymlink',
  not_a_directory: 'storageErrorNotDirectory',
  not_writable: 'storageErrorNotWritable',
  not_empty: 'storageErrorNotEmpty',
  invalid_metis_db: 'storageErrorInvalidDb',
  pointer_write_failed: 'storageErrorPointerWrite',
};

function storageErrorMessage(code: string | undefined, t: (key: string) => string): string {
  if (!code) return t('settings.storageErrorChange');
  const reason = code.startsWith('location_') ? code.slice('location_'.length) : code;
  const key = STORAGE_ERROR_KEYS[reason];
  return key ? t(`settings.${key}`) : t('settings.storageErrorChange');
}

export default function SettingsStorageSection() {
  const { t } = useTranslation();
  const [location, setLocation] = useState<StorageLocationState | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const metis = window.metis;
      if (!metis?.storageGetLocation) return;
      try {
        const result = await metis.storageGetLocation();
        if (cancelled) return;
        if (result.ok && result.dataDir && result.defaultDir) {
          setLocation({
            dataDir: result.dataDir,
            defaultDir: result.defaultDir,
            usingDefault: result.usingDefault === true,
          });
        } else {
          setError(result.error ?? t('settings.storageErrorChange'));
        }
      } catch {
        /* settings must not break when the bridge is unavailable */
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const handleChoose = async () => {
    const metis = window.metis;
    if (!metis?.storageChooseLocation) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await metis.storageChooseLocation();
      if (!picked.canceled && picked.path) setPendingTarget(picked.path);
    } catch {
      setError(t('settings.storageErrorChange'));
    } finally {
      setBusy(false);
    }
  };

  const handleSetLocation = async (target: string) => {
    const metis = window.metis;
    if (!metis?.storageSetLocation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await metis.storageSetLocation(target);
      if (result.ok && result.restarting) {
        setPendingTarget(null);
        setRestarting(true);
      } else {
        setError(storageErrorMessage(result.error, t));
      }
    } catch {
      setError(t('settings.storageErrorChange'));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = () => {
    const metis = window.metis;
    if (!metis?.storageSetLocation || !location) return;
    setPendingTarget(location.defaultDir);
  };

  const handleOpenFolder = async () => {
    const metis = window.metis;
    if (!metis?.storageOpenFolder) return;
    try {
      await metis.storageOpenFolder();
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="settings-group" data-testid="storage-section">
      <h3>{t('settings.storageSectionTitle')}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('settings.storageSectionDescription')}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--text-primary)',
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: 'var(--text-secondary)' }}>{t('settings.storageCurrentLocation')}：</span>
        <code
          data-testid="storage-current-path"
          style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' }}
          title={location?.dataDir ?? ''}
        >
          {location ? truncatePath(location.dataDir) : '…'}
        </code>
        {location?.usingDefault && (
          <span
            className="badge"
            data-testid="storage-default-badge"
            style={{ fontSize: 11, color: 'var(--text-secondary)' }}
          >
            {t('settings.storageDefaultBadge')}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-sm btn-primary"
          onClick={handleChoose}
          disabled={busy || restarting}
          data-testid="storage-change-button"
        >
          {t('settings.storageChangeButton')}
        </button>
        <button
          type="button"
          className="btn-sm btn-secondary"
          onClick={handleOpenFolder}
          disabled={!location || restarting}
          data-testid="storage-open-button"
        >
          {t('settings.storageOpenButton')}
        </button>
        {location && !location.usingDefault && (
          <button
            type="button"
            className="btn-sm btn-secondary"
            onClick={handleReset}
            disabled={busy || restarting}
            data-testid="storage-reset-button"
          >
            {t('settings.storageResetButton')}
          </button>
        )}
      </div>

      {pendingTarget && !restarting && (
        <div
          data-testid="storage-confirm-dialog"
          style={{
            marginTop: 12,
            padding: 12,
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            background: 'var(--bg-secondary)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('settings.storageConfirmTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, wordBreak: 'break-all' }}>
            {t('settings.storageConfirmBody').replace('{path}', truncatePath(pendingTarget, 120))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn-sm btn-primary"
              onClick={() => void handleSetLocation(pendingTarget)}
              disabled={busy}
              data-testid="storage-confirm-accept"
            >
              {t('settings.storageConfirmAccept')}
            </button>
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={() => setPendingTarget(null)}
              disabled={busy}
              data-testid="storage-confirm-cancel"
            >
              {t('settings.storageConfirmCancel')}
            </button>
          </div>
        </div>
      )}

      {restarting && (
        <div role="status" data-testid="storage-restarting" style={{ marginTop: 12, fontSize: 13, color: 'var(--status-completed)' }}>
          {t('settings.storageRestarting')}
        </div>
      )}
      {error && !restarting && (
        <div role="alert" data-testid="storage-error" style={{ marginTop: 12, fontSize: 12, color: 'var(--status-error)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
