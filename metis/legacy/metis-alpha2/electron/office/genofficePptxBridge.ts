/**
 * METIS PPT Grid <-> vendored GenOffice pptx-engine bridge.
 *
 * The METIS document remains the persistence and AI contract. GenOffice owns
 * the original PresentationML archive and its byte anchors. We project the
 * supported visual subset into PptDocument for the existing editor, while
 * preserving unsupported elements as original anchored bytes on export.
 */
import {
  openPptx,
  savePptx,
  type OpenedPptx,
  type Slide,
  type SlideElement,
  type TextElement,
  type PictureElement,
  type TableElement,
} from '../../vendor/genoffice/pptx-engine/src/index.js';
import type { PptDocument, PptElement, OutcomePptxWarning } from '../../engine/runtime/OutcomeRuntimeContract.js';

const ORIGINAL_ARCHIVE_KEY = '_genofficeOriginalArchiveMediaId';
const SLIDE_ANCHOR_KEY = '_genofficeSlidePath';
const ELEMENT_ANCHOR_KEY = '_genofficeSpIndex';
const ORIGINAL_ELEMENT_KEY = '_genofficeOriginalElementXml';

type AnyRecord = Record<string, unknown>;
type AnySlide = Slide & { elements: Array<SlideElement & AnyRecord> };

export interface GenofficePptxImportResult {
  document: PptDocument;
  opened: OpenedPptx;
  warnings: OutcomePptxWarning[];
}

function emuToGrid(value: number, max: number, total: number): number {
  return Math.max(0, Math.min(max, Math.round((value / total) * max)));
}

function rectToGrid(element: SlideElement, opened: OpenedPptx): Pick<PptElement, 'x' | 'y' | 'width' | 'height'> {
  const maxX = opened.deck.size.cx / opened.deck.size.cy >= 1.5 ? 32 : 24;
  const offset = element.transform.offset;
  return {
    x: emuToGrid(offset.x, maxX - 1, opened.deck.size.cx),
    y: emuToGrid(offset.y, 17, opened.deck.size.cy),
    width: Math.max(1, emuToGrid(offset.cx, maxX, opened.deck.size.cx)),
    height: Math.max(1, emuToGrid(offset.cy, 18, opened.deck.size.cy)),
  };
}

function textOf(element: TextElement): string {
  return (element.text?.paragraphs ?? [])
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
    .join('\n');
}

function elementType(element: SlideElement): PptElement['type'] {
  if (element.type === 'text') return 'text';
  if (element.type === 'shape') {
    const geometry = (element as TextElement).presetGeometry;
    if (geometry === 'roundRect' || geometry === 'ellipse' || geometry === 'triangle') return geometry;
    return textOf(element as TextElement) ? 'text' : 'rect';
  }
  if (element.type === 'picture') return 'image';
  if (element.type === 'table') return 'table';
  if (element.type === 'chart') return 'chart';
  if (element.type === 'group') return 'group';
  return 'group';
}

function colors(element: TextElement): AnyRecord {
  const props: AnyRecord = {};
  const fill = element.fill;
  if (fill?.type === 'solid') props.fillColor = fill.color;
  const stroke = element.stroke;
  if (stroke?.fill?.type === 'solid') props.borderColor = stroke.fill.color;
  if (stroke?.width) props.borderWidth = stroke.width / 12700;
  const firstRun = element.text?.paragraphs[0]?.runs[0];
  if (firstRun?.fontSize) props.fontSize = firstRun.fontSize;
  if (firstRun?.fontFamily) props.fontFamily = firstRun.fontFamily;
  if (firstRun?.color) props.textColor = firstRun.color;
  return props;
}

function projectElement(element: SlideElement, opened: OpenedPptx, warnings: OutcomePptxWarning[]): PptElement {
  const base = rectToGrid(element, opened);
  const props: AnyRecord = {
    ...((element.type === 'text' || element.type === 'shape') ? colors(element as TextElement) : {}),
    [ELEMENT_ANCHOR_KEY]: element.anchor.spIndex,
    [ORIGINAL_ELEMENT_KEY]: element.anchor.originalXml,
    _genofficeGridX: base.x,
    _genofficeGridY: base.y,
    _genofficeGridWidth: base.width,
    _genofficeGridHeight: base.height,
  };
  if (element.type === 'text' || element.type === 'shape') {
    props.text = textOf(element as TextElement);
  } else if (element.type === 'picture') {
    const picture = element as PictureElement;
    props.mediaRef = picture.mediaRef;
    props.mediaType = picture.mediaRef.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    props.rotationDeg = picture.transform.rot / 60_000;
    props.flipH = picture.transform.flipH;
    props.flipV = picture.transform.flipV;
    if (picture.srcRect) props.crop = { left: picture.srcRect.l, top: picture.srcRect.t, right: picture.srcRect.r, bottom: picture.srcRect.b };
  } else if (element.type === 'table') {
    props.rows = (element as TableElement).rows.length;
    props.cols = (element as TableElement).colWidths.length;
  } else if (element.type === 'chart') {
    warnings.push({ code: 'unsupported_chart', message: '图表以可保留的只读元素导入；其原始 XML 将在导出时保留。' });
  } else if (element.type === 'passthrough') {
    warnings.push({ code: 'unsupported_shape', message: '复杂 PPT 元素以原始锚定元素保留；当前 Grid 编辑器不修改其内部结构。' });
  }
  const type = element.type === 'passthrough' ? 'group' : elementType(element);
  return { id: `genoffice-ppt-${element.anchor.spIndex}`, type, ...base, locked: false, props };
}

