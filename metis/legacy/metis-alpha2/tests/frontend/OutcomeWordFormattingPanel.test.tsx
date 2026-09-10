/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OutcomeWordFormattingPanel } from '../../src/components/OutcomeWordFormattingPanel';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract';

const document: WordDocument = { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '正文' }], page: { paper: 'A4' }, header: '', footer: '' };

describe('OutcomeWordFormattingPanel', () => {
  it('writes a structured formatting policy into the passed Word document instead of changing only preview styling', () => {
    const onApply = vi.fn();
    render(<OutcomeWordFormattingPanel document={document} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: '排版' }));
    fireEvent.change(screen.getByLabelText('正文字体'), { target: { value: '仿宋' } });
    fireEvent.change(screen.getByLabelText('正文行距'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('页眉'), { target: { value: '研究报告' } });
    fireEvent.click(screen.getByLabelText('页码'));
    fireEvent.click(screen.getByRole('button', { name: '应用结构化排版' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ header: '研究报告', page: expect.objectContaining({ pageNumber: true }), blocks: [expect.objectContaining({ style: expect.objectContaining({ fontFamily: '仿宋', lineSpacing: 2 }) })] }), '应用 Word 排版设置');
  });

  it('does not claim an opaque natural-language request was applied', () => {
    const onApply = vi.fn();
    render(<OutcomeWordFormattingPanel document={document} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: '排版' }));
    fireEvent.change(screen.getByLabelText('自然语言要求'), { target: { value: '做得高级一点' } });
    fireEvent.click(screen.getByRole('button', { name: '解析并应用' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/未识别到可安全执行/u)).toBeTruthy();
  });

  it('changes only explicitly recognized fields for a natural-language instruction', () => {
    const onApply = vi.fn();
    const styled: WordDocument = {
      ...document,
      blocks: [{ ...document.blocks[0], style: { fontFamily: '仿宋', fontSizePt: 15, align: 'left', lineSpacing: 2, firstLineIndentChars: 0 } }],
      page: { paper: 'Letter', marginTopCm: 1, marginBottomCm: 1, marginLeftCm: 1, marginRightCm: 1, pageNumber: true },
    };
    render(<OutcomeWordFormattingPanel document={styled} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: '排版' }));
    fireEvent.change(screen.getByLabelText('自然语言要求'), { target: { value: '页边距 2cm' } });
    fireEvent.click(screen.getByRole('button', { name: '解析并应用' }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [expect.objectContaining({ style: { fontFamily: '仿宋', fontSizePt: 15, align: 'left', lineSpacing: 2, firstLineIndentChars: 0 } })],
      page: expect.objectContaining({ paper: 'Letter', marginTopCm: 2, marginBottomCm: 2, marginLeftCm: 2, marginRightCm: 2, pageNumber: true }),
    }), '按自然语言排版：页边距 2cm');
  });

  it('hydrates editable controls from imported Word settings, including legacy point margins', () => {
    const onApply = vi.fn();
    const imported: WordDocument = {
      ...document,
      page: { paper: 'Letter', marginTop: 72, marginRight: 90, marginBottom: 108, marginLeft: 126, pageNumber: true },
      header: '外部页眉', footer: '外部页脚',
      blocks: [{ ...document.blocks[0], style: { fontFamily: '仿宋', fontSize: 15, align: 'center', firstLineIndent: 30, lineSpacing: 2, spaceAfter: 8 } }],
    };
    render(<OutcomeWordFormattingPanel document={imported} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: '排版' }));
    expect((screen.getByLabelText('正文字体') as HTMLInputElement).value).toBe('仿宋');
    expect((screen.getByLabelText('字号（pt）') as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText('正文对齐') as HTMLSelectElement).value).toBe('center');
    expect((screen.getByLabelText('正文行距') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('首行缩进') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('上边距') as HTMLInputElement).value).toBe('2.54');
    expect((screen.getByLabelText('左边距') as HTMLInputElement).value).toBe('4.45');
    expect((screen.getByLabelText('页眉') as HTMLInputElement).value).toBe('外部页眉');
    expect((screen.getByLabelText('页脚') as HTMLInputElement).value).toBe('外部页脚');
    expect((screen.getByLabelText('页码') as HTMLInputElement).checked).toBe(true);
  });
});
