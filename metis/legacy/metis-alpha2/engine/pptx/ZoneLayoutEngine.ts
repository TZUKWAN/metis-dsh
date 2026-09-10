import { z } from 'zod';
import {
  OutlineDocumentSchema,
  OutlinePageSchema,
  PptThemeProfileSchema,
  getPptThemeProfile,
  type OutlineDocument,
  type OutlinePage,
  type PptThemeProfile,
  type Zone,
  outlineContractPrompt,
} from './ZoneOutlineContract.js';
export { OutlineDocumentSchema, outlineContractPrompt, getPptThemeProfile };

/**
 * Zone 垂直流版式引擎（2026-09-01 融入 wut-ppt 方法论）。
 *
 * 内容与版式分离：模型只产出大纲 JSON；本引擎用确定性两遍布局
 * （估高 → 剩余空间按比例分配给可伸展 zone）把每页渲染为 PptElement 网格元素，
 * 保证：每个要点独立形状包裹、序号圆徽、逻辑引导形状、高密度、零大片空白、
 * 正文字号不低于主题下限。全部为纯函数，可离线测试。
 */

export const ZONE_GRID = { width: 32, height: 18 } as const;
const CONTENT = { x: 1, width: 30, yTop: 3, yBottom: 17.4 } as const;
const ZONE_GAP = 0.14;

type LayoutElement = {
  id: string;
  type: 'text' | 'rect' | 'roundRect' | 'ellipse' | 'line' | 'arrow';
  x: number; y: number; width: number; height: number;
  locked: boolean;
  props: Record<string, unknown>;
};

// ─── 文本量估算（CJK 一字一格宽的近似） ─────────────────────────

