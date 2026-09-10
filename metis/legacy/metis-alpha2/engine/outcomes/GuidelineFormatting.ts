import type { WordFormattingConfig } from './WordDocumentFormatting.js';

/**
 * Deterministic parsing of Chinese journal/thesis formatting requirements
 * ("正文宋体小四，1.5 倍行距，首行缩进 2 字符") into WordFormattingConfig.
 * Pure function so it is fully testable and works without a model provider;
 * sentences that mention formatting but cannot be mapped safely land in
 * `unclear` for the caller (optionally the AI fallback) to handle.
 */

export interface GuidelineFormattingMatch {
  rule: string;
  /** Verbatim source sentence (≤120 chars) backing the rule. */
  excerpt: string;
}

/** 深度只读的 WordFormattingConfig 不便逐字段构建；各解析器先用可变草稿，出口再断言。 */
export interface MutableFormattingSlot {
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  firstLineIndentChars?: number;
}

export interface MutableFormattingDraft {
  page?: Record<string, number | string | undefined>;
  body?: MutableFormattingSlot;
  headings?: Record<string, MutableFormattingSlot>;
  captions?: Record<string, unknown>;
}

export interface GuidelineFormattingResult {
  config: WordFormattingConfig;
  matched: GuidelineFormattingMatch[];
  unclear: string[];
}

/** 中文字号 → 磅值。 */
// 键不带"号"字，与正则捕获组一致；口语里"小四""三号"两种写法都常见。
const CN_FONT_SIZES: Record<string, number> = {
  初: 42, 小初: 36, 一: 26, 小一: 24, 二: 22, 小二: 18, 三: 16, 小三: 15,
  四: 14, 小四: 12, 五: 10.5, 小五: 9, 六: 7.5, 小六: 6.5, 七: 5.5, 八: 5,
};

const FONT_NAMES = [
  'Times New Roman', 'Microsoft YaHei', '微软雅黑', '仿宋_GB2312', '楷体_GB2312',
  '宋体', '仿宋', '楷体', '黑体', '隶书', 'Arial', 'Calibri',
];

const ALIGN_MAP: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
  居中: 'center', 两端对齐: 'justify', 左对齐: 'left', 右对齐: 'right',
};

type HeadingTarget = { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6 };
type BodyTarget = { kind: 'body' };
type ParseTarget = HeadingTarget | BodyTarget | { kind: 'skip' };

function detectTarget(sentence: string): ParseTarget {
  const levelMatch = /(?:第?\s*)?([一二三四五六1-6])\s*级\s*标题/u.exec(sentence);
  if (levelMatch) {
    const levelToken = levelMatch[1]!;
    const level = '一二三四五六'.indexOf(levelToken) >= 0 ? '一二三四五六'.indexOf(levelToken) + 1 : Number(levelToken);
    if (level >= 1 && level <= 6) return { kind: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6 };
  }
  if (/章标题|章名/u.test(sentence)) return { kind: 'heading', level: 1 };
  if (/节标题|节名/u.test(sentence)) return { kind: 'heading', level: 2 };
  // 参考文献条目、图表题注有独立排版习惯，确定性引擎不猜。
  if (/参考文献|图题|表题|图表|题注|脚注|页眉|页脚/u.test(sentence)) return { kind: 'skip' };
  return { kind: 'body' };
}

function detectFontSizes(sentence: string): { pt?: number; label?: string } {
  // 小X系列口语可省"号"；单字号（三号）必须带"号"，否则"一级"会被误读成字号。
  const cnMatch = /(小[初一二三四五六])号?|([初一二三四五六七八])号/u.exec(sentence);
  const cn = cnMatch?.[1] ?? cnMatch?.[2];
  if (cn && CN_FONT_SIZES[cn] !== undefined) return { pt: CN_FONT_SIZES[cn], label: `${cn}号（${CN_FONT_SIZES[cn]}pt）` };
  const pt = /([0-9]+(?:\.[0-9]+)?)\s*(?:pt|磅)(?!\/)/iu.exec(sentence)?.[1];
  if (pt !== undefined) {
    const value = Number(pt);
    if (Number.isFinite(value) && value >= 5 && value <= 72) return { pt: value, label: `${value}pt` };
  }
  return {};
}

function detectLineSpacing(sentence: string): number | undefined {
  if (/单倍行距/u.test(sentence)) return 1;
  if (/双倍行距/u.test(sentence)) return 2;
  const multiple = /([0-9]+(?:\.[0-9]+)?)\s*倍(?:\s*行距)?|行距[为是:：]?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*倍)?/u.exec(sentence);
  const value = Number(multiple?.[1] ?? multiple?.[2]);
  if (Number.isFinite(value) && value >= 0.5 && value <= 4) return value;
  return undefined;
}

function detectAlign(sentence: string): 'left' | 'center' | 'right' | 'justify' | undefined {
  for (const [needle, value] of Object.entries(ALIGN_MAP)) {
    if (sentence.includes(needle)) return value;
  }
  return undefined;
}

function detectIndentChars(sentence: string): number | undefined {
  const chars = /首行缩进\s*([0-9]+(?:\.[0-9]+)?)\s*(?:个)?\s*字符/u.exec(sentence)?.[1];
  const value = Number(chars);
  return Number.isFinite(value) && value > 0 && value <= 16 ? value : undefined;
}

function detectFonts(sentence: string): string[] {
  return FONT_NAMES.filter((font) => sentence.includes(font));
}

