import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract';

type WordBlock = WordDocument['blocks'][number];
type WordStyle = Record<string, unknown>;

function nextId(document: WordDocument, prefix: string): string {
  const ids = new Set(document.blocks.map((block) => block.id));
  let index = document.blocks.length + 1;
  let id = `${prefix}-${index}`;
  while (ids.has(id)) id = `${prefix}-${++index}`;
  return id;
}

function insertAfter(document: WordDocument, afterBlockId: string | undefined, block: WordBlock): WordDocument {
  const index = afterBlockId ? document.blocks.findIndex((candidate) => candidate.id === afterBlockId) : document.blocks.length - 1;
  if (index < 0) return document;
  const blocks = [...document.blocks];
  blocks.splice(index + 1, 0, block);
  return { ...document, blocks };
}

export function insertWordTable(document: WordDocument, rows: number, columns: number, afterBlockId?: string): WordDocument {
  const rowCount = Math.max(1, Math.min(200, Math.round(rows)));
  const columnCount = Math.max(1, Math.min(63, Math.round(columns)));
  const block: WordBlock = {
    id: nextId(document, 'table'),
    kind: 'table',
    rows: Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => '')),
  };
  return insertAfter(document, afterBlockId, block);
}

export function insertWordPageBreak(document: WordDocument, afterBlockId: string): WordDocument {
  const block: WordBlock = { id: nextId(document, 'page-break'), kind: 'paragraph', text: '', style: { pageBreakBefore: true } };
  return insertAfter(document, afterBlockId, block);
}

export function toggleWordList(document: WordDocument, blockId: string, kind: 'bullet' | 'numbered'): WordDocument {
  return {
    ...document,
    blocks: document.blocks.map((block) => {
      if (block.id !== blockId) return block;
      const style = { ...((block.style ?? {}) as WordStyle) };
      if (style.list === kind) delete style.list;
      else style.list = kind;
      return { ...block, style };
    }),
  };
}

function isSafeStyleValue(value: unknown): value is string | number | boolean {
  return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' || typeof value === 'boolean';
}

export function updateWordActiveStyle(document: WordDocument, blockId: string, patch: Record<string, unknown>): WordDocument {
  const safePatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => isSafeStyleValue(value)));
  if (Object.keys(safePatch).length === 0) return document;
  return {
    ...document,
    blocks: document.blocks.map((block) => block.id === blockId ? { ...block, style: { ...((block.style ?? {}) as WordStyle), ...safePatch } } : block),
  };
}

function textOf(block: WordBlock): string {
  if (block.kind === 'table') return (block.rows ?? []).flat().join(' ');
  if (block.kind === 'image') return '';
  return block.text ?? '';
}

function countWords(value: string): number {
  return (value.match(/[\p{L}\p{N}]+|\p{Script=Han}/gu) ?? []).length;
}

export function wordDocumentStats(document: WordDocument): { words: number; characters: number; paragraphs: number; tables: number; images: number } {
  const textBlocks = document.blocks.filter((block) => block.kind !== 'image');
  const textParts = textBlocks.map(textOf);
  const text = textParts.join(' ');
  return {
    words: countWords(text),
    characters: textParts.reduce((total, part) => total + Array.from(part).length, 0),
    paragraphs: document.blocks.filter((block) => block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'figure_caption' || block.kind === 'table_caption').length,
    tables: document.blocks.filter((block) => block.kind === 'table').length,
    images: document.blocks.filter((block) => block.kind === 'image').length,
  };
}