function estimateLines(text: string, widthGrids: number, fontSizePt: number): number {
  // 12pt 微软雅黑在 1 grid（≈0.4in）宽内约 2.2 个汉字；按字号线性缩放。
  const charsPerLine = Math.max(6, Math.floor((widthGrids * 2.2 * 12) / fontSizePt));
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

function zoneHeight(zone: Zone, widthGrids: number, theme: PptThemeProfile): number {
  const body = theme.fontSizes.body;
  switch (zone.type) {
    case 'lead':
      return estimateLines(zone.text, widthGrids - 1.4, theme.fontSizes.lead) * 0.62 + 0.8;
    case 'cards': {
      const columns = zone.cards.length;
      const columnWidth = (widthGrids - (columns - 1) * 0.5) / columns;
      const columnHeights = zone.cards.map((card) => {
        const head = 1.1;
        const items = card.items.reduce((sum, item) => {
          const text = 'text' in item ? item.text : '';
          return sum + 0.9 + estimateLines(text, columnWidth - 1.6, body) * 0.62 + 0.5;
        }, 0);
        return head + items + 0.4;
      });
      return Math.max(...columnHeights) + 0.4;
    }
    case 'flow_chain': {
      const hasText = zone.items.some((item) => item.text);
      return hasText ? 2.0 + zone.items.length * 1.9 : 2.2;
    }
    case 'timeline':
      return 2.0 + Math.max(...zone.phases.map((phase) => phase.tasks.length)) * 1.5 + 0.6;
    case 'badge_grid': {
      const rows = Math.ceil(zone.items.length / zone.cols);
      return rows * 2.6 + 0.4;
    }
    case 'chips': {
      const chipsHeight = 1.8;
      const noteHeight = zone.text ? estimateLines(zone.text, widthGrids, body) * 0.62 + 0.4 : 0;
      return chipsHeight + noteHeight;
    }
  }
}

const STRETCHY = new Set(['cards', 'timeline', 'badge_grid']);

// ─── 元素工厂 ───────────────────────────────────────────────────

class ElementSink {
  private counter = 0;
  readonly elements: LayoutElement[] = [];
  private readonly pageTag: string;
  constructor(pageTag: string) {
    this.pageTag = pageTag;
  }

  next(tag: string): string {
    this.counter += 1;
    return `${this.pageTag}-e${this.counter}-${tag}`;
  }

  push(element: Omit<LayoutElement, 'id' | 'locked'>): LayoutElement {
    const full = { ...element, id: this.next(element.type), locked: false };
    this.elements.push(full);
    return full;
  }
}

function clampRect(x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const widthC = Math.max(1, Math.min(ZONE_GRID.width, width));
  const heightC = Math.max(1, Math.min(ZONE_GRID.height, height));
  return {
    x: Math.max(0, Math.min(ZONE_GRID.width - widthC, x)),
    y: Math.max(0, Math.min(ZONE_GRID.height - heightC, y)),
    width: widthC, height: heightC,
  };
}

function renderZone(zone: Zone, rect: { x: number; y: number; width: number; height: number }, sink: ElementSink, theme: PptThemeProfile): void {
  const { colors: c, fontSizes: fs } = theme;
  switch (zone.type) {
    case 'lead': {
      sink.push({ type: 'rect', ...clampRect(rect.x, rect.y, 0.28, rect.height), props: { fillColor: c.primary, borderColor: c.primary } });
      sink.push({
        type: 'text', ...clampRect(rect.x + 0.55, rect.y, rect.width - 0.8, rect.height),
        props: { text: zone.text, fontSize: fs.lead, textColor: c.text, fontFamily: theme.font.family, align: 'left' },
      });
      return;
    }
    case 'cards': {
      const columns = zone.cards.length;
      const gap = 0.5;
      const columnWidth = (rect.width - (columns - 1) * gap) / columns;
      zone.cards.forEach((card, columnIndex) => {
        const x = rect.x + columnIndex * (columnWidth + gap);
        sink.push({
          type: 'roundRect', ...clampRect(x, rect.y, columnWidth, 1.15),
          props: { fillColor: c.primary, borderColor: c.primaryDeep, text: card.head, textColor: '#FFFFFF', fontSize: fs.cardHead, bold: true, align: 'center', fontFamily: theme.font.family },
        });
        const itemCount = card.items.length;
        const itemHeight = (rect.height - 1.15 - 0.5 - (itemCount - 1) * 0.25) / itemCount;
        card.items.forEach((item, itemIndex) => {
          const itemY = rect.y + 1.15 + 0.25 + itemIndex * (itemHeight + 0.25);
          sink.push({
            type: 'roundRect', ...clampRect(x, itemY, columnWidth, itemHeight),
            props: { fillColor: c.cardBg, borderColor: c.line, text: '', fontFamily: theme.font.family },
          });
          sink.push({
            type: 'ellipse', ...clampRect(x + 0.22, itemY + 0.22, 0.62, 0.62),
            props: { fillColor: columnIndex % 2 === 0 ? c.primary : c.accent, borderColor: c.primary, text: String(itemIndex + 1), textColor: '#FFFFFF', fontSize: 12, bold: true, align: 'center' },
          });
          const leadText = 'lead' in item && item.lead ? `${item.lead}：` : '';
          sink.push({
            type: 'text', ...clampRect(x + 1.0, itemY + 0.14, columnWidth - 1.3, 0.75),
            props: { text: leadText, fontSize: fs.body, textColor: c.primaryDeep, bold: true, fontFamily: theme.font.family, align: 'left' },
          });
          const bodyText = 'text' in item ? item.text : '';
          sink.push({
            type: 'text', ...clampRect(x + 0.3, itemY + 0.95, columnWidth - 0.6, Math.max(0.9, itemHeight - 1.15)),
            props: { text: bodyText, fontSize: fs.body, textColor: c.text, fontFamily: theme.font.family, align: 'left' },
          });
        });
      });
      return;
    }
    case 'flow_chain': {
      const count = zone.items.length;
      const hasText = zone.items.some((item) => item.text);
      const chainHeight = 1.5;
      const itemWidth = (rect.width - (count - 1) * 0.55) / count;
      zone.items.forEach((item, index) => {
        const x = rect.x + index * (itemWidth + 0.55);
        const isLast = index === count - 1;
        sink.push({
          type: 'roundRect', ...clampRect(x, rect.y, itemWidth, chainHeight),
          props: { fillColor: isLast ? c.emphasis : c.primary, borderColor: c.primaryDeep, text: item.label, textColor: '#FFFFFF', fontSize: fs.band, bold: true, align: 'center', fontFamily: theme.font.family },
        });
        if (index < count - 1) {
          sink.push({
            type: 'arrow', ...clampRect(x + itemWidth + 0.06, rect.y + 0.35, 0.45, 0.8),
            props: { fillColor: c.accent, borderColor: c.accent },
          });
        }
        if (hasText && item.text) {
          sink.push({
            type: 'roundRect', ...clampRect(x, rect.y + 2.0, itemWidth, Math.max(1.6, rect.height - 2.0)),
            props: { fillColor: c.cardBg, borderColor: c.line, text: item.text, textColor: c.text, fontSize: fs.body, fontFamily: theme.font.family, align: 'left' },
          });
        }
      });
      return;
    }
    case 'timeline': {
      const phases = zone.phases.length;
      const phaseWidth = rect.width / phases;
      const axisY = rect.y + 0.9;
      sink.push({
        type: 'line', ...clampRect(rect.x + 0.3, axisY, rect.width - 0.6, 0.12),
        props: { fillColor: c.line, borderColor: c.line },
      });
      const nodeColors = [c.primary, c.accent, c.emphasis];
      zone.phases.forEach((phase, index) => {
        const x = rect.x + index * phaseWidth;
        sink.push({
          type: 'ellipse', ...clampRect(x + phaseWidth / 2 - 0.35, axisY - 0.55, 0.7, 0.7),
          props: { fillColor: nodeColors[index % 3], borderColor: c.primaryDeep, text: phase.month, textColor: '#FFFFFF', fontSize: fs.body, bold: true, align: 'center' },
        });
        sink.push({
          type: 'text', ...clampRect(x + 0.2, axisY + 0.45, phaseWidth - 0.4, 0.7),
          props: { text: phase.theme, fontSize: fs.cardHead, textColor: c.primaryDeep, bold: true, align: 'center', fontFamily: theme.font.family },
        });
        phase.tasks.forEach((task, taskIndex) => {
          sink.push({
            type: 'roundRect', ...clampRect(x + 0.3, axisY + 1.4 + taskIndex * 1.35, phaseWidth - 0.6, 1.15),
            props: { fillColor: c.cardBg, borderColor: c.line, text: task, textColor: c.text, fontSize: fs.body, align: 'left', fontFamily: theme.font.family },
          });
        });
      });
      return;
    }
    case 'badge_grid': {
      const cols = Math.min(zone.cols, zone.items.length);
      const rows = Math.ceil(zone.items.length / cols);
      const cellWidth = (rect.width - (cols - 1) * 0.4) / cols;
      const cellHeight = (rect.height - (rows - 1) * 0.35) / rows;
      zone.items.forEach((item, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = rect.x + col * (cellWidth + 0.4);
        const y = rect.y + row * (cellHeight + 0.35);
        sink.push({
          type: 'roundRect', ...clampRect(x, y, cellWidth, cellHeight),
          props: { fillColor: c.cardBg, borderColor: c.line, text: '', fontFamily: theme.font.family },
        });
        sink.push({
          type: 'ellipse', ...clampRect(x + 0.2, y + 0.2, 0.62, 0.62),
          props: { fillColor: c.accent, borderColor: c.primary, text: String(index + 1), textColor: '#FFFFFF', fontSize: 12, bold: true, align: 'center' },
        });
        sink.push({
          type: 'text', ...clampRect(x + 1.0, y + 0.18, cellWidth - 1.2, 0.75),
          props: { text: item.title, fontSize: fs.cardHead, textColor: c.primaryDeep, bold: true, fontFamily: theme.font.family, align: 'left' },
        });
        sink.push({
          type: 'text', ...clampRect(x + 0.3, y + 1.05, cellWidth - 0.6, Math.max(0.9, cellHeight - 1.25)),
          props: { text: item.text, fontSize: fs.body, textColor: c.text, fontFamily: theme.font.family, align: 'left' },
        });
      });
      return;
    }
    case 'chips': {
      sink.push({
        type: 'text', ...clampRect(rect.x, rect.y, rect.width, 0.7),
        props: { text: zone.label, fontSize: fs.cardHead, textColor: c.primaryDeep, bold: true, fontFamily: theme.font.family, align: 'left' },
      });
      const chipCount = zone.items.length;
      const chipWidth = Math.min(5.5, (rect.width - (chipCount - 1) * 0.35) / chipCount);
      zone.items.forEach((item, index) => {
        sink.push({
          type: 'roundRect', ...clampRect(rect.x + index * (chipWidth + 0.35), rect.y + 0.9, chipWidth, 1.0),
          props: { fillColor: c.tagBg, borderColor: c.primaryLight, text: item, textColor: c.primaryDeep, fontSize: fs.body, bold: true, align: 'center', fontFamily: theme.font.family },
        });
      });
      if (zone.text) {
        sink.push({
          type: 'text', ...clampRect(rect.x, rect.y + 2.2, rect.width, Math.max(0.9, rect.height - 2.4)),
          props: { text: zone.text, fontSize: fs.body, textColor: c.text, fontFamily: theme.font.family, align: 'left' },
        });
      }
      return;
    }
  }
}

// ─── 页面组装 ───────────────────────────────────────────────────

function renderPage(page: OutlinePage, pageOrdinal: number, theme: PptThemeProfile): LayoutElement[] {
  const sink = new ElementSink(`p${pageOrdinal}`);
  const { colors: c, fontSizes: fs } = theme;
  // 页标题（强调红/主色，模板页标题位）。
  sink.push({
    type: 'rect', ...clampRect(CONTENT.x - 0.4, 0.9, 1.2, 0.14), props: { fillColor: c.accent, borderColor: c.accent },
  });
  sink.push({
    type: 'text', ...clampRect(CONTENT.x - 0.4, 1.15, CONTENT.width + 0.6, 1.5),
    props: { text: page.title, fontSize: fs.pageTitle, textColor: c.primaryDeep, bold: true, fontFamily: theme.font.family, align: 'left' },
  });
  sink.push({
    type: 'line', ...clampRect(CONTENT.x - 0.4, 2.85, CONTENT.width + 0.6, 0.1),
    props: { fillColor: c.line, borderColor: c.line },
  });

  // 两遍布局：估高 → 剩余空间按比例分给可伸展 zone。
  const zoneHeights = page.zones.map((zone) => zoneHeight(zone, CONTENT.width, theme));
  const available = CONTENT.yBottom - CONTENT.yTop - (page.zones.length - 1) * ZONE_GAP;
  const intrinsic = zoneHeights.reduce((sum, height) => sum + height, 0);
  const stretchTotal = page.zones.reduce((sum, zone, index) => sum + (STRETCHY.has(zone.type) ? zoneHeights[index]! : 0), 0);
  const stretchExtra = Math.max(0, available - intrinsic);
  const finalHeights = zoneHeights.map((height, index) => {
    if (available >= intrinsic) {
      const zone = page.zones[index]!;
      return STRETCHY.has(zone.type) && stretchTotal > 0
        ? height + stretchExtra * (height / stretchTotal)
        : height;
    }
    // 内容超页：等比压缩（密度纪律由 prompt 约束；引擎兜底不越界）。
    return (height / intrinsic) * available;
  });

  let cursorY = CONTENT.yTop;
  page.zones.forEach((zone, index) => {
    const height = finalHeights[index]!;
    renderZone(zone, { x: CONTENT.x, y: cursorY, width: CONTENT.width, height }, sink, theme);
    cursorY += height + ZONE_GAP;
  });

  if (theme.brand.footerBar) {
    sink.push({
      type: 'rect', ...clampRect(0, ZONE_GRID.height - 0.55, ZONE_GRID.width, 0.55),
      props: { fillColor: c.primary, borderColor: c.primary },
    });
    if (theme.brand.footerText) {
      sink.push({
        type: 'text', ...clampRect(CONTENT.x, ZONE_GRID.height - 0.5, CONTENT.width, 0.45),
        props: { text: theme.brand.footerText, fontSize: 12, textColor: '#FFFFFF', align: 'right', fontFamily: theme.font.family },
      });
    }
  }
  return sink.elements;
}

// ─── 对外入口 ───────────────────────────────────────────────────

const OutlineInputSchema = z.object({ outline: OutlineDocumentSchema, themeId: z.string().max(64).optional() }).passthrough();

export interface ZoneRenderResult {
  ok: boolean;
  error?: string;
  document?: {
    title: string;
    pages: Array<{ title: string; pageType: string; elements: LayoutElement[] }>;
    themeId: string;
  };
  warnings: string[];
}

/** 大纲 JSON → 完整页面元素（封面/目录/章节页/封底自动生成）。 */
export function renderZoneOutline(raw: unknown): ZoneRenderResult {
  const parsedInput = OutlineInputSchema.safeParse(raw);
  if (!parsedInput.success) return { ok: false, error: 'outline_contract_violation', warnings: [] };
  const { outline, themeId } = parsedInput.data as { outline: OutlineDocument; themeId?: string };
  const theme = getPptThemeProfile(themeId);
  const warnings: string[] = [];
  const pages: NonNullable<ZoneRenderResult['document']>['pages'] = [];
  const outlineParsed: OutlineDocument = OutlineDocumentSchema.parse(outline);

  // 封面
  pages.push({
    title: outlineParsed.title, pageType: 'cover',
    elements: coverElements(outlineParsed, theme),
  });
  // 目录（≤5 章）
  pages.push({
    title: '目录', pageType: 'toc',
    elements: tocElements(outlineParsed, theme),
  });
  // 章节
  outlineParsed.chapters.forEach((chapter, chapterIndex) => {
    pages.push({
      title: `${chapterName(chapterIndex)}、${chapter.name}`, pageType: 'section',
      elements: sectionElements(chapterIndex, chapter.name, theme),
    });
    chapter.pages.forEach((page) => {
      pages.push({ title: page.title, pageType: 'content', elements: renderPage(page, pages.length + 1, theme) });
    });
  });
  // 封底
  pages.push({
    title: '致谢', pageType: 'closing',
    elements: closingElements(outlineParsed, theme),
  });

  // PptElement 契约要求整数网格：出口统一取整（引擎内部布局保持小数精度）。
  const roundedPages = pages.map((page) => ({
    ...page,
    elements: page.elements.map((element) => ({
      ...element,
      x: Math.round(element.x), y: Math.round(element.y),
      width: Math.round(element.width), height: Math.round(element.height),
    })),
  }));
  return { ok: true, document: { title: outlineParsed.title, pages: roundedPages, themeId: theme.id }, warnings };
}

function chapterName(index: number): string {
  return ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][index] ?? String(index + 1);
}

