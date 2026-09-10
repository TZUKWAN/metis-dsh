import type { WordDocument } from '../runtime/OutcomeRuntimeContract.js';

/**
 * A small, explicit formatting policy for the Outcome Word document model.
 *
 * This is deliberately a model transformation, not a renderer-only preview:
 * the returned style and page fields are stored in the immutable outcome
 * version, and the DOCX codec uses the same fields when it writes OOXML.
 */
export type WordFormattingConfig = Readonly<{
  page?: Readonly<{
    paper?: 'A4' | 'Letter' | 'custom';
    marginTopCm?: number;
    marginBottomCm?: number;
    marginLeftCm?: number;
    marginRightCm?: number;
  }>;
  body?: Readonly<{
    fontFamily?: string;
    fontSizePt?: number;
    color?: string;
    align?: 'left' | 'center' | 'right' | 'justify';
    firstLineIndentChars?: number;
    lineSpacing?: number;
    spaceBeforePt?: number;
    spaceAfterPt?: number;
  }>;
  headings?: Readonly<Partial<Record<1 | 2 | 3 | 4 | 5 | 6, Readonly<{
    fontFamily?: string;
    fontSizePt?: number;
    color?: string;
    align?: 'left' | 'center' | 'right' | 'justify';
    lineSpacing?: number;
    spaceBeforePt?: number;
    spaceAfterPt?: number;
  }>>>>;
  captions?: Readonly<{
    fontFamily?: string;
    fontSizePt?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
  }>;
}>;

type ParagraphFormatting = Readonly<{
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
}>;

export type WordFormattingResult = Readonly<{
  document: WordDocument;
  changedBlocks: number;
  summary: string;
}>;

export type WordFormattingInstructionResult = Readonly<{
  config: WordFormattingConfig;
  recognized: string[];
  unsupported: string[];
}>;

type Style = Record<string, unknown>;

const MAX_MARGIN_CM = 10;
const MAX_FONT_SIZE = 96;
const MAX_LINE_SPACING = 4;
const MAX_SPACING_PT = 240;
const MAX_INDENT_CHARS = 16;
const COLOR = /^#?[0-9a-f]{6}$/iu;

function finiteInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function cleanFont(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 128 ? value.trim() : undefined;
}

function cleanColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !COLOR.test(value)) return undefined;
  return `#${value.replace('#', '').toUpperCase()}`;
}

function asParagraphStyle(value: ParagraphFormatting | undefined): Style {
  if (!value) return {};
  const style: Style = {};
  const fontFamily = cleanFont(value.fontFamily);
  const fontSizePt = finiteInRange(value.fontSizePt, 6, MAX_FONT_SIZE);
  const color = cleanColor(value.color);
  const align = value.align;
  const lineSpacing = finiteInRange(value.lineSpacing, 0.5, MAX_LINE_SPACING);
  const spaceBeforePt = finiteInRange(value.spaceBeforePt, 0, MAX_SPACING_PT);
  const spaceAfterPt = finiteInRange(value.spaceAfterPt, 0, MAX_SPACING_PT);
  if (fontFamily) style.fontFamily = fontFamily;
  if (fontSizePt !== undefined) style.fontSizePt = fontSizePt;
  if (color) style.color = color;
  if (align) style.align = align;
  if (lineSpacing !== undefined) style.lineSpacing = lineSpacing;
  if (spaceBeforePt !== undefined) style.spaceBeforePt = spaceBeforePt;
  if (spaceAfterPt !== undefined) style.spaceAfterPt = spaceAfterPt;
  return style;
}

function bodyStyle(config: WordFormattingConfig['body']): Style {
  const style = asParagraphStyle(config);
  const firstLineIndentChars = finiteInRange(config?.firstLineIndentChars, 0, MAX_INDENT_CHARS);
  if (firstLineIndentChars !== undefined) style.firstLineIndentChars = firstLineIndentChars;
  return style;
}

function pageStyle(page: WordFormattingConfig['page']): Record<string, unknown> {
  if (!page) return {};
  const result: Record<string, unknown> = {};
  if (page.paper) result.paper = page.paper;
  const margins: Array<[keyof typeof page, string]> = [
    ['marginTopCm', 'marginTopCm'],
    ['marginBottomCm', 'marginBottomCm'],
    ['marginLeftCm', 'marginLeftCm'],
    ['marginRightCm', 'marginRightCm'],
  ];
  for (const [input, output] of margins) {
    const value = finiteInRange(page[input], 0, MAX_MARGIN_CM);
    if (value !== undefined) result[output] = value;
  }
  return result;
}

function equalStyle(left: Style, right: Style): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

