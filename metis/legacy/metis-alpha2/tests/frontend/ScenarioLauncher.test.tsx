// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScenarioLauncher from '../../src/research/ScenarioLauncher';

describe('ScenarioLauncher blank product state', () => {
  it('does not expose any predefined research scenario', () => {
    render(<ScenarioLauncher onOpenPersonalization={() => undefined} />);

    expect(screen.getByRole('heading', { name: '这里没有预设答案' })).toBeDefined();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText(/文献综述|基金|专著|期刊/u)).toBeNull();
  });

  it('routes the user to the blank Personalization builder', () => {
    const onOpenPersonalization = vi.fn();
    render(<ScenarioLauncher onOpenPersonalization={onOpenPersonalization} />);

    fireEvent.click(screen.getByRole('button', { name: '打开场景' }));
    expect(onOpenPersonalization).toHaveBeenCalledTimes(1);
  });

  it('does not offer a dead action when no navigation handler is connected', () => {
    render(<ScenarioLauncher />);
    expect(screen.getByRole('button', { name: '打开场景' }).hasAttribute('disabled')).toBe(true);
  });
});