function coverElements(outline: OutlineDocument, theme: PptThemeProfile): LayoutElement[] {
  const sink = new ElementSink('cover');
  const { colors: c } = theme;
  sink.push({ type: 'rect', ...clampRect(0, 0, ZONE_GRID.width, ZONE_GRID.height), props: { fillColor: '#FFFFFF', borderColor: '#FFFFFF' } });
  sink.push({ type: 'rect', ...clampRect(0, 6.2, ZONE_GRID.width, 0.3), props: { fillColor: c.accent, borderColor: c.accent } });
  sink.push({ type: 'rect', ...clampRect(0, 0, ZONE_GRID.width, 1.1), props: { fillColor: c.primary, borderColor: c.primary } });
  sink.push({
    type: 'text', ...clampRect(2, 7.0, ZONE_GRID.width - 4, 2.6),
    props: { text: outline.title, fontSize: 30, textColor: c.primaryDeep, bold: true, align: 'center', fontFamily: theme.font.family },
  });
  if (outline.speaker) {
    sink.push({
      type: 'text', ...clampRect(2, 10.0, ZONE_GRID.width - 4, 1.2),
      props: { text: `汇报人：${outline.speaker}`, fontSize: 14, textColor: c.textMuted, align: 'center', fontFamily: theme.font.family },
    });
  }
  return sink.elements;
}

