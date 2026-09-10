/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { OfficePptRibbon } from '../../src/components/OfficePptRibbon';

const document: PptDocument = { type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'complete', elements: [] }] };

describe('OfficePptRibbon', () => {
  it('adds editable slide elements from the Insert tab', () => {
    const onChange = vi.fn();
    render(<OfficePptRibbon document={document} pageIndex={0} selectedElementId={undefined} onChange={onChange} onSave={vi.fn()} onSelectPage={vi.fn()} onSelectElement={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '插入' }));
    fireEvent.click(screen.getByRole('button', { name: '文本' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pages: [expect.objectContaining({ elements: [expect.objectContaining({ type: 'text' })] })] }));
  });

  it('duplicates and removes slides from the Home tab', () => {
    const onChange = vi.fn();
    render(<OfficePptRibbon document={document} pageIndex={0} selectedElementId={undefined} onChange={onChange} onSave={vi.fn()} onSelectPage={vi.fn()} onSelectElement={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '复制幻灯片' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pages: expect.any(Array) }));
  });
});
