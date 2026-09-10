/**
 * SubmissionsPanel — 投稿跟踪（T20）。
 *
 * 研究成果页内嵌面板：投稿状态流（投出/外审/退修/录用/发表/拒稿）、
 * 退修意见逐条管理（标记已修改 + 修改说明）、一键生成修改说明信。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { useOverlayDialog } from '../hooks/useOverlayDialog';
import './SubmissionsPanel.css';

type Status = 'submitted' | 'under_review' | 'revise' | 'accepted' | 'published' | 'rejected';

interface CommentView {
  id: string;
  text: string;
  resolved: boolean;
  revisionNote: string;
  createdAt: number;
}

interface SubmissionView {
  id: string;
  title: string;
  journal: string;
  status: Status;
  submittedAt: number;
  updatedAt: number;
  comments: CommentView[];
}

const STATUS_KEYS: Record<Status, string> = {
  submitted: 'submissions.statusSubmitted',
  under_review: 'submissions.statusUnderReview',
  revise: 'submissions.statusRevise',
  accepted: 'submissions.statusAccepted',
  published: 'submissions.statusPublished',
  rejected: 'submissions.statusRejected',
};

const ALL_STATUSES: Status[] = ['submitted', 'under_review', 'revise', 'accepted', 'published', 'rejected'];

export default function SubmissionsPanel({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const [records, setRecords] = useState<SubmissionView[]>([]);
  const { containerRef } = useOverlayDialog({ onClose });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', journal: '' });
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [letter, setLetter] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await window.metis?.listSubmissions?.(projectId ?? undefined);
    if (Array.isArray(list)) setRecords(list as SubmissionView[]);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void window.metis?.listSubmissions?.(projectId ?? undefined).then((list) => {
      if (alive && Array.isArray(list)) setRecords(list as SubmissionView[]);
    });
    return () => { alive = false; };
  }, [projectId]);

  const create = useCallback(async () => {
    if (!draft.title.trim() || !draft.journal.trim()) return;
    await window.metis?.createSubmission?.({ title: draft.title.trim(), journal: draft.journal.trim(), projectId });
    setDraft({ title: '', journal: '' });
    setCreating(false);
    void reload();
  }, [draft, projectId, reload]);

  const changeStatus = useCallback(async (id: string, status: Status) => {
    await window.metis?.updateSubmissionStatus?.(id, status);
    void reload();
  }, [reload]);

  const addComment = useCallback(async (id: string) => {
    const text = commentDraft[id]?.trim();
    if (!text) return;
    await window.metis?.addSubmissionComment?.(id, text);
    setCommentDraft((current) => ({ ...current, [id]: '' }));
    void reload();
  }, [commentDraft, reload]);

  const toggleResolved = useCallback(async (recordId: string, comment: CommentView) => {
    await window.metis?.resolveSubmissionComment?.({
      id: recordId,
      commentId: comment.id,
      resolved: !comment.resolved,
      revisionNote: comment.revisionNote,
    });
    void reload();
  }, [reload]);

  const makeLetter = useCallback(async (id: string) => {
    const text = (await window.metis?.buildResponseLetter?.(id)) ?? null;
    setLetter(text);
  }, []);

  return (
    <div className="submissions-panel" data-testid="submissions-panel" role="dialog" aria-modal="true" aria-label={t('submissions.title')} ref={containerRef}>
      <div className="submissions-panel__card">
        <header className="submissions-panel__header">
          <h2>{t('submissions.title')}</h2>
          <button type="button" className="methods-panel__close" onClick={onClose} aria-label={t('browserOverlay.close')} data-testid="submissions-close">✕</button>
        </header>

        <div className="submissions-panel__toolbar">
          <button type="button" className="btn-primary btn-sm" onClick={() => setCreating((v) => !v)} data-testid="submissions-new">{t('submissions.new')}</button>
        </div>

        {creating && (
          <div className="submissions-panel__form" data-testid="submissions-create-form">
            <input className="settings-input" placeholder={t('submissions.fieldTitle')} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="submissions-title-input" />
            <input className="settings-input" placeholder={t('submissions.fieldJournal')} value={draft.journal} onChange={(e) => setDraft({ ...draft, journal: e.target.value })} data-testid="submissions-journal-input" />
            <button type="button" className="btn-primary btn-sm" onClick={() => void create()} data-testid="submissions-create-submit">{t('projects.create')}</button>
          </div>
        )}

        {records.length === 0 ? (
          <p className="submissions-panel__empty">{t('submissions.empty')}</p>
        ) : (
          <ul className="submissions-panel__list">
            {records.map((record) => (
              <li key={record.id} className="submissions-panel__item" data-testid="submissions-item">
                <div className="submissions-panel__item-head">
                  <span className="submissions-panel__title">{record.title}</span>
                  <select
                    className="settings-input submissions-panel__status"
                    value={record.status}
                    onChange={(e) => void changeStatus(record.id, e.target.value as Status)}
                    data-testid="submissions-status"
                  >
                    {ALL_STATUSES.map((status) => (
                      <option key={status} value={status}>{t(STATUS_KEYS[status])}</option>
                    ))}
                  </select>
                </div>
                <div className="submissions-panel__meta">
                  <span>{record.journal}</span>
                  <span>{new Date(record.submittedAt).toLocaleDateString(locale)}</span>
                  <span>{t('submissions.commentCount', { count: record.comments.length, resolved: record.comments.filter((c) => c.resolved).length })}</span>
                  <button type="button" className="btn-sm btn-secondary" onClick={() => void makeLetter(record.id)} data-testid="submissions-letter">
                    {t('submissions.makeLetter')}
                  </button>
                </div>
                {record.comments.length > 0 && (
                  <ul className="submissions-panel__comments">
                    {record.comments.map((comment) => (
                      <li key={comment.id} className={`submissions-panel__comment ${comment.resolved ? 'submissions-panel__comment--resolved' : ''}`}>
                        <p>{comment.text}</p>
                        <div className="submissions-panel__comment-actions">
                          <button type="button" className="btn-sm btn-secondary" onClick={() => void toggleResolved(record.id, comment)} data-testid="submissions-resolve">
                            {comment.resolved ? t('submissions.markUnresolved') : t('submissions.markResolved')}
                          </button>
                          {comment.revisionNote && <span className="submissions-panel__note">{comment.revisionNote}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="submissions-panel__add-comment">
                  <input
                    className="settings-input"
                    placeholder={t('submissions.addCommentPlaceholder')}
                    value={commentDraft[record.id] ?? ''}
                    onChange={(e) => setCommentDraft((current) => ({ ...current, [record.id]: e.target.value }))}
                    data-testid="submissions-comment-input"
                  />
                  <button type="button" className="btn-sm btn-secondary" onClick={() => void addComment(record.id)} data-testid="submissions-comment-add">{t('submissions.addComment')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {letter && (
          <div className="submissions-panel__letter" data-testid="submissions-letter-output">
            <h3>{t('submissions.letterTitle')}</h3>
            <pre>{letter}</pre>
            <button type="button" className="btn-sm btn-secondary" onClick={() => setLetter(null)}>{t('browserOverlay.close')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