function tocElements(outline: OutlineDocument, theme: PptThemeProfile): LayoutElement[] {
  const sink = new ElementSink('toc');
  const { colors: c, fontSizes: fs } = theme;
  sink.push({
    type: 'text', ...clampRect(1.2, 0.9, 8, 1.6),
    props: { text: '目 录', fontSize: fs.pageTitle, textColor: c.primaryDeep, bold: true, fontFamily: theme.font.family, align: 'left' },
  });
  const chapters = outline.chapters.slice(0, 5);
  const rowHeight = Math.min(2.2, 13 / chapters.length);
  chapters.forEach((chapter, index) => {
    const y = 3.4 + index * rowHeight;
    sink.push({
      type: 'ellipse', ...clampRect(2.2, y, 1.1, 1.1),
      props: { fillColor: c.primary, borderColor: c.primaryDeep, text: chapterName(index), textColor: '#FFFFFF', fontSize: 14, bold: true, align: 'center' },
    });
    sink.push({
      type: 'text', ...clampRect(3.8, y + 0.05, ZONE_GRID.width - 6, 1.0),
      props: { text: chapter.name, fontSize: fs.band, textColor: c.text, bold: true, fontFamily: theme.font.family, align: 'left' },
    });
  });
  return sink.elements;
}

function sectionElements(index: number, name: string, theme: PptThemeProfile): LayoutElement[] {
  const sink = new ElementSink('sec');
  const { colors: c } = theme;
  sink.push({ type: 'rect', ...clampRect(0, 0, ZONE_GRID.width, ZONE_GRID.height), props: { fillColor: c.primaryDeep, borderColor: c.primaryDeep } });
  sink.push({
    type: 'text', ...clampRect(3, 6.4, 8, 2.6),
    props: { text: chapterName(index), fontSize: 54, textColor: c.accent, bold: true, align: 'center', fontFamily: theme.font.family },
  });
  sink.push({
    type: 'text', ...clampRect(11, 6.8, ZONE_GRID.width - 14, 2.2),
    props: { text: name, fontSize: 22, textColor: '#FFFFFF', bold: true, align: 'left', fontFamily: theme.font.family },
  });
  sink.push({ type: 'rect', ...clampRect(11, 9.3, 10, 0.18), props: { fillColor: c.accent, borderColor: c.accent } });
  return sink.elements;
}