const FORMAT_TOPICS = /字体|字号|行距|缩进|对齐|页边距|磅|号字|宋体|黑体|楷体|仿宋/u;

/** 全文级页边距解析：支持"上下 2.5cm，左右 3cm"与逐边"上边距 3 厘米"。 */
function parsePageMargins(text: string): { margins: Record<string, number>; excerpts: string[] } {
  const margins: Record<string, number> = {};
  const excerpts: string[] = [];
  const toCm = (value: number, unit: string): number | undefined => {
    if (/cm|厘米|公分/iu.test(unit)) return Math.round(value * 100) / 100;
    if (/mm|毫米/iu.test(unit)) return Math.round((value / 10) * 100) / 100;
    return undefined;
  };
  const combined = /上下(?:边距)?[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)\s*(cm|CM|厘米|公分|毫米|mm)[^。；;\n]{0,10}?左右(?:边距)?[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)\s*(cm|CM|厘米|公分|毫米|mm)/u.exec(text);
  if (combined) {
    const topBottom = toCm(Number(combined[1]), combined[2]!);
    const leftRight = toCm(Number(combined[3]), combined[4]!);
    if (topBottom !== undefined && leftRight !== undefined) {
      margins.marginTopCm = topBottom;
      margins.marginBottomCm = topBottom;
      margins.marginLeftCm = leftRight;
      margins.marginRightCm = leftRight;
      excerpts.push(combined[0].slice(0, 120));
      return { margins, excerpts };
    }
  }
  const perSide: Array<[RegExp, keyof NonNullable<WordFormattingConfig['page']>]> = [
    [/上(?:边距)?[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(cm|CM|厘米|公分|毫米|mm)/u, 'marginTopCm'],
    [/下(?:边距)?[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(cm|CM|厘米|公分|毫米|mm)/u, 'marginBottomCm'],
    [/左(?:边距)?[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(cm|CM|厘米|公分|毫米|mm)/u, 'marginLeftCm'],
    [/右(?:边距)?[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(cm|CM|厘米|公分|毫米|mm)/u, 'marginRightCm'],
  ];
  for (const [pattern, key] of perSide) {
    const match = pattern.exec(text);
    if (!match) continue;
    const cm = toCm(Number(match[1]), match[2]!);
    if (cm === undefined) continue;
    margins[key] = cm;
    excerpts.push(match[0].slice(0, 60));
  }
  return { margins, excerpts };
}

function describe(target: ParseTarget, parts: string[]): string {
  const label = target.kind === 'heading' ? `${target.level} 级标题` : target.kind === 'body' ? '正文' : '排版';
  return `${label}：${parts.join(' / ')}`;
}

export function parseGuidelineFormatting(text: string): GuidelineFormattingResult {
  const draft: MutableFormattingDraft = {};
  const matched: GuidelineFormattingMatch[] = [];
  const unclear: string[] = [];
  const cleanText = text.replace(/\s+/gu, ' ');

  const marginResult = parsePageMargins(cleanText);
  if (Object.keys(marginResult.margins).length > 0) {
    draft.page = { ...marginResult.margins };
    matched.push({ rule: `页边距：${Object.entries(marginResult.margins).map(([key, value]) => `${key.replace('margin', '').replace('Cm', '')} ${value}cm`).join(' / ')}`, excerpt: marginResult.excerpts[0] ?? '' });
  }

  const body: MutableFormattingSlot = {};
  const headings: Record<string, MutableFormattingSlot> = {};
  const sentences = text.split(/[。；;;\n]+/u).map((sentence) => sentence.trim()).filter(Boolean);

  for (const sentence of sentences) {
    if (!FORMAT_TOPICS.test(sentence)) continue;
    const target = detectTarget(sentence);
    if (target.kind === 'skip') continue;

    const fonts = detectFonts(sentence);
    const size = detectFontSizes(sentence);
    const line = detectLineSpacing(sentence);
    const align = detectAlign(sentence);
    const indent = detectIndentChars(sentence);
    const fixedSpacing = /行距.{0,4}固定值?\s*[0-9.]+\s*(磅|pt)/iu.test(sentence);

    if (fixedSpacing && line === undefined) {
      unclear.push(sentence.slice(0, 120));
      continue;
    }
    if (fonts.length === 0 && size.pt === undefined && line === undefined && align === undefined && indent === undefined) {
      unclear.push(sentence.slice(0, 120));
      continue;
    }

    const parts: string[] = [];
    const sink = target.kind === 'heading'
      ? (headings[target.level] ??= {})
      : body;
    if (fonts.length > 0) {
      sink.fontFamily = fonts[0]!;
      parts.push(fonts[0]!);
    }
    if (size.pt !== undefined) {
      sink.fontSizePt = size.pt;
      parts.push(size.label ?? `${size.pt}pt`);
    }
    if (align !== undefined) {
      sink.align = align;
      parts.push(Object.entries(ALIGN_MAP).find(([, value]) => value === align)?.[0] ?? align);
    }
    if (line !== undefined) {
      sink.lineSpacing = line;
      parts.push(`${line} 倍行距`);
    }
    if (indent !== undefined && target.kind === 'body') {
      body.firstLineIndentChars = indent;
      parts.push(`首行缩进 ${indent} 字符`);
    }
    if (parts.length > 0) matched.push({ rule: describe(target, parts), excerpt: sentence.slice(0, 120) });
  }

  if (Object.keys(body).length > 0) draft.body = body;
  if (Object.keys(headings).length > 0) draft.headings = headings;

  return { config: draft as unknown as WordFormattingConfig, matched, unclear };
}
