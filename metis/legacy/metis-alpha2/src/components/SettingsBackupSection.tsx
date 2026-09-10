/**
 * SettingsBackupSection — Data backup export/import section.
 *
 * Migrated from the inline App.tsx SettingsPage. Handles JSON backup
 * export/import with drag-and-drop support, overwrite toggle, and
 * status messages. All store interactions (addPaper/updatePaper/etc)
 * are pulled from the shared Zustand store.
 */

import { useState, useRef } from 'react';
import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { useMetisStore } from '../store';

export default function SettingsBackupSection({ uiMode }: { uiMode: UIMode }) {
  const { t } = useTranslation();
  const addPaper = useMetisStore((s) => s.addPaper);
  const addNote = useMetisStore((s) => s.addNote);
  const addExperiment = useMetisStore((s) => s.addExperiment);
  const addCollection = useMetisStore((s) => s.addCollection);
  const updatePaper = useMetisStore((s) => s.updatePaper);
  const updateNote = useMetisStore((s) => s.updateNote);
  const updateExperiment = useMetisStore((s) => s.updateExperiment);
  const updateCollection = useMetisStore((s) => s.updateCollection);

  const [backupStatus, setBackupStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [isDraggingBackup, setIsDraggingBackup] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);

  const handleExportBackup = async () => {
    const state = useMetisStore.getState();
    const backup: Record<string, unknown> = {
      version: 1,
      exportedAt: Date.now(),
      papers: state.papers,
      notes: state.notes,
      experiments: state.experiments,
      collections: state.collections,
      settings: {
        locale: state.locale,
        theme: state.theme,
      },
    };
    const metis = window.metis;
    if (metis?.getProjectMemory) {
      try {
        backup.projectMemory = await metis.getProjectMemory();
      } catch { /* ignore */ }
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `metis-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setBackupStatus({ type: 'success', message: t('settings.exportSuccess') });
    setTimeout(() => setBackupStatus(null), 3000);
  };

  const handleImportBackup = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('invalid backup');
      const state = useMetisStore.getState();
      const counts = { papers: 0, notes: 0, experiments: 0, collections: 0 };
      const existingPaperIds = new Set(state.papers.map((p) => p.id));
      for (const p of Array.isArray(data.papers) ? data.papers : []) {
        if (!existingPaperIds.has(p.id)) {
          await addPaper(p);
          counts.papers++;
        } else if (overwriteExisting) {
          await updatePaper(p.id, p);
          counts.papers++;
        }
      }
      const existingNoteIds = new Set(state.notes.map((n) => n.id));
      for (const n of Array.isArray(data.notes) ? data.notes : []) {
        if (!existingNoteIds.has(n.id)) {
          await addNote(n);
          counts.notes++;
        } else if (overwriteExisting) {
          await updateNote(n.id, n);
          counts.notes++;
        }
      }
      const existingExperimentIds = new Set(state.experiments.map((e) => e.id));
      for (const e of Array.isArray(data.experiments) ? data.experiments : []) {
        if (!existingExperimentIds.has(e.id)) {
          await addExperiment(e);
          counts.experiments++;
        } else if (overwriteExisting) {
          await updateExperiment(e.id, e);
          counts.experiments++;
        }
      }
      const existingCollectionIds = new Set(state.collections.map((c) => c.id));
      for (const c of Array.isArray(data.collections) ? data.collections : []) {
        if (!existingCollectionIds.has(c.id)) {
          await addCollection(c);
          counts.collections++;
        } else if (overwriteExisting) {
          await updateCollection(c.id, c);
          counts.collections++;
        }
      }
      if (data.settings && typeof data.settings === 'object') {
        const settings = data.settings as Record<string, unknown>;
        if (settings.locale) useMetisStore.getState().setLocale(settings.locale as 'en' | 'zh');
        if (settings.theme) useMetisStore.getState().setTheme(settings.theme as 'light' | 'dark' | 'system');
      }
      if (data.projectMemory && typeof data.projectMemory === 'string') {
        const metis = window.metis;
        if (metis?.setProjectMemory) {
          await metis.setProjectMemory(data.projectMemory);
        }
      }
      setBackupStatus({ type: 'success', message: t('settings.importSuccess', counts) });
    } catch (err) {
      setBackupStatus({
        type: 'error',
        message: uiMode === 'diagnostic'
          ? t('settings.importErrorDiagnostic', {
              message: err instanceof Error ? err.message : String(err),
            })
          : t('settings.importError'),
      });
    }
    setTimeout(() => setBackupStatus(null), 5000);
  };

  const handleBackupDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingBackup(true);
  };

  const handleBackupDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingBackup(false);
  };

  const handleBackupDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingBackup(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.type === 'application/json' || file.name.endsWith('.json')) {
      void handleImportBackup(file);
    } else {
      setBackupStatus({ type: 'error', message: t('settings.importInvalidFile') });
      setTimeout(() => setBackupStatus(null), 3000);
    }
  };

  return (
    <div
      className="settings-group"
      onDragOver={handleBackupDragOver}
      onDragLeave={handleBackupDragLeave}
      onDrop={handleBackupDrop}
      style={{ transition: 'border-color 0.2s, background 0.2s' }}
    >
      <h3>{t('settings.dataBackup')}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('settings.dataBackupDescription')}
      </p>
      <div
        style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: 16,
          border: `2px dashed ${isDraggingBackup ? 'var(--status-completed)' : 'var(--border)'}`,
          borderRadius: 8,
          background: isDraggingBackup ? 'var(--status-completed-bg, rgba(16,185,129,0.05))' : 'var(--bg-secondary)',
        }}
        data-testid="backup-drop-zone"
      >
        <button className="btn-secondary" onClick={handleExportBackup} data-testid="export-backup">
          {t('settings.exportData')}
        </button>
        <button className="btn-secondary" onClick={() => backupInputRef.current?.click()} data-testid="import-backup">
          {t('settings.importData')}
        </button>
        <input
          ref={backupInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportBackup(file);
            if (backupInputRef.current) backupInputRef.current.value = '';
          }}
          data-testid="backup-file-input"
        />
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
        {t('settings.dragDropHint')}
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={overwriteExisting}
          onChange={(e) => setOverwriteExisting(e.target.checked)}
          data-testid="overwrite-existing"
        />
        {t('settings.overwriteExisting')}
      </label>
      {backupStatus && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 13,
            background: backupStatus.type === 'success' ? 'var(--status-completed-bg, rgba(16,185,129,0.1))' : 'var(--status-failed-bg, rgba(239,68,68,0.1))',
            color: backupStatus.type === 'success' ? 'var(--status-completed)' : 'var(--status-failed)',
          }}
          role="status"
          data-testid="backup-status"
        >
          {backupStatus.message}
        </div>
      )}
    </div>
  );
}