function closingElements(outline: OutlineDocument, theme: PptThemeProfile): LayoutElement[] {
  const sink = new ElementSink('end');
  const { colors: c } = theme;
  sink.push({
    type: 'text', ...clampRect(2, 6.6, ZONE_GRID.width - 4, 2.4),
    props: { text: outline.closing.line1, fontSize: 28, textColor: c.primaryDeep, bold: true, align: 'center', fontFamily: theme.font.family },
  });
  if (outline.closing.line2) {
    sink.push({
      type: 'text', ...clampRect(2, 9.6, ZONE_GRID.width - 4, 1.2),
      props: { text: outline.closing.line2, fontSize: 14, textColor: c.textMuted, align: 'center', fontFamily: theme.font.family },
    });
  }
  return sink.elements;
}

// ─── 机器自检（check_deck 的 TS 对应物） ─────────────────────────

export interface ZonePageAudit {
  pageIndex: number;
  title: string;
  minFontSize: number;
  textChars: number;
  issues: string[];
}

export function auditZonePages(pages: Array<{ title: string; pageType: string; elements: Array<{ type: string; props: Record<string, unknown> }> }>): { pages: ZonePageAudit[]; passed: boolean } {
  const PLACEHOLDER = /输入|占位|placeholder|TODO|待填写|xxx标题/iu;
  const audits: ZonePageAudit[] = [];
  let passed = true;
  pages.forEach((page, pageIndex) => {
    const issues: string[] = [];
    let minFontSize = Number.POSITIVE_INFINITY;
    let textChars = 0;
    for (const element of page.elements) {
      const fontSize = typeof element.props.fontSize === 'number' ? element.props.fontSize : undefined;
      if (fontSize !== undefined) minFontSize = Math.min(minFontSize, fontSize);
      const text = typeof element.props.text === 'string' ? element.props.text : '';
      textChars += text.length;
      if (text && PLACEHOLDER.test(text)) issues.push(`存在占位符残留：「${text.slice(0, 16)}」`);
    }
    if (Number.isFinite(minFontSize) && minFontSize < 12) issues.push(`最小字号 ${minFontSize}pt 低于 12pt 下限`);
    if (page.pageType === 'content') {
      if (textChars < 120) issues.push(`正文密度不足（仅 ${textChars} 字）`);
      if (page.elements.length < 4) issues.push('元素过少，疑似空页');
    }
    if (issues.length > 0) passed = false;
    audits.push({ pageIndex, title: page.title, minFontSize: Number.isFinite(minFontSize) ? minFontSize : 0, textChars, issues });
  });
  return { pages: audits, passed };
}

// 供生成服务把渲染结果解析回严格 PptPage 之前复用类型
export const ZoneOutlinePageRef = OutlinePageSchema;
export const ZoneThemeRef = PptThemeProfileSchema;
