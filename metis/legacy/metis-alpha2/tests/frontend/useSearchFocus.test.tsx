/**
 * useSearchFocus hook tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useSearchFocus } from '../../src/hooks/useSearchFocus';

function TestInput() {
  const ref = useSearchFocus<HTMLInputElement>();
  return <input type="text" placeholder="search" ref={ref} />;
}

function TestInputCustomKey() {
  const ref = useSearchFocus<HTMLInputElement>('s');
  return <input type="text" placeholder="search" ref={ref} />;
}

describe('useSearchFocus', () => {
  it('focuses the input when / is pressed outside of inputs', () => {
    render(<TestInput />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('does not focus when / is pressed inside another input', () => {
    render(
      <>
        <input type="text" placeholder="other" data-testid="other" />
        <TestInput />
      </>,
    );
    const other = document.querySelector('[data-testid="other"]') as HTMLInputElement;
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(document.activeElement).toBe(other);
  });

  it('supports a custom shortcut key', () => {
    render(<TestInputCustomKey />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(window, { key: 's' });
    expect(document.activeElement).toBe(input);
  });

  it('ignores the shortcut when modifiers are pressed', () => {
    render(<TestInput />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    expect(document.activeElement).not.toBe(input);
  });
});
