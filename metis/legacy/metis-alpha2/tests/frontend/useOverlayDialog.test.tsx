/**
 * Minimal unit tests for useOverlayDialog: Esc close, initial focus,
 * Tab focus trap (both directions), and focus restore on unmount.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useOverlayDialog } from '../../src/hooks/useOverlayDialog';

function Harness({ onClose }: { onClose: () => void }) {
  const { containerRef } = useOverlayDialog<HTMLDivElement>({ onClose });
  return (
    <div ref={containerRef} role="dialog" aria-modal="true">
      <button type="button">First</button>
      <button type="button">Second</button>
    </div>
  );
}

describe('useOverlayDialog', () => {
  it('closes the dialog on Escape', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves initial focus to the first focusable element inside the dialog', () => {
    render(<Harness onClose={() => undefined} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('traps Tab focus within the dialog (wraps forward and backward)', () => {
    render(<Harness onClose={() => undefined} />);
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });

    second.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it('restores focus to the previously focused element on unmount', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<Harness onClose={() => undefined} />);
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
