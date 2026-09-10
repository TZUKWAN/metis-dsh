/**
 * SettingsProjectArchiveSection — complete project archive export/import (METIS-F10).
 *
 * Exports a project (research entities + attached source files) into a single
 * .mts file; imports restore a project into the local data directory.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';

interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: number;
  archivedAt: number | null;
}

export default function SettingsProjectArchiveSection({ uiMode }: { uiMode: UIMode }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.listProjects) return;
    try {
      const result = await metis.listProjects();
      if (result.success) {
        setProjects(result.projects);
        if (result.projects.length > 0 && !result.projects.some((p) => p.id === selectedProjectId)) {
          setSelectedProjectId(result.projects[0]!.id);
        }
      }
    } catch {
      /* settings must not break when the bridge is unavailable */
    }
  }, [selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const metis = window.metis;
      if (!metis?.listProjects) return;
      try {
        const result = await metis.listProjects();
        if (cancelled || !result.success) return;
        setProjects(result.projects);
        setSelectedProjectId((current) => (
          result.projects.some((p) => p.id === current)
            ? current
            : (result.projects[0]?.id ?? '')
        ));
      } catch {
        /* settings must not break when the bridge is unavailable */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleExport = async () => {
    const metis = window.metis;
    if (!metis?.exportProject || !selectedProjectId) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await metis.exportProject({ projectId: selectedProjectId });
      if (result.ok && result.path) {
        setLastExportPath(result.path);
        setStatus({ type: 'success', message: t('settings.archiveExportSuccess') });
      } else {
        setStatus({ type: 'error', message: result.error ?? t('settings.archiveExportError') });
      }
    } catch (err) {
      setStatus({
        type: 'error',
        message: uiMode === 'diagnostic' ? String((err as Error).message ?? err) : t('settings.archiveExportError'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    const metis = window.metis;
    if (!metis?.pickProjectArchive || !metis?.importProject) return;
    setBusy(true);
    setStatus(null);
    try {
      const picked = await metis.pickProjectArchive();
      if (picked.canceled || !picked.path) {
        setBusy(false);
        return;
      }
      const result = await metis.importProject({ archivePath: picked.path, overwrite });
      if (result.ok) {
        setStatus({ type: 'success', message: t('settings.archiveImportSuccess') });
        void loadProjects();
      } else {
        setStatus({ type: 'error', message: result.error ?? t('settings.archiveImportError') });
      }
    } catch (err) {
      setStatus({
        type: 'error',
        message: uiMode === 'diagnostic' ? String((err as Error).message ?? err) : t('settings.archiveImportError'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-group">
      <h3>{t('settings.projectArchive')}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('settings.projectArchiveDescription')}
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="project-archive-select" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.projectSelect')}</label>
        <select
          className="settings-input"
          id="project-archive-select"
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          disabled={busy || projects.length === 0}
          style={{ maxWidth: 320 }}
          data-testid="project-archive-select"
        >
          {projects.length === 0 && <option value="">{t('settings.noProjects')}</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title || project.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleExport()}
          disabled={busy || !selectedProjectId}
          data-testid="project-export-button"
        >
          {busy ? t('common.loading') : t('settings.exportProject')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleImport()}
          disabled={busy}
          data-testid="project-import-button"
        >
          {t('settings.importProject')}
        </button>
      </div>

      <label
        style={{
          display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13,
          color: 'var(--text-secondary)', cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
          data-testid="project-overwrite-toggle"
        />
        {t('settings.overwriteProject')}
      </label>

      {lastExportPath && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          {t('settings.archiveExportedTo')}: <code>{lastExportPath}</code>
        </div>
      )}
      {status && (
        <div
          role={status.type === 'error' ? 'alert' : 'status'}
          data-testid="project-archive-status"
          style={{
            marginTop: 10, fontSize: 13, padding: '8px 10px', borderRadius: 'var(--radius, 4px)',
            color: status.type === 'error' ? 'var(--status-failed)' : 'var(--status-completed)',
            background: 'var(--bg-secondary)',
          }}
        >
          {status.message}
        </div>
      )}
    </div>
  );
}
