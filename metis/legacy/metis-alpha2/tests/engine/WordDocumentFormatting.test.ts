import { describe, expect, it } from 'vitest';
import { applyWordFormatting, parseWordFormattingInstruction } from '../../engine/outcomes/WordDocumentFormatting.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';

const document: WordDocument = {
  type: 'word',
  page: { paper: 'A4' },
  header: '',
  footer: '',
  blocks: [
    { id: 'h1', kind: 'heading', level: 1, text: '研究标题' },
    { id: 'p1', kind: 'paragraph', text: '正文内容。', style: { bold: true } },
    { id: 'caption', kind: 'figure_caption', text: '图 1 实验过程' },
    { id: 'table', kind: 'table', rows: [['项目', '结果'], ['A', '通过']] },
  ],
};

describe('WordDocumentFormatting', () => {
  it('persists an explicit structured layout policy into the same Word document model', () => {
    const result = applyWordFormatting(document, {
      page: { paper: 'A4', marginTopCm: 2.54, marginBottomCm: 2.54, marginLeftCm: 3, marginRightCm: 3 },
      body: { fontFamily: '宋体', fontSizePt: 12, align: 'justify', firstLineIndentChars: 2, lineSpacing: 1.5, spaceAfterPt: 6 },
      headings: { 1: { fontFamily: '黑体', fontSizePt: 16, align: 'center', spaceBeforePt: 12 } },
      captions: { fontFamily: '楷体', fontSizePt: 10.5, align: 'center' },
    });
    expect(result.changedBlocks).toBe(3);
    expect(result.document).not.toBe(document);
    expect(document.blocks[1]?.style).toEqual({ bold: true });
    expect(result.document.blocks[0]?.style).toMatchObject({ fontFamily: '黑体', fontSizePt: 16, align: 'center' });
    expect(result.document.blocks[1]?.style).toMatchObject({ bold: true, fontFamily: '宋体', firstLineIndentChars: 2, lineSpacing: 1.5 });
    expect(result.document.blocks[2]?.style).toMatchObject({ fontFamily: '楷体', align: 'center' });
    expect(result.document.blocks[3]?.style).toBeUndefined();
    expect(result.document.page).toMatchObject({ marginLeftCm: 3, marginRightCm: 3 });
  });

  it('accepts only explicit supported natural-language formatting instructions', () => {
    const parsed = parseWordFormattingInstruction('请使用宋体，小四，1.5 倍行距，首行缩进 2 字符，两端对齐，页边距 2.54cm，A4 纸。');
    expect(parsed.recognized.length).toBeGreaterThanOrEqual(6);
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.config.body).toMatchObject({ fontFamily: '宋体', fontSizePt: 12, lineSpacing: 1.5, firstLineIndentChars: 2, align: 'justify' });
    expect(parsed.config.page).toMatchObject({ paper: 'A4', marginTopCm: 2.54, marginRightCm: 2.54 });
  });

  it('does not claim an opaque instruction was applied', () => {
    const parsed = parseWordFormattingInstruction('把这个文档弄得更高级一点');
    expect(parsed.config).toEqual({});
    expect(parsed.recognized).toEqual([]);
    expect(parsed.unsupported).toHaveLength(1);
  });
});
