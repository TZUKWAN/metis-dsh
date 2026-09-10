import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useMetisStore } from '../store';
import { useTranslation } from '../i18n';
import { setPendingChatIntent } from '../lib/chatIntent.js';
import SearchInput from '../components/SearchInput';
import ConfirmDialog from '../components/ConfirmDialog';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';

interface NotesPageProps {
  onNavigate?: (page: string) => void;
  uiMode?: UIMode;
}

export default function NotesPage({ onNavigate, uiMode = 'normal' }: NotesPageProps) {
  const { notes: allNotes, selectedNote, addNote, updateNote, removeNote, toggleNoteStar, selectNote, papers } = useMetisStore();
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const notes = useMemo(() => allNotes.filter((item) => (
    activeProjectId
      ? item.scope === 'research' && item.projectId === activeProjectId
      : (item.scope ?? 'global') === 'global'
  )), [activeProjectId, allNotes]);
  const { t, locale } = useTranslation();
  const note = notes.find((n) => n.id === selectedNote);
  const [showPaperLinkModal, setShowPaperLinkModal] = useState(false);
  const [paperLinkQuery, setPaperLinkQuery] = useState('');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [showBulkTagInput, setShowBulkTagInput] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  function handleWritingQualityCheck(noteItem: typeof notes[number]) {
    const message = `Please check the academic writing quality of the following note. Provide clarity, structure, tone, and machine-writing-pattern feedback, plus concrete revision priorities.\n\nTitle: ${noteItem.title}\n\n${noteItem.content}`;
    setPendingChatIntent({ skillId: 'writing-quality', message });
    onNavigate?.('chat');
  }

  const handleCreate = useCallback(async () => {
    const id = `note_${Date.now()}`;
    await addNote({
      id,
      title: t('notes.defaultTitle'),
      content: '',
      tags: [],
      linkedPaperIds: [],
      linkedNoteIds: [],
      scope: activeProjectId ? 'research' : 'global',
      ...(activeProjectId ? { projectId: activeProjectId } : {}),
      updatedAt: Date.now(),
    });
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 50);
  }, [activeProjectId, addNote, t]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        void handleCreate();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCreate]);

  const allTags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].sort(), [notes]);

  const filteredNotes = notes.filter((n) => {
    const matchesQuery = !query || (() => {
      const q = query.toLowerCase();
      return n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q));
    })();
    const matchesTag = !tagFilter || n.tags.includes(tagFilter);
    const matchesStar = !starredOnly || n.starred;
    return matchesQuery && matchesTag && matchesStar;
  });

  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'title'>('newest');

  const sortedFilteredNotes = useMemo(() => {
    const list = [...filteredNotes];
    switch (sortBy) {
      case 'newest': return list.sort((a, b) => b.updatedAt - a.updatedAt);
      case 'oldest': return list.sort((a, b) => a.updatedAt - b.updatedAt);
      case 'title': return list.sort((a, b) => a.title.localeCompare(b.title));
      default: return list;
    }
  }, [filteredNotes, sortBy]);

  const filteredPapers = papers.filter((p) =>
    p.title.toLowerCase().includes(paperLinkQuery.toLowerCase()) ||
    p.authors.some((a) => a.toLowerCase().includes(paperLinkQuery.toLowerCase()))
  );

  const handleInsertPaperLink = (paperId: string, title: string) => {
    if (!note) return;
    const textarea = contentRef.current;
    const start = textarea?.selectionStart ?? note.content.length;
    const end = textarea?.selectionEnd ?? note.content.length;
    const before = note.content.slice(0, start);
    const after = note.content.slice(end);
    const link = `[[paper:${paperId}|${title}]]`;
    const newContent = `${before}${link}${after}`;
    void updateNote(note.id, { content: newContent });
    setShowPaperLinkModal(false);
    setPaperLinkQuery('');
    window.requestAnimationFrame(() => {
      if (!textarea) return;
      const pos = start + link.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    });
  };

  const handleLinkPaper = (paperId: string) => {
    if (!selectedNote) return;
    const n = notes.find((n) => n.id === selectedNote);
    if (!n) return;
    const has = n.linkedPaperIds.includes(paperId);
    void updateNote(selectedNote, {
      linkedPaperIds: has
        ? n.linkedPaperIds.filter((id) => id !== paperId)
        : [...n.linkedPaperIds, paperId],
    });
  };

  const handleAddTags = () => {
    if (!note) return;
    const newTags = tagInput.split(',').map((t) => t.trim()).filter(Boolean);
    if (newTags.length === 0) return;
    void updateNote(note.id, { tags: [...new Set([...note.tags, ...newTags])] });
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    if (!note) return;
    void updateNote(note.id, { tags: note.tags.filter((t) => t !== tag) });
  };

  const toggleNoteSelection = (id: string) => {
    setSelectedNoteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const selectAllVisible = () => {
    setSelectedNoteIds(sortedFilteredNotes.map((n) => n.id));
  };
  const clearSelection = () => setSelectedNoteIds([]);
  const allVisibleSelected = sortedFilteredNotes.length > 0 && sortedFilteredNotes.every((n) => selectedNoteIds.includes(n.id));

  const handleBulkDelete = async () => {
    for (const id of selectedNoteIds) {
      await removeNote(id);
    }
    setSelectedNoteIds([]);
    setShowBulkDeleteConfirm(false);
  };

  const handleBulkAddTags = () => {
    const newTags = bulkTagInput.split(',').map((t) => t.trim()).filter(Boolean);
    if (newTags.length === 0) return;
    for (const id of selectedNoteIds) {
      const n = notes.find((x) => x.id === id);
      if (!n) continue;
      void updateNote(id, { tags: [...new Set([...n.tags, ...newTags])] });
    }
    setBulkTagInput('');
    setShowBulkTagInput(false);
  };

  return (
    <div className="notes-page">
      <aside className="notes-sidebar">
        <div className="notes-toolbar">
          <button className="btn-primary" onClick={handleCreate}>{t('notes.newNote')}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() => { if (allVisibleSelected) clearSelection(); else selectAllVisible(); }}
              aria-label={t('notes.selectAll')}
            />
            {t('notes.selectAll')}
          </label>
          {selectedNoteIds.length > 0 && (
            <>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('notes.selectedCount', { count: selectedNoteIds.length })}</span>
              <button type="button" className="btn-sm btn-secondary" data-testid="bulk-add-tags" onClick={() => setShowBulkTagInput((v) => !v)}>{t('notes.bulkAddTags')}</button>
              <button type="button" className="btn-sm btn-danger" onClick={() => setShowBulkDeleteConfirm(true)}>{t('notes.bulkDelete')}</button>
              <button type="button" className="btn-sm btn-secondary" onClick={clearSelection}>{t('common.cancel')}</button>
            </>
          )}
        </div>
        {showBulkTagInput && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
              placeholder={t('notes.editTagsPlaceholder')}
              className="settings-input"
              style={{ flex: 1, fontSize: 12 }}
              data-testid="bulk-tag-input"
              onKeyDown={(e) => { if (e.key === 'Enter') handleBulkAddTags(); }}
            />
            <button type="button" className="btn-sm btn-primary" data-testid="bulk-tag-submit" onClick={handleBulkAddTags}>{t('common.add')}</button>
          </div>
        )}
        <SearchInput
          className="search-input"
          placeholder={t('notes.searchPlaceholder')}
          value={query}
          onChange={setQuery}
          style={{ width: '100%', marginBottom: 4 }}
        />
        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="notes-tag-filter"
            aria-label={t('notes.filterByTag')}
          >
            <option value="">{t('notes.filterAllTags')}</option>
            {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        )}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="notes-tag-filter"
          aria-label={t('notes.sortBy')}
        >
          <option value="newest">{t('notes.sortNewest')}</option>
          <option value="oldest">{t('notes.sortOldest')}</option>
          <option value="title">{t('notes.sortTitle')}</option>
        </select>
        <button
          type="button"
          className={`btn-sm ${starredOnly ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setStarredOnly((v) => !v)}
          aria-pressed={starredOnly}
          style={{ marginBottom: 8 }}
        >
          {t('notes.filterStarredOnly')}
        </button>
        <div className="result-count" aria-live="polite" aria-atomic="true">{t('notes.resultCount', { count: filteredNotes.length })}</div>
        <ul className="notes-list">
          {sortedFilteredNotes.map((n) => (
            <li key={n.id} className={`note-item ${selectedNote === n.id ? 'active' : ''}`} onClick={() => selectNote(n.id)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={selectedNoteIds.includes(n.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleNoteSelection(n.id)}
                aria-label={t('notes.selectAll')}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="note-title">{n.title}</div>
                <div className="note-meta">
                  {n.tags.slice(0, 3).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag"
                      onClick={(e) => { e.stopPropagation(); setQuery(''); setTagFilter(tag); }}
                    >
                      {tag}
                    </button>
                  ))}
                  {n.linkedPaperIds.length > 0 && (
                    <span className="link-count">{t('notes.linkedPaperCount', { count: n.linkedPaperIds.length })}</span>
                  )}
                </div>
              </div>
              <button
                className={`btn-sm ${n.starred ? 'btn-primary' : 'btn-secondary'}`}
                title={n.starred ? t('common.unstar') : t('common.star')}
                onClick={(e) => { e.stopPropagation(); void toggleNoteStar(n.id); }}
                aria-pressed={n.starred}
              >
                {n.starred ? '★' : '☆'}
              </button>
            </li>
          ))}
          {sortedFilteredNotes.length === 0 && (
            <div className="empty-list">
              {notes.length === 0 ? (
                t('notes.emptyList')
              ) : (
                <>
                  {t('notes.noMatchingNotes')}
                  {(query || tagFilter) && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => { setQuery(''); setTagFilter(''); setStarredOnly(false); }}
                      style={{ display: 'block', margin: '8px auto 0' }}
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </ul>
      </aside>
      <main className="notes-editor">
        {note ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <input type="text" className="note-title-input" value={note.title}
                ref={titleInputRef}
                onChange={(e) => { void updateNote(note.id, { title: e.target.value }); }} placeholder={t('notes.titlePlaceholder')}
                style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  className={note.starred ? 'btn-primary' : 'btn-secondary'}
                  title={note.starred ? t('common.unstar') : t('common.star')}
                  onClick={() => { void toggleNoteStar(note.id); }}
                  aria-pressed={note.starred}
                >
                  {note.starred ? '★' : '☆'}
                </button>
                <button className="btn-secondary"
                  onClick={() => setShowDeleteConfirm(true)}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {t('notes.lastUpdated', { time: new Date(note.updatedAt).toLocaleString() })}
            </div>
            <div className="note-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{t('notes.tags')}:</span>
              {note.tags.map((tag) => (
                <span key={tag} className="tag inline-flex-center">
                  <button
                    type="button"
                    className="tag"
                    onClick={() => setTagFilter(tag)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    {tag}
                  </button>
                  <button className="tag-remove" onClick={() => handleRemoveTag(tag)} title={t('common.delete')}>×</button>
                </span>
              ))}
              <div className="inline-flex-center" style={{ gap: 4 }}>
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder={t('notes.editTagsPlaceholder')}
                  className="settings-input"
                  style={{ width: 120, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddTags(); }}
                />
                <button className="btn-sm btn-primary" onClick={handleAddTags}>{t('notes.addTag')}</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button className="btn-secondary btn-sm" onClick={() => setShowPaperLinkModal(true)}>
                {t('notes.insertPaperLink')}
              </button>
              <button
                className={`btn-sm ${previewMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setPreviewMode((v) => !v)}
                aria-pressed={previewMode}
              >
                {previewMode ? t('common.edit') : t('common.preview')}
              </button>
              <button
                className="btn-secondary btn-sm"
                data-testid="note-writing-quality"
                onClick={() => handleWritingQualityCheck(note)}
              >
                {t('notes.writingQualityCheck')}
              </button>
            </div>
            {previewMode ? (
              <div
                data-testid="note-preview"
                className="note-content-input note-markdown-preview"
                style={{ overflowY: 'auto', padding: 12, background: 'var(--bg-secondary)' }}
              >
                <SafeMarkdown content={note.content || t('notes.contentPlaceholder')} uiMode={uiMode} locale={locale} />
              </div>
            ) : (
              <textarea ref={contentRef} data-testid="note-content-input" className="note-content-input" value={note.content}
                onChange={(e) => { void updateNote(note.id, { content: e.target.value }); }}
                placeholder={t('notes.contentPlaceholder')} rows={20} />
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 8 }}>
              <span>{t('notes.wordCount', { count: note.content.trim() ? note.content.trim().split(/\s+/).length : 0 })}</span>
              <span>{t('notes.charCount', { count: note.content.length })}</span>
            </div>
            <div className="note-links">
              <h4>{t('notes.linkedPapers')}</h4>
              {papers.length === 0 ? (
                <p className="muted">{t('notes.noPapers')}</p>
              ) : (
                <div className="paper-link-list">
                  {papers.map((p) => {
                    const linked = note.linkedPaperIds.includes(p.id);
                    return (
                      <label key={p.id} className={`paper-link-item ${linked ? 'linked' : ''}`}>
                        <input type="checkbox" checked={linked} onChange={() => handleLinkPaper(p.id)} />
                        <span>{p.title.slice(0, 60)}{p.title.length > 60 ? '...' : ''} ({p.year})</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="detail-empty">
            <h3>{t('notes.selectOrCreate')}</h3>
            <p>{t('notes.emptyDescription')}</p>
          </div>
        )}
      </main>
      {showPaperLinkModal && (
        <div className="modal-overlay" onClick={() => setShowPaperLinkModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('notes.paperLinkModalTitle')}</h3>
            <input
              type="text"
              className="search-input"
              placeholder={t('notes.paperLinkSearchPlaceholder')}
              value={paperLinkQuery}
              onChange={(e) => setPaperLinkQuery(e.target.value)}
              style={{ width: '100%', marginBottom: 12 }}
            />
            <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredPapers.length === 0 && <div className="empty-list">{t('papers.emptyList')}</div>}
              {filteredPapers.map((p) => (
                <button
                  key={p.id}
                  className="paper-link-item"
                  style={{ textAlign: 'left', padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)' }}
                  onClick={() => handleInsertPaperLink(p.id, p.title)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.authors[0] ?? t('papers.unknownAuthor')} · {p.year}</div>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setShowPaperLinkModal(false); setPaperLinkQuery(''); }}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
      {showDeleteConfirm && note && (
        <ConfirmDialog
          title={t('common.confirmDeleteTitle')}
          message={t('common.confirmDeleteMessage')}
          onConfirm={() => { void removeNote(note.id); setShowDeleteConfirm(false); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
      {showBulkDeleteConfirm && (
        <ConfirmDialog
          title={t('notes.bulkDeleteConfirmTitle')}
          message={t('notes.bulkDeleteConfirmMessage', { count: selectedNoteIds.length })}
          onConfirm={() => void handleBulkDelete()}
          onCancel={() => setShowBulkDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
