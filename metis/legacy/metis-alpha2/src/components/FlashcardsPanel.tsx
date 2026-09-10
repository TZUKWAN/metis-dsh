/**
 * FlashcardsPanel — lightweight spaced-repetition review over notes/annotations.
 *
 * Cards live in localStorage (per-install, per-user) via lib/flashcards.
 * Review uses a simplified SM-2 schedule: "remember" doubles the interval,
 * "forgot" resets it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import {
  type Flashcard,
  addFlashcard,
  deleteFlashcard,
  flashcardNow,
  loadFlashcards,
  saveFlashcards,
} from '../lib/flashcards';

const DAY_MS = 86400000;

interface FlashcardsPanelProps {
  onClose: () => void;
}

export default function FlashcardsPanel({ onClose }: FlashcardsPanelProps) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<Flashcard[]>([]);

  // Load cards asynchronously (SQLite via IPC in production, localStorage in tests).
  useEffect(() => {
    let cancelled = false;
    void loadFlashcards().then((loaded) => {
      if (!cancelled) setCards(loaded);
    });
    return () => { cancelled = true; };
  }, []);
  // Snapshot of "now" for due computation; refreshed after each grade so the
  // memo stays pure for the React Compiler.
  const [now, setNow] = useState(() => flashcardNow());
  const [mode, setMode] = useState<'list' | 'review' | 'create'>('list');
  const [showBack, setShowBack] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');

  const dueCards = useMemo(
    () => cards.filter((c) => c.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt),
    [cards, now],
  );

  const persist = (next: Flashcard[]) => {
    setCards(next);
    void saveFlashcards(next);
  };

  const startReview = () => {
    setReviewIndex(0);
    setShowBack(false);
    setMode('review');
  };

  const grade = (remembered: boolean) => {
    const card = dueCards[reviewIndex];
    if (!card) return;
    const intervalDays = remembered ? Math.min(card.intervalDays * 2, 30) : 1;
    const updated = cards.map((c) => (c.id === card.id
      ? { ...c, intervalDays, dueAt: flashcardNow() + intervalDays * DAY_MS }
      : c));
    persist(updated);
    setNow(flashcardNow());
    setShowBack(false);
    setReviewIndex((i) => i + 1);
  };

  const createCard = async () => {
    if (!front.trim() || !back.trim()) return;
    await addFlashcard(front.trim(), back.trim());
    setCards(await loadFlashcards());
    setFront('');
    setBack('');
    setMode('list');
  };

  const removeCard = (id: string) => {
    void deleteFlashcard(id);
    persist(cards.filter((c) => c.id !== id));
  };

  const reviewCard = dueCards[reviewIndex];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" data-testid="flashcards-panel" onClick={(e) => e.stopPropagation()}>
        <h3>{t('flashcards.title')}</h3>

        {mode === 'list' && (
          <>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn-primary btn-sm"
                data-testid="flashcards-start-review"
                disabled={dueCards.length === 0}
                onClick={startReview}
              >
                {t('flashcards.startReview', { count: dueCards.length })}
              </button>
              <button className="btn-secondary btn-sm" data-testid="flashcards-create" onClick={() => setMode('create')}>
                {t('flashcards.create')}
              </button>
            </div>
            {cards.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12 }}>{t('flashcards.empty')}</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, marginTop: 12, maxHeight: '45vh', overflowY: 'auto' }}>
                {cards.map((card) => (
                  <li key={card.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }}>
                      {card.front}
                    </span>
                    <button className="btn-sm btn-secondary" onClick={() => removeCard(card.id)} aria-label={t('common.delete')}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {mode === 'create' && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('flashcards.front')}</label>
            <textarea
              className="settings-input"
              data-testid="flashcards-front"
              value={front}
              onChange={(e) => setFront(e.target.value)}
              rows={2}
              style={{ width: '100%' }}
            />
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 4px' }}>{t('flashcards.back')}</label>
            <textarea
              className="settings-input"
              data-testid="flashcards-back"
              value={back}
              onChange={(e) => setBack(e.target.value)}
              rows={4}
              style={{ width: '100%' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn-primary btn-sm" data-testid="flashcards-save" disabled={!front.trim() || !back.trim()} onClick={createCard}>
                {t('common.save')}
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setMode('list')}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {mode === 'review' && (
          <div style={{ marginTop: 12 }}>
            {!reviewCard ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <p style={{ fontSize: 14 }}>{t('flashcards.reviewDone')}</p>
                <button className="btn-secondary btn-sm" onClick={() => setMode('list')}>{t('common.close')}</button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {t('flashcards.reviewProgress', { current: reviewIndex + 1, total: dueCards.length })}
                </div>
                <div
                  className="flashcard-face"
                  data-testid="flashcard-face"
                  onClick={() => setShowBack((v) => !v)}
                  style={{
                    padding: 24,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--bg-card)',
                    minHeight: 120,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1.7,
                    textAlign: 'center',
                  }}
                >
                  {showBack ? reviewCard.back : reviewCard.front}
                </div>
                {showBack ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
                    <button className="btn-primary btn-sm" data-testid="flashcard-remember" onClick={() => grade(true)}>
                      {t('flashcards.remember')}
                    </button>
                    <button className="btn-secondary btn-sm" data-testid="flashcard-forgot" onClick={() => grade(false)}>
                      {t('flashcards.forgot')}
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>{t('flashcards.flipHint')}</p>
                )}
              </>
            )}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn-secondary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
