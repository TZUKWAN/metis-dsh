import { describe, expect, it } from 'vitest';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { insertWordPageBreak, insertWordTable, toggleWordList, updateWordActiveStyle, wordDocumentStats } from '../../src/components/OfficeWordOperations';

const doc: WordDocument = {
  type: 'word',
  blocks: [
    { id: 'p-1', kind: 'paragraph', text: 'Hello world', style: { custom: 'keep' } },
    { id: 'h-1', kind: 'heading', level: 1, text: 'Heading' },
  ],
  page: { paper: 'A4' },
  header: '',
  footer: '',
};

describe('OfficeWordOperations', () => {
  it('inserts a bounded table after the requested block', () => {
    const result = insertWordTable(doc, 2, 3, 'p-1');
    expect(result.blocks[1]).toMatchObject({ kind: 'table', rows: [['', '', ''], ['', '', '']] });
    expect(result.blocks[0]).toEqual(doc.blocks[0]);
  });

  it('inserts a page break block after the requested block', () => {
    const result = insertWordPageBreak(doc, 'p-1');
    expect(result.blocks[1]).toMatchObject({ kind: 'paragraph', text: '', style: { pageBreakBefore: true } });
  });

  it('toggles list formatting while preserving text and unrelated style keys', () => {
    const listed = toggleWordList(doc, 'p-1', 'bullet');
    expect(listed.blocks[0]).toMatchObject({ text: 'Hello world', style: { custom: 'keep', list: 'bullet' } });
    const unlisted = toggleWordList(listed, 'p-1', 'bullet');
    expect(unlisted.blocks[0]?.style).toEqual({ custom: 'keep' });
  });

  it('applies finite style fields only to the active block', () => {
    const result = updateWordActiveStyle(doc, 'p-1', { fontSizePt: 15, lineSpacing: 2, invalid: Infinity });
    expect(result.blocks[0]?.style).toEqual({ custom: 'keep', fontSizePt: 15, lineSpacing: 2 });
    expect(result.blocks[1]).toEqual(doc.blocks[1]);
  });

  it('returns deterministic document statistics', () => {
    expect(wordDocumentStats({ ...doc, blocks: [...doc.blocks, { id: 't-1', kind: 'table', rows: [['A', 'B']] }, { id: 'i-1', kind: 'image', text: 'image' }] })).toEqual({
      words: 5,
      characters: 21,
      paragraphs: 2,
      tables: 1,
      images: 1,
    });
  });
});
