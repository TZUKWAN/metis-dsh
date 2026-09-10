/**
 * SettingsProjectMemorySection — shared research memory editor.
 *
 * This editor intentionally retains the legacy CLAUDE_MEMORY.md compatibility
 * file, which is global to the application. Project-specific rules belong in
 * Metis.md; scoped decisions and preferences are stored separately in SQLite.
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';

/** O12: one automatic memory entry as returned by listMemoryByCategory. */
interface AutoMemoryEntry {
  key: string;
  value: string;
  category: string;
  updatedAt: number;
}

const AUTO_MEMORY_CATEGORIES = ['key_decision', 'preference', 'fact'] as const;

export default function SettingsProjectMemorySection() {
  const { t, locale } = useTranslation();
  const [projectMemory, setProjectMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaveStatus, setMemorySaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // O12: white-box automatic memories (read-only list + per-entry delete).
  const [autoMemories, setAutoMemories] = useState<AutoMemoryEntry[]>([]);
  const hasAutoMemoryApi = Boolean(window.metis?.listMemoryByCategory);
  const [autoMemoryLoading, setAutoMemoryLoading] = useState(hasAutoMemoryApi);
  // O12 fix (audit): include project-scoped memories too — LearningEngine writes
  // preferences/decisions with a projectId, so a global-only query would hide them.
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);

  useEffect(() => {
    const metis = window.metis;
    if (!metis?.getProjectMemory) return;
    metis.getProjectMemory().then((content) => {
      setProjectMemory(content);
    }).catch(() => { /* ignore */ });
  }, []);

  // Load automatic memories for the white-box panel — global + active-project scope.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.listMemoryByCategory) return;
    let cancelled = false;
    const scopes: Array<string | undefined> = [undefined, activeProjectId ?? undefined];
    Promise.all(
      scopes.flatMap((scope) =>
        AUTO_MEMORY_CATEGORIES.map((category) => metis.listMemoryByCategory!(category, scope)),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const merged: AutoMemoryEntry[] = [];
        for (const list of results) {
          if (!Array.isArray(list)) continue;
          for (const entry of list) {
            if (seen.has(entry.key)) continue;
            seen.add(entry.key);
            merged.push(entry);
          }
        }
        merged.sort((a, b) => b.updatedAt - a.updatedAt);
        setAutoMemories(merged);
        setAutoMemoryLoading(false);
      })
      .catch(() => {
        if (!cancelled) setAutoMemoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  const handleSaveMemory = async () => {
    setMemorySaveStatus('saving');
    try {
      const metis = window.metis;
      if (metis?.setProjectMemory) {
        const result = await metis.setProjectMemory(projectMemory);
        // Check DTO result — reject fake success
        if (!result || !result.success) {
          setMemorySaveStatus('idle');
          return;
        }
      }
      setMemorySaveStatus('saved');
      setMemoryDirty(false);
      setTimeout(() => setMemorySaveStatus('idle'), 2000);
    } catch {
      setMemorySaveStatus('idle');
    }
  };

  const handleDeleteAutoMemory = async (entry: AutoMemoryEntry) => {
    const metis = window.metis;
    if (!metis?.deleteMemoryByKey) return;
    try {
      // Try both scopes — the entry may be global or project-scoped.
      const result = await metis.deleteMemoryByKey(entry.key)
        .then((r) => (r?.ok ? r : metis.deleteMemoryByKey!(entry.key, activeProjectId ?? undefined)));
      if (result?.ok) {
        setAutoMemories((prev) => prev.filter((m) => m.key !== entry.key));
      }
    } catch { /* ignore */ }
  };

  const categoryLabel = (category: string): string => {
    if (category === 'key_decision') return locale === 'zh' ? '关键决策' : 'Key decision';
    if (category === 'preference') return locale === 'zh' ? '偏好' : 'Preference';
    if (category === 'fact') return locale === 'zh' ? '事实' : 'Fact';
    return category;
  };

  return (
    <div className="settings-group">
      <h3>{locale === 'zh' ? '共享研究记忆' : 'Shared research memory'}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {locale === 'zh'
          ? '这是一份跨项目共享的研究偏好与长期上下文（兼容旧 CLAUDE_MEMORY.md）。项目规则请在当前项目的 Metis.md 中维护；两者不会相互覆盖。'
          : 'This is cross-project research context and preferences (compatible with legacy CLAUDE_MEMORY.md). Maintain project rules in the active project’s Metis.md; the two do not overwrite each other.'}
      </p>
      <textarea
        ref={textareaRef}
        value={projectMemory}
        onChange={(e) => { setProjectMemory(e.target.value); setMemoryDirty(true); }}
        rows={10}
        className="settings-input"
        style={{ fontFamily: 'monospace', fontSize: 13 }}
        placeholder={t('settings.projectMemoryPlaceholder')}
        maxLength={50000}
        aria-label={t('settings.projectMemory')}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span
          style={{ fontSize: 11, color: memoryDirty ? 'var(--accent-warm)' : 'var(--text-muted)' }}
          role="status"
          aria-live="polite"
        >
          {memoryDirty ? '● ' : ''}{projectMemory.length.toLocaleString()} / 50,000
        </span>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSaveMemory}
          disabled={memorySaveStatus === 'saving'}
          data-testid="save-project-memory"
        >
          {memorySaveStatus === 'saving' ? t('common.saving') : memorySaveStatus === 'saved' ? t('common.saved') : t('settings.saveMemory')}
        </button>
      </div>

      {/* O12: white-box automatic memories — see and delete what the AI remembered. */}
      <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>
          {locale === 'zh' ? 'AI 自动记住的内容' : 'What the AI remembered'}
        </h4>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
          {locale === 'zh'
            ? '以下是引擎自动记录的关键决策、偏好与事实。本地优先，全部可查看、可删除。'
            : 'Decisions, preferences and facts the engine recorded automatically. Local-first — all visible and deletable.'}
        </p>
        {autoMemoryLoading ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('common.loading')}</p>
        ) : autoMemories.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }} data-testid="auto-memory-empty">
            {locale === 'zh' ? '暂无自动记忆。AI 在使用过程中会在这里记录重要结论。' : 'No automatic memories yet. The AI records important conclusions here as you work.'}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="auto-memory-list">
            {autoMemories.map((entry) => (
              <li
                key={entry.key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '6px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--bg-secondary)',
                }}
              >
                <span style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 8,
                  background: 'var(--accent-warm)',
                  color: '#fff',
                  flexShrink: 0,
                  marginTop: 1,
                }}>
                  {categoryLabel(entry.category)}
                </span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  {entry.value.length > 200 ? `${entry.value.slice(0, 200)}…` : entry.value}
                </span>
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  style={{ fontSize: 11, flexShrink: 0 }}
                  onClick={() => void handleDeleteAutoMemory(entry)}
                  data-testid={`auto-memory-delete-${entry.key}`}
                >
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
