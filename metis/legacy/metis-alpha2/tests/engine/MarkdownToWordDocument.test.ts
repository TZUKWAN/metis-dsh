import { describe, expect, it } from 'vitest';
import { WordDocumentSchema } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { markdownToWordDocument } from '../../engine/export/MarkdownToWordDocument.js';

describe('markdownToWordDocument (2026-08-31 交付物 Word 化)', () => {
  it('converts headings, paragraphs, lists, tables, quotes and code into structured blocks', () => {
    const doc = markdownToWordDocument([
      '# 综述标题',
      '',
      '正文第一段，包含**粗体**与*斜体*标记。',
      '',
      '## 小节',
      '',
      '- 要点一',
      '- 要点二',
      '  - 嵌套要点',
      '',
      '1. 第一步',
      '2. 第二步',
      '',
      '| 作者 | 年份 |',
      '| --- | --- |',
      '| Marx | 1867 |',
      '',
      '> 引文块内容。',
      '',
      '```',
      'const a = 1;',
      'const b = 2;',
      '```',
    ].join('\n'));

    expect(WordDocumentSchema.safeParse(doc).success).toBe(true);
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: '综述标题' });
    // 行内样式如实降级为纯文本（块模型无行内 run）。
    const paragraph = doc.blocks.find((block) => block.kind === 'paragraph' && block.text?.includes('粗体'));
    expect(paragraph?.text).toBe('正文第一段，包含粗体与斜体标记。');
    expect(doc.blocks.some((block) => block.kind === 'heading' && block.level === 2 && block.text === '小节')).toBe(true);

    const bullets = doc.blocks.filter((block) => block.style?.list === 'bullet');
    expect(bullets.map((block) => [block.text, block.style?.listLevel])).toEqual([
      ['要点一', 0],
      ['要点二', 0],
      ['嵌套要点', 1],
    ]);
    const numbered = doc.blocks.filter((block) => block.style?.list === 'numbered');
    expect(numbered.map((block) => block.text)).toEqual(['第一步', '第二步']);

    const table = doc.blocks.find((block) => block.kind === 'table');
    expect(table?.rows).toEqual([['作者', '年份'], ['Marx', '1867']]);

    const quote = doc.blocks.find((block) => block.text === '引文块内容。');
    expect(quote?.style?.indentLeftPt).toBe(18);

    const codeLines = doc.blocks.filter((block) => block.style?.fontFamily === 'Consolas');
    expect(codeLines.map((block) => block.text)).toEqual(['const a = 1;', 'const b = 2;']);
  });

  it('keeps DOI links reachable and degrades images to placeholders', () => {
    const doc = markdownToWordDocument('见 [Srnicek 2017](https://doi.org/10.1234/abc)。\n\n![示意图](https://example.com/x.png)');
    const first = doc.blocks[0];
    expect(first?.text).toContain('Srnicek 2017 (https://doi.org/10.1234/abc)');
    expect(doc.blocks[1]?.text).toBe('[图片：示意图]');
  });

  it('collects footnote definitions as small-print paragraphs', () => {
    const doc = markdownToWordDocument('正文引用[^1]。\n\n[^1]: 脚注内容。');
    expect(doc.blocks.at(-1)).toMatchObject({ kind: 'paragraph', text: '[1] 脚注内容。' });
  });

  it('returns an empty document for blank input instead of fabricating content', () => {
    expect(markdownToWordDocument('').blocks).toEqual([]);
    expect(markdownToWordDocument('   \n\n ').blocks).toEqual([]);
  });

  it('produces unique schema-valid block ids for long documents', () => {
    const long = Array.from({ length: 60 }, (_, index) => `## 第 ${index + 1} 节\n\n段落 ${index + 1}。`).join('\n\n');
    const doc = markdownToWordDocument(long);
    expect(WordDocumentSchema.safeParse(doc).success).toBe(true);
    expect(new Set(doc.blocks.map((block) => block.id)).size).toBe(doc.blocks.length);
    expect(doc.blocks).toHaveLength(120);
  });
});
