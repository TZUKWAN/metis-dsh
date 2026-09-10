/**
 * NotesPanel — 研究笔记（T28 类型化）。
 *
 * 读取 notes 表中带 type: 标签的类型化笔记（文献卡/方法卡/理论卡/灵感卡/
 * 转写稿），按类型分组展示，支持类型过滤与手动新建灵感卡。
 * AI 侧通过 create_typed_note 工具随时沉淀。
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { useOverlayDialog } from '../hooks/useOverlayDialog';
import { useMetisStore } from '../store';
import './NotesPanel.css';

const TYPE_KEYS: Record<string, string> = {
  literature: 'notesPanel.typeLiterature',
  method: 'notesPanel.typeMethod',
  theory: 'notesPanel.typeTheory',
  insight: 'notesPanel.typeInsight',
  transcript: 'notesPanel.typeTranscript',
};

export default function NotesPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const notes = useMetisStore((state) => state.notes);
  const { containerRef } = useOverlayDialog({ onClose });
  const [filter, setFilter] = useState<string>('all');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', content: '' });

  const typedNotes = useMemo(() => {
    return notes
      .map((note) => {
        const type = (note.tags ?? []).find((tag) => tag.startsWith('type:'))?.slice('type:'.length) ?? null;
        return type ? { ...note, type } : null;
      })
      .filter((note): note is NonNullable<typeof note> => note !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes]);

  const visible = useMemo(
    () => (filter === 'all' ? typedNotes : typedNotes.filter((note) => note.type === filter)),
    [typedNotes, filter],
  );

  const createInsight = useCallback(async () => {
    if (!draft.title.trim() || !draft.content.trim()) return;
    await useMetisStore.getState().addNote({
      id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: `[${t('notesPanel.typeInsight')}] ${draft.title.trim()}`,
      content: draft.content.trim(),
      tags: ['type:insight'],
      linkedPaperIds: [],
      linkedNoteIds: [],
      updatedAt: Date.now(),
    } as never);
    setDraft({ title: '', content: '' });
    setCreating(false);
  }, [draft, t]);

  return (
    <div className="notes-panel" data-testid="notes-panel" role="dialog" aria-modal="true" aria-label={t('notesPanel.title')} style={{ zIndex: 'var(--z-overlay, 89)' }} ref={containerRef}>
      <div className="notes-panel__card">
        <header className="notes-panel__header">
          <h2>{t('notesPanel.title')}</h2>
          <button type="button" className="methods-panel__close" onClick={onClose} aria-label={t('browserOverlay.close')} data-testid="notes-close">✕</button>
        </header>

        <div className="notes-panel__toolbar">
          <select className="settings-input notes-panel__filter" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="notes-filter">
            <option value="all">{t('notesPanel.filterAll', { count: typedNotes.length })}</option>
            {Object.entries(TYPE_KEYS).map(([type, key]) => (
              <option key={type} value={type}>{t(key)}（{typedNotes.filter((n) => n.type === type).length}）</option>
            ))}
          </select>
          <button type="button" className="btn-primary btn-sm" onClick={() => setCreating((v) => !v)} data-testid="notes-new">{t('notesPanel.newInsight')}</button>
        </div>

        {creating && (
          <div className="notes-panel__form" data-testid="notes-create-form">
            <input className="settings-input" placeholder={t('notesPanel.fieldTitle')} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="notes-title-input" />
            <textarea className="settings-input notes-panel__content" rows={4} placeholder={t('notesPanel.fieldContent')} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} data-testid="notes-content-input" />
            <button type="button" className="btn-primary btn-sm" onClick={() => void createInsight()} data-testid="notes-create-submit">{t('projects.create')}</button>
          </div>
        )}

        {visible.length === 0 ? (
          <p className="notes-panel__empty" data-testid="notes-empty">{t('notesPanel.empty')}</p>
        ) : (
          <ul className="notes-panel__list" data-testid="notes-list">
            {visible.map((note) => (
              <li key={note.id} className="notes-panel__item" data-testid="notes-item">
                <div className="notes-panel__item-head">
                  <span className={`notes-panel__type notes-panel__type--${note.type}`}>{t(TYPE_KEYS[note.type] ?? 'notesPanel.typeInsight')}</span>
                  <span className="notes-panel__title">{note.title.replace(/^\[[^\]]+\]\s*/u, '')}</span>
                  <span className="notes-panel__date">{new Date(note.updatedAt).toLocaleDateString(locale)}</span>
                </div>
                <p className="notes-panel__content-preview">{note.content.slice(0, 160)}{note.content.length > 160 ? '…' : ''}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
