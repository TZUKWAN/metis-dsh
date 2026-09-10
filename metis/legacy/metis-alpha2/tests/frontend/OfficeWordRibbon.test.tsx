/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { OfficeWordRibbon } from '../../src/components/OfficeWordRibbon';

const document: WordDocument = { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '正文' }], page: { paper: 'A4' }, header: '', footer: '' };

describe('OfficeWordRibbon', () => {
  it('exposes GenOffice-style insert controls that mutate the Word draft', () => {
    const onChange = vi.fn();
    render(<OfficeWordRibbon document={document} activeBlockId="p-1" activeStyle={{}} historyState={{ index: 0, length: 1 }} onChange={onChange} onHistory={vi.fn()} onCitation={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '插入' }));
    fireEvent.click(screen.getByRole('button', { name: '2 × 2 表格' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.arrayContaining([expect.objectContaining({ kind: 'table', rows: [['', ''], ['', '']] })]) }));
  });

  it('keeps page layout in the outcome action row instead of duplicating it in the Ribbon', () => {
    render(<OfficeWordRibbon document={document} activeBlockId="p-1" activeStyle={{}} historyState={{ index: 0, length: 1 }} onChange={vi.fn()} onHistory={vi.fn()} onCitation={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '布局' }));
    expect(screen.queryByTitle('打开排版设置')).toBeNull();
    expect(screen.getByText('请使用成果操作行中的“排版”打开页面设置。')).toBeTruthy();
  });
});
