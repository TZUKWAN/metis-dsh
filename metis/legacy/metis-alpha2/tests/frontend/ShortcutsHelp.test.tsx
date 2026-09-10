/**
 * ShortcutsHelp modal tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShortcutsHelp from '../../src/components/ShortcutsHelp';

describe('ShortcutsHelp', () => {
  it('renders the shortcut list and closes on button click', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelp onClose={onClose} />);
    expect(screen.getByText('键盘快捷键')).toBeDefined();
    expect(screen.getByText('Ctrl+K / ⌘K')).toBeDefined();
    fireEvent.click(screen.getByText('关闭'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<ShortcutsHelp onClose={onClose} />);
    const overlay = container.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });
});
