/**
 * StrategyEditor — user-defined research workflow strategies and paper
 * structure templates: list, create, edit phases (actions), save, delete,
 * set default, and edit section structures.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    strategyList: vi.fn().mockResolvedValue({
      ok: true,
      strategies: [{
        id: 'strategy-s1',
        name: '混合研究',
        description: '综述+编码',
        phases: [{ action: 'literature_review', name: '文献综述' }, { action: 'coding', name: '质性编码' }],
        createdAt: 1,
        updatedAt: 1,
        isDefault: true,
      }],
    }),
    strategySave: vi.fn().mockResolvedValue({ ok: true }),
    strategyDelete: vi.fn().mockResolvedValue({ ok: true }),
    strategySetDefault: vi.fn().mockResolvedValue({ ok: true }),
    structureList: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
    structureSave: vi.fn().mockResolvedValue({ ok: true }),
    structureDelete: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

describe('StrategyEditor', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { metis?: unknown }).metis;
  });

  it('lists existing strategies and edits their phases', async () => {
    makeMetis();
    const { default: StrategyEditor } = await import('../../src/research/StrategyEditor');
    render(<StrategyEditor />);

    await screen.findByText('混合研究');
    expect(screen.getByText(/文献综述 → 质性编码/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const nameInput = await screen.findByTestId('strategy-name');
    expect((nameInput as HTMLInputElement).value).toBe('混合研究');
    // Add a phase.
    fireEvent.click(screen.getByTestId('strategy-add-phase'));
    const actionSelects = screen.getAllByTestId(/strategy-phase-action-/);
    expect(actionSelects.length).toBe(3);
    fireEvent.click(screen.getByTestId('strategy-save'));
    await waitFor(() => expect((window.metis as never as { strategySave: ReturnType<typeof vi.fn> }).strategySave).toHaveBeenCalled());
  });

  it('creates and saves a new strategy', async () => {
    const strategySave = vi.fn().mockResolvedValue({ ok: true });
    makeMetis({ strategyList: vi.fn().mockResolvedValue({ ok: true, strategies: [] }), strategySave });
    const { default: StrategyEditor } = await import('../../src/research/StrategyEditor');
    render(<StrategyEditor />);

    fireEvent.click(await screen.findByTestId('strategy-new'));
    fireEvent.change(await screen.findByTestId('strategy-name'), { target: { value: '综述型策略' } });
    fireEvent.change(screen.getByTestId('strategy-phase-action-0'), { target: { value: 'literature_review' } });
    fireEvent.change(screen.getByTestId('strategy-phase-name-0'), { target: { value: '文献综述' } });
    fireEvent.click(screen.getByTestId('strategy-save'));

    await waitFor(() => expect(strategySave).toHaveBeenCalledTimes(1));
    const payload = strategySave.mock.calls[0]![0] as { name: string; phases: Array<{ action: string; name: string }> };
    expect(payload.name).toBe('综述型策略');
    expect(payload.phases[0]?.action).toBe('literature_review');
  });

  it('creates a paper structure template with sections', async () => {
    const structureSave = vi.fn().mockResolvedValue({ ok: true });
    makeMetis({
      strategyList: vi.fn().mockResolvedValue({ ok: true, strategies: [] }),
      structureList: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
      structureSave,
    });
    const { default: StrategyEditor } = await import('../../src/research/StrategyEditor');
    render(<StrategyEditor />);

    fireEvent.click(await screen.findByTestId('structure-new'));
    fireEvent.change(await screen.findByTestId('structure-name'), { target: { value: '期刊论文' } });
    fireEvent.change(screen.getByTestId('structure-section-title-0'), { target: { value: '引言' } });
    fireEvent.click(screen.getByTestId('structure-add-section'));
    const titleInputs = screen.getAllByTestId(/structure-section-title-/);
    fireEvent.change(titleInputs[titleInputs.length - 1]!, { target: { value: '结论' } });
    fireEvent.click(screen.getByTestId('structure-save'));

    await waitFor(() => expect(structureSave).toHaveBeenCalledTimes(1));
    const payload = structureSave.mock.calls[0]![0] as { name: string; sections: Array<{ title: string }> };
    expect(payload.name).toBe('期刊论文');
    expect(payload.sections.map((s) => s.title)).toEqual(['引言', '结论']);
  });
});