function projectSlide(slide: AnySlide, opened: OpenedPptx, index: number, warnings: OutcomePptxWarning[]): PptDocument['pages'][number] {
  const titleElement = slide.elements.find((element) => (element.type === 'text' || element.type === 'shape') && textOf(element as TextElement).trim());
  const title = titleElement ? textOf(titleElement as TextElement).split('\n')[0]!.slice(0, 512) : `幻灯片 ${index + 1}`;
  let pictureOrder = 0;
  const elements = slide.elements.map((element) => {
    const projected = projectElement(element, opened, warnings);
    if (element.type === 'picture') {
      pictureOrder += 1;
      projected.props = { ...projected.props, importedImage: true, extractedImage: true, extractedImageOrder: pictureOrder };
    }
    return projected;
  });
  return {
    id: `genoffice-slide-${index + 1}`,
    title,
    pageType: index === 0 ? 'cover' : 'content',
    humanModified: false,
    status: 'complete',
    elements: elements as PptDocument['pages'][number]['elements'],
  };
}

export async function importPptxViaGenoffice(bytes: Buffer): Promise<GenofficePptxImportResult> {
  const opened = await openPptx(new Uint8Array(bytes));
  const warnings: OutcomePptxWarning[] = [];
  const pages = opened.deck.slides.map((slide, index) => {
    const page = projectSlide(slide as AnySlide, opened, index, warnings);
    page.elements = page.elements.map((element) => ({
      ...element,
      props: { ...element.props, [SLIDE_ANCHOR_KEY]: slide.path },
    }));
    return page;
  });
  const ratio = opened.deck.size.cx / opened.deck.size.cy >= 1.5 ? '16:9' : '4:3';
  return {
    opened,
    warnings,
    document: {
      type: 'ppt',
      ratio,
      theme: {},
      templateId: null,
      generationSkillId: null,
      pages,
    },
  } as GenofficePptxImportResult;
}

function elementAnchor(element: PptElement): number | undefined {
  const value = element.props[ELEMENT_ANCHOR_KEY];
  return typeof value === 'number' ? value : undefined;
}

function markTextElementDirty(slide: AnySlide, index: number, text: string): void {
  const element = slide.elements[index];
  if (!element || (element.type !== 'text' && element.type !== 'shape')) return;
  const textElement = element as TextElement;
  if (!textElement.text?.paragraphs.length) return;
  textElement.text.paragraphs[0]!.runs = [{ text }];
  element.dirty = true;
}

function gridToTransform(element: PptElement, opened: OpenedPptx): { x: number; y: number; cx: number; cy: number } {
  const maxX = opened.deck.size.cx / opened.deck.size.cy >= 1.5 ? 32 : 24;
  return {
    x: Math.round((element.x / maxX) * opened.deck.size.cx),
    y: Math.round((element.y / 18) * opened.deck.size.cy),
    cx: Math.round((element.width / maxX) * opened.deck.size.cx),
    cy: Math.round((element.height / 18) * opened.deck.size.cy),
  };
}

function markElementChanges(element: SlideElement, projected: PptElement, opened: OpenedPptx): void {
  const next = gridToTransform(projected, opened);
  const props = projected.props;
  const hasOriginalGrid = [props._genofficeGridX, props._genofficeGridY, props._genofficeGridWidth, props._genofficeGridHeight]
    .every((value) => typeof value === 'number');
  const geometryChanged = hasOriginalGrid
    ? projected.x !== props._genofficeGridX || projected.y !== props._genofficeGridY
      || projected.width !== props._genofficeGridWidth || projected.height !== props._genofficeGridHeight
    : (() => {
        const current = element.transform.offset;
        return current.x !== next.x || current.y !== next.y || current.cx !== next.cx || current.cy !== next.cy;
      })();
  if (geometryChanged) {
    element.transform.offset = next;
    element.dirtyTransform = true;
  }
  if (element.type !== 'text' && element.type !== 'shape') return;
  const textElement = element as TextElement;
  const currentFill = textElement.fill?.type === 'solid' ? textElement.fill.color : undefined;
  const nextFill = typeof props.fillColor === 'string' ? props.fillColor : undefined;
  if (currentFill !== nextFill) {
    textElement.fill = nextFill ? { type: 'solid', color: nextFill } : { type: 'none' };
    element.dirtyFill = true;
  }
  const currentStroke = textElement.stroke?.fill?.type === 'solid' ? textElement.stroke.fill.color : undefined;
  const nextStroke = typeof props.borderColor === 'string' ? props.borderColor : undefined;
  if (currentStroke !== nextStroke) {
    textElement.stroke = nextStroke ? { fill: { type: 'solid', color: nextStroke }, width: Number(props.borderWidth ?? 12700) } : undefined;
    element.dirtyStroke = true;
  }
}

