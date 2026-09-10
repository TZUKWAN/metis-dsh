/**
 * FlashcardsPanel: create cards, review with flip + grade, and the spaced
 * interval updates (remember doubles, forgot resets). Uses the async
 * IPC/localStorage fallback in lib/flashcards.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import FlashcardsPanel from '../../src/components/FlashcardsPanel';
import { addFlashcard, loadFlashcards, saveFlashcards } from '../../src/lib/flashcards';

describe('FlashcardsPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a card and lists it', async () => {
    const { container } = render(<FlashcardsPanel onClose={() => {}} />);

    fireEvent.click(container.querySelector('[data-testid="flashcards-create"]')!);
    fireEvent.change(container.querySelector('[data-testid="flashcards-front"]')!, {
      target: { value: '什么是自注意力？' },
    });
    fireEvent.change(container.querySelector('[data-testid="flashcards-back"]')!, {
      target: { value: '序列内部元素相互关注的机制' },
    });
    fireEvent.click(container.querySelector('[data-testid="flashcards-save"]')!);

    await waitFor(async () => {
      const cards = await loadFlashcards();
      expect(cards).toHaveLength(1);
      expect(cards[0]?.front).toBe('什么是自注意力？');
    });
    expect(container.textContent).toContain('什么是自注意力？');
  });

  it('reviews a due card: flip shows the back, remember advances the interval', async () => {
    await addFlashcard('问题 A', '答案 A');
    const { container } = render(<FlashcardsPanel onClose={() => {}} />);

    await waitFor(() => {
      const btn = container.querySelector('[data-testid="flashcards-start-review"]') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    const startBtn = container.querySelector('[data-testid="flashcards-start-review"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(startBtn); });

    // Front face shows the question.
    const face = container.querySelector('[data-testid="flashcard-face"]')!;
    expect(face.textContent).toBe('问题 A');

    // Flip to the back.
    await act(async () => { fireEvent.click(face); });
    expect(face.textContent).toBe('答案 A');

    // Grade "remember" → interval doubles (1 → 2 days).
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="flashcard-remember"]')!); });
    const updated = (await loadFlashcards())[0]!;
    expect(updated.intervalDays).toBe(2);
    expect(updated.dueAt).toBeGreaterThan(Date.now());

    // No more due cards → review complete state.
    await waitFor(() => {
      expect(container.textContent).toContain('复习完成');
    });
  });

  it('forgot resets the interval to one day', async () => {
    await addFlashcard('问题 B', '答案 B');
    // Age the card so it has a longer interval to reset.
    const aged = (await loadFlashcards()).map((c) => ({ ...c, intervalDays: 8, dueAt: Date.now() - 1000 }));
    await saveFlashcards(aged);

    const { container } = render(<FlashcardsPanel onClose={() => {}} />);
    await waitFor(() => {
      const btn = container.querySelector('[data-testid="flashcards-start-review"]') as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(false);
    });
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="flashcards-start-review"]')!); });
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="flashcard-face"]')!); });
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="flashcard-forgot"]')!); });

    const updated = (await loadFlashcards())[0]!;
    expect(updated.intervalDays).toBe(1);
  });

  it('disables the review button when nothing is due', async () => {
    const { container } = render(<FlashcardsPanel onClose={() => {}} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="flashcards-start-review"]')).toBeTruthy();
    });
    const startBtn = container.querySelector('[data-testid="flashcards-start-review"]') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
  });
});
