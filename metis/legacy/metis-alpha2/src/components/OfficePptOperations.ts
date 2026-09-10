import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract';

type PptPage = PptDocument['pages'][number];
type PptElementType = PptPage['elements'][number]['type'];

function allIds(document: PptDocument): Set<string> {
  return new Set(document.pages.flatMap((page) => [page.id, ...page.elements.map((element) => element.id)]));
}

function nextId(document: PptDocument, prefix: string, ids = allIds(document)): string {
  let index = ids.size + 1;
  let id = `${prefix}-${index}`;
  while (ids.has(id)) id = `${prefix}-${++index}`;
  ids.add(id);
  return id;
}

function markPage(page: PptPage, elements = page.elements): PptPage {
  return { ...page, elements, humanModified: true, status: 'draft' };
}

export function addPptElement(document: PptDocument, pageIndex: number, type: PptElementType): PptDocument {
  const page = document.pages[pageIndex];
  if (!page) return document;
  const ids = allIds(document);
  const id = nextId(document, type, ids);
  const isLine = type === 'line' || type === 'arrow';
  const width = document.ratio === '16:9' ? 10 : 8;
  const element = {
    id,
    type,
    x: 3,
    y: 3,
    width: isLine ? 8 : width,
    height: isLine ? 1 : 3,
    locked: false,
    props: { text: type === 'text' ? '输入文本' : type === 'chart' ? '图表占位' : type === 'image' ? '图片占位' : type, zIndex: page.elements.length + 1 },
  };
  return { ...document, pages: document.pages.map((candidate, index) => index === pageIndex ? markPage(candidate, [...candidate.elements, element]) : candidate) };
}

export function duplicatePptPage(document: PptDocument, pageIndex: number): PptDocument {
  const source = document.pages[pageIndex];
  if (!source) return document;
  const ids = allIds(document);
  const pageId = nextId(document, 'slide', ids);
  const width = document.ratio === '16:9' ? 32 : 24;
  const elements = source.elements.map((element) => ({
    ...element,
    id: nextId(document, element.type, ids),
    x: Math.min(width - element.width, element.x + 1),
    y: Math.min(18 - element.height, element.y + 1),
    props: { ...element.props },
  }));
  const copy: PptPage = {
    ...source,
    id: pageId,
    title: `${source.title} 副本`,
    elements,
    humanModified: true,
    status: 'draft',
  };
  const pages = [...document.pages];
  pages.splice(pageIndex + 1, 0, copy);
  return { ...document, pages };
}

export function deletePptPage(document: PptDocument, pageIndex: number): PptDocument {
  if (document.pages.length <= 1 || !document.pages[pageIndex]) return document;
  return { ...document, pages: document.pages.filter((_, index) => index !== pageIndex) };
}

export function updatePptElementProps(document: PptDocument, pageIndex: number, elementId: string, patch: Record<string, unknown>): PptDocument {
  const page = document.pages[pageIndex];
  const element = page?.elements.find((candidate) => candidate.id === elementId);
  if (!page || !element || element.locked || Object.keys(patch).length === 0) return document;
  const elements = page.elements.map((candidate) => candidate.id === elementId ? { ...candidate, props: { ...candidate.props, ...patch } } : candidate);
  return { ...document, pages: document.pages.map((candidate, index) => index === pageIndex ? markPage(candidate, elements) : candidate) };
}

export function setPptElementLayer(document: PptDocument, pageIndex: number, elementId: string, layer: 'front' | 'back' | 'forward' | 'backward'): PptDocument {
  const page = document.pages[pageIndex];
  const element = page?.elements.find((candidate) => candidate.id === elementId);
  if (!page || !element || element.locked) return document;
  const values = page.elements.map((candidate) => Number(candidate.props.zIndex ?? 1)).filter(Number.isFinite);
  const current = Number(element.props.zIndex ?? 1);
  const sorted = [...page.elements].sort((a, b) => Number(a.props.zIndex ?? 1) - Number(b.props.zIndex ?? 1));
  const order = sorted.findIndex((candidate) => candidate.id === elementId);
  const neighbour = layer === 'forward' ? sorted[order + 1] : layer === 'backward' ? sorted[order - 1] : undefined;
  const next = layer === 'front' ? Math.max(0, ...values) + 1 : layer === 'back' ? Math.min(...values, 1) - 1 : Number(neighbour?.props.zIndex ?? current);
  return updatePptElementProps(document, pageIndex, elementId, { zIndex: next });
}

export function pptDocumentStats(document: PptDocument): { slides: number; elements: number; text: number; images: number; charts: number } {
  const elements = document.pages.flatMap((page) => page.elements);
  return {
    slides: document.pages.length,
    elements: elements.length,
    text: elements.filter((element) => element.type === 'text').length,
    images: elements.filter((element) => element.type === 'image' || element.type === 'svg').length,
    charts: elements.filter((element) => element.type === 'chart').length,
  };
}