export interface GenofficePptxExportResult {
  bytes: Uint8Array;
  warnings: OutcomePptxWarning[];
  bytePreserved: boolean;
  /** The METIS document requested structural changes this surgical path does not own. */
  requiresLegacy: boolean;
}

/**
 * P1/P2 bridge: untouched and text-edited slides use GenOffice's surgical
 * element patcher; unsupported/passthrough elements retain their original XML.
 * Structural page/element additions remain on the METIS legacy path until the
 * editor sends a dedicated GenOffice mutation plan.
 */
export async function exportPptxViaGenoffice(
  document: PptDocument,
  originalBytes: Buffer,
): Promise<GenofficePptxExportResult> {
  const opened = await openPptx(new Uint8Array(originalBytes));
  let bytePreserved = true;
  let requiresLegacy = false;
  for (let index = 0; index < opened.deck.slides.length; index += 1) {
    const slide = opened.deck.slides[index] as AnySlide;
    const page = document.pages[index];
    if (!page) {
      bytePreserved = false;
      requiresLegacy = true;
      continue;
    }
    const byAnchor = new Map<number, PptElement>();
    for (const element of page.elements) {
      const anchor = elementAnchor(element);
      if (anchor !== undefined) byAnchor.set(anchor, element);
      else { bytePreserved = false; requiresLegacy = true; }
    }
    for (let elementIndex = 0; elementIndex < slide.elements.length; elementIndex += 1) {
      const original = slide.elements[elementIndex]!;
      const projected = byAnchor.get(original.anchor.spIndex);
      if (!projected) {
        // No matching METIS element means deletion or an unsupported projected
        // element. Preserve protected/passthrough bytes; delete normal elements.
        if (original.type === 'passthrough' || original.type === 'picture' || original.type === 'table' || original.type === 'chart') continue;
        bytePreserved = false;
        requiresLegacy = true;
        continue;
      }
      if (original.type === 'text' || original.type === 'shape') {
        const nextText = typeof projected.props.text === 'string' ? projected.props.text : '';
        const oldText = textOf(original as TextElement);
        if (nextText !== oldText) {
          markTextElementDirty(slide, elementIndex, nextText);
          bytePreserved = false;
        }
        markElementChanges(original, projected, opened);
        if (original.dirtyTransform || original.dirtyFill || original.dirtyStroke) bytePreserved = false;
      } else if (original.type === 'picture') {
        const props = projected.props;
        // Managed media replacement is handled by METIS's existing full writer;
        // never silently save a stale original binary when the user selected a
        // different media id.
        if (typeof props.mediaId === 'string') {
          requiresLegacy = true;
          bytePreserved = false;
          continue;
        }
        const picture = original as PictureElement;
        const crop = props.crop as { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown } | undefined;
        if (crop) {
          const nextCrop = { l: Number(crop.left ?? 0), t: Number(crop.top ?? 0), r: Number(crop.right ?? 0), b: Number(crop.bottom ?? 0) };
          const oldCrop = picture.srcRect ?? { l: 0, t: 0, r: 0, b: 0 };
          if (JSON.stringify(nextCrop) !== JSON.stringify(oldCrop)) {
            picture.srcRect = nextCrop;
            picture.dirtySrcRect = true;
            bytePreserved = false;
          }
        }
        const nextRotation = Number(props.rotationDeg ?? 0) * 60_000;
        const nextFlipH = props.flipH === true;
        const nextFlipV = props.flipV === true;
        if (picture.transform.rot !== nextRotation || picture.transform.flipH !== nextFlipH || picture.transform.flipV !== nextFlipV) {
          picture.transform.rot = nextRotation;
          picture.transform.flipH = nextFlipH;
          picture.transform.flipV = nextFlipV;
          picture.dirtyTransform = true;
          bytePreserved = false;
        }
      }
    }
    // New METIS elements are intentionally left to the legacy writer in this
    // first engine path; retaining a complete original slide is safer than
    // silently dropping a requested structural addition.
    if (page.elements.some((element) => elementAnchor(element) === undefined)) {
      bytePreserved = false;
      requiresLegacy = true;
    }
  }
  if (document.pages.length !== opened.deck.slides.length) {
    bytePreserved = false;
    requiresLegacy = true;
  }
  const bytes = requiresLegacy ? originalBytes : await savePptx(opened);
  return { bytes, warnings: [], bytePreserved, requiresLegacy };
}

export const GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY = ORIGINAL_ARCHIVE_KEY;