/** Apply the requested structured policy to all stored Word blocks. */
export function applyWordFormatting(document: WordDocument, config: WordFormattingConfig): WordFormattingResult {
  const body = bodyStyle(config.body);
  const captions = asParagraphStyle(config.captions);
  let changedBlocks = 0;
  const blocks = document.blocks.map((block) => {
    if (block.kind === 'table') return block;
    const fromConfig = block.kind === 'heading'
      ? asParagraphStyle(config.headings?.[Math.min(6, Math.max(1, block.level ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6])
      : (block.kind === 'figure_caption' || block.kind === 'table_caption' ? captions : body);
    const nextStyle = { ...(block.style ?? {}), ...fromConfig };
    if (!equalStyle(block.style ?? {}, nextStyle)) changedBlocks += 1;
    return { ...block, ...(Object.keys(nextStyle).length > 0 ? { style: nextStyle } : {}) };
  });
  const nextPage = { ...document.page, ...pageStyle(config.page) };
  const pageChanged = JSON.stringify(nextPage) !== JSON.stringify(document.page);
  return {
    document: { ...document, blocks, page: nextPage },
    changedBlocks,
    summary: `${changedBlocks} 个文档块${pageChanged ? '及页面设置' : ''}已按排版方案更新`,
  };
}

const CHINESE_SIZE_TO_PT: Readonly<Record<string, number>> = Object.freeze({
  '初号': 42, '小初': 36, '一号': 26, '小一': 24, '二号': 22, '小二': 18,
  '三号': 16, '小三': 15, '四号': 14, '小四': 12, '五号': 10.5, '小五': 9,
});

function addNumber(config: Record<string, unknown>, recognized: string[], key: string, value: number, label: string): void {
  config[key] = value;
  recognized.push(label);
}

/**
 * Deterministic, intentionally small natural-language bridge for the layout
 * panel. It only recognizes explicit, auditable instructions; the caller can
 * render unrecognized text as guidance instead of pretending it was applied.
 */
export function parseWordFormattingInstruction(instruction: string): WordFormattingInstructionResult {
  const raw = instruction.trim();
  const body: Record<string, unknown> = {};
  const page: Record<string, unknown> = {};
  const recognized: string[] = [];
  if (/\bA4\b/iu.test(raw) || /A4纸/u.test(raw)) { page.paper = 'A4'; recognized.push('A4 页面'); }
  if (/\bLetter\b/iu.test(raw) || /信纸/u.test(raw)) { page.paper = 'Letter'; recognized.push('Letter 页面'); }
  const font = raw.match(/(?:字体(?:为|用)?|使用)\s*([\p{L}\p{N} .-]{2,64})/u)?.[1]?.trim();
  if (font) { body.fontFamily = font.replace(/[，,。；;].*$/u, '').trim(); recognized.push(`字体 ${body.fontFamily}`); }
  const chineseSize = Object.entries(CHINESE_SIZE_TO_PT).find(([name]) => raw.includes(name));
  if (chineseSize) addNumber(body, recognized, 'fontSizePt', chineseSize[1], `${chineseSize[0]} ${chineseSize[1]}pt`);
  const size = raw.match(/(?:字号|字体大小)\s*(\d+(?:\.\d+)?)\s*(?:pt|磅)?/iu);
  if (size) { const parsed = Number(size[1]); if (finiteInRange(parsed, 6, MAX_FONT_SIZE) !== undefined) addNumber(body, recognized, 'fontSizePt', parsed, `字号 ${parsed}pt`); }
  const line = raw.match(/(\d+(?:\.\d+)?)\s*倍行距/u);
  if (line) { const parsed = Number(line[1]); if (finiteInRange(parsed, 0.5, MAX_LINE_SPACING) !== undefined) addNumber(body, recognized, 'lineSpacing', parsed, `${parsed} 倍行距`); }
  const indent = raw.match(/首行缩进\s*(\d+(?:\.\d+)?)\s*(?:字符|字)/u);
  if (indent) { const parsed = Number(indent[1]); if (finiteInRange(parsed, 0, MAX_INDENT_CHARS) !== undefined) addNumber(body, recognized, 'firstLineIndentChars', parsed, `首行缩进 ${parsed} 字符`); }
  const margin = raw.match(/页边距\s*(\d+(?:\.\d+)?)\s*(?:cm|厘米)/iu);
  if (margin) { const parsed = Number(margin[1]); if (finiteInRange(parsed, 0, MAX_MARGIN_CM) !== undefined) { page.marginTopCm = parsed; page.marginBottomCm = parsed; page.marginLeftCm = parsed; page.marginRightCm = parsed; recognized.push(`页边距 ${parsed}cm`); } }
  const alignments: Array<readonly [RegExp, 'left' | 'center' | 'right' | 'justify', string]> = [
    [/两端对齐/u, 'justify', '两端对齐'], [/居中/u, 'center', '居中'], [/右对齐/u, 'right', '右对齐'], [/左对齐/u, 'left', '左对齐'],
  ];
  for (const [pattern, value, label] of alignments) if (pattern.test(raw)) { body.align = value; recognized.push(label); break; }
  const unsupported = raw && recognized.length === 0 ? ['未识别到可安全执行的结构化排版指令；请明确写出字体、字号、对齐、行距、缩进或页边距。'] : [];
  return { config: { ...(Object.keys(page).length > 0 ? { page: page as WordFormattingConfig['page'] } : {}), ...(Object.keys(body).length > 0 ? { body: body as WordFormattingConfig['body'] } : {}) }, recognized, unsupported };
}
