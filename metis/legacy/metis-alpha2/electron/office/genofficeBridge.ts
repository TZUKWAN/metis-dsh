/**
 * Bridge between the METIS WordDocument contract (v1 shape, see
 * engine/runtime/OutcomeRuntimeContract.ts) and the vendored GenOffice
 * docx-engine Block tree (vendor/genoffice/docx-engine).
 *
 * Design (docs/OFFICE_ENGINE_MIGRATION_PLAN.md):
 *  - Import:  parseDocx(bytes) → Block tree → projected WordDocument. Every
 *    projected block stores its GenOffice patch anchor (docxIndex) inside
 *    `style._genofficeAnchor` so exports can re-align against the original
 *    package without a schema change (v1 strictObject stays untouched; the
 *    `style`/`page` records are open-ended so old readers stay compatible).
 *  - Export:  when the stored document carries an original archive (imported
 *    file), the original bytes are re-parsed and aligned block-by-block:
 *    unchanged blocks are emitted as `{kind:'original'}` so the saved package
 *    keeps the original bytes for everything the editor did not touch
 *    (byte-preserving save); changed/new blocks are regenerated; deleted
 *    blocks are dropped. Documents without an original archive (AI-created or
 *    typed) fall back to the legacy full-generation codec in the service.
 *  - Header/footer/page edits: the import snapshot is kept in
 *    `page._genofficeSnapshot`; when the live values drift from it the service
 *    falls back to the legacy full-generation path for that export (correct,
 *    just not byte-preserving). Documented limitation for P1.
 *  - Passthrough blocks (sectPr wrappers, OLE previews, ...) are never
 *    projected; on export they are re-emitted as originals so the features
 *    they carry survive even though the v1 editor cannot show them.
 */
import { parseDocx, saveDocx, generateTableModelXml } from '../../vendor/genoffice/docx-engine/src/index.js';
import type { WordDocument, OutcomeWordDocxWarning } from '../../engine/runtime/OutcomeRuntimeContract.js';

type Style = Record<string, unknown>;
type GenBlock = {
  id: string;
  type: 'paragraph' | 'heading' | 'listItem' | 'table' | 'image' | 'passthrough';
  docxIndex: number | null;
  originalXml: string | null;
  hidden?: boolean;
  level?: number;
  list?: { kind: 'bullet' | 'ordered'; numId: string; ilvl: number };
  format?: Record<string, unknown>;
  runs?: Array<{ text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string }>;
  table?: { rows: Array<Array<{ paras: string[] }>>; colWidthsPct?: number[] };
  imageDataUrl?: string;
  imageWidthPx?: number;
  imageHeightPx?: number;
  previewText?: string;
  label?: string;
};
type ParsedLike = { blocks: GenBlock[] };
type SaveBlockLike =
  | { kind: 'original'; docxIndex: number }
  | { kind: 'generated'; block: Record<string, unknown>; docxIndex?: number }
  | { kind: 'xml'; xml: string; docxIndex?: number }
  | { kind: 'image'; image: { base64: string; mime: 'image/png' | 'image/jpeg' | 'image/gif'; widthPx: number; heightPx: number } };

const ANCHOR_KEY = '_genofficeAnchor';
export const GENOFFICE_ANCHOR_KEY = ANCHOR_KEY;
const SNAPSHOT_KEY = '_genofficeSnapshot';
export const GENOFFICE_IMAGE_REF_PREFIX = 'genoffice-image-';
const IMAGE_REF_PREFIX = GENOFFICE_IMAGE_REF_PREFIX;

export type GenofficeImportedImages = Array<{
  blockId: string;
  mediaType: 'image/png' | 'image/jpeg';
  displayName: string;
  bytes: Buffer;
}>;

export interface GenofficeImportResult {
  document: WordDocument;
  warnings: OutcomeWordDocxWarning[];
  images: GenofficeImportedImages;
  originalArchive: Buffer;
}

function runsText(runs: GenBlock['runs']): string {
  return (runs ?? []).map((run) => run.text ?? '').join('');
}

function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } | undefined {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(dataUrl.trim());
  if (!match) return undefined;
  return { mime: match[1]!, bytes: Buffer.from(match[2]!, 'base64') };
}

function formatToStyle(format: Record<string, unknown> | undefined, list: GenBlock['list']): Style {
  const style: Style = {};
  if (!format && !list) return style;
  const source = (format ?? {}) as Record<string, unknown>;
  if (typeof source.align === 'string') style.align = source.align;
  if (typeof source.indentLeft === 'number') style.indentLeft = source.indentLeft / 20;
  if (typeof source.indentRight === 'number') style.indentRight = source.indentRight / 20;
  if (typeof source.indentFirstLine === 'number') style.firstLineIndent = source.indentFirstLine / 20;
  if (typeof source.lineSpacing === 'number') style.lineSpacing = source.lineSpacing;
  if (typeof source.spaceBefore === 'number') style.spaceBefore = source.spaceBefore / 20;
  if (typeof source.spaceAfter === 'number') style.spaceAfter = source.spaceAfter / 20;
  if (list) {
    style.list = list.kind === 'bullet' ? 'bullet' : 'numbered';
    style.listLevel = list.ilvl;
  }
  return style;
}

function runFormatToStyle(runs: GenBlock['runs']): Style {
  const style: Style = {};
  const first = (runs ?? []).find((run) => run.bold !== undefined || run.italic !== undefined || run.underline !== undefined);
  if (!first) return style;
  if (first.bold !== undefined) style.bold = first.bold;
  if (first.italic !== undefined) style.italic = first.italic;
  if (first.underline !== undefined) style.underline = first.underline;
  return style;
}

/** Project one GenOffice block into the METIS block shape (without anchor). */
export function projectGenofficeBlock(block: GenBlock): WordDocument['blocks'][number] | undefined {
  const anchorStyle: Style = block.docxIndex !== null && block.docxIndex !== undefined ? { [ANCHOR_KEY]: block.docxIndex } : {};
  if (block.type === 'heading') {
    return {
      id: `genoffice-block-${block.docxIndex ?? block.id}`,
      kind: 'heading',
      level: Math.min(6, Math.max(1, block.level ?? 1)),
      text: runsText(block.runs),
      style: { ...formatToStyle(block.format, block.list), ...runFormatToStyle(block.runs), ...anchorStyle },
    };
  }
  if (block.type === 'paragraph' || block.type === 'listItem') {
    return {
      id: `genoffice-block-${block.docxIndex ?? block.id}`,
      kind: 'paragraph',
      text: runsText(block.runs),
      style: { ...formatToStyle(block.format, block.list), ...runFormatToStyle(block.runs), ...anchorStyle },
    };
  }
  if (block.type === 'table' && block.table) {
    return {
      id: `genoffice-block-${block.docxIndex ?? block.id}`,
      kind: 'table',
      rows: block.table.rows.map((row) => row.map((cell) => (cell.paras ?? []).join('\n'))),
      style: anchorStyle,
    };
  }
  if (block.type === 'image' && block.imageDataUrl) {
    const decoded = decodeDataUrl(block.imageDataUrl);
    const mediaType = decoded?.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return {
      id: `genoffice-block-${block.docxIndex ?? block.id}`,
      kind: 'image',
      imageRef: `${IMAGE_REF_PREFIX}${block.docxIndex ?? block.id}`,
      mediaType,
      displayName: block.label ?? block.previewText?.slice(0, 40) ?? `图片 ${block.docxIndex ?? ''}`,
      style: anchorStyle,
    };
  }
  return undefined;
}

function decodeImageSize(bytes: Buffer): { widthPx: number; heightPx: number } {
  // PNG IHDR
  if (bytes.length > 24 && bytes[0] === 137 && bytes[1] === 80) {
    return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) };
  }
  // JPEG SOF0/2 scan
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if ((marker >= 192 && marker <= 195) || marker === 201) {
        return { widthPx: bytes.readUInt16BE(offset + 7), heightPx: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { widthPx: 600, heightPx: 400 };
}

export async function importDocxViaGenoffice(archive: Buffer): Promise<GenofficeImportResult> {
  const parsed = (await parseDocx(new Uint8Array(archive))) as unknown as { blocks: GenBlock[] };
  const warnings: OutcomeWordDocxWarning[] = [];
  const blocks: WordDocument['blocks'] = [];
  const images: GenofficeImportedImages = [];
  for (const block of parsed.blocks) {
    if (block.hidden) continue;
    if (block.type === 'passthrough') continue;
    const projected = projectGenofficeBlock(block);
    if (!projected) continue;
    if (projected.kind === 'image' && block.imageDataUrl) {
      const decoded = decodeDataUrl(block.imageDataUrl);
      if (decoded && (decoded.mime === 'image/png' || decoded.mime === 'image/jpeg')) {
        images.push({
          blockId: projected.id,
          mediaType: decoded.mime,
          displayName: projected.displayName ?? `图片 ${images.length + 1}`,
          bytes: decoded.bytes,
        });
      } else {
        warnings.push({ code: 'unsupported_drawing', message: '一张图片的格式不受支持（仅 PNG/JPEG），已保留为占位。' });
      }
    }
    blocks.push(projected as WordDocument['blocks'][number]);
  }
  const document = {
    type: 'word',
    blocks,
    page: { [SNAPSHOT_KEY]: JSON.stringify({ header: '', footer: '', page: {} }) },
    header: '',
    footer: '',
  } as unknown as WordDocument;
  return { document, warnings, images, originalArchive: Buffer.from(archive) };
}

export type GenofficeImageByRef = { imageRef: string; bytes: Buffer; mediaType: 'image/png' | 'image/jpeg'; displayName: string };

/** Extract import images keyed by the WordDocument imageRef (genoffice-image-<anchor>). */
export async function extractGenofficeImagesByRef(archive: Buffer): Promise<Map<string, GenofficeImageByRef>> {
  const result = new Map<string, GenofficeImageByRef>();
  const parsed = (await parseDocx(new Uint8Array(archive))) as unknown as { blocks: GenBlock[] };
  for (const block of parsed.blocks) {
    if (block.hidden || block.type !== 'image' || !block.imageDataUrl) continue;
    const decoded = decodeDataUrl(block.imageDataUrl);
    if (!decoded || (decoded.mime !== 'image/png' && decoded.mime !== 'image/jpeg')) continue;
    const imageRef = `${IMAGE_REF_PREFIX}${block.docxIndex ?? block.id}`;
    result.set(imageRef, {
      imageRef,
      bytes: decoded.bytes,
      mediaType: decoded.mime,
      displayName: block.label ?? block.previewText?.slice(0, 40) ?? imageRef,
    });
  }
  return result;
}

/** The stored import snapshot (header/footer/page at import time), if any. */
export function readGenofficeSnapshot(document: WordDocument): string | undefined {
  const value = (document.page as Style)[SNAPSHOT_KEY];
  return typeof value === 'string' ? value : undefined;
}

export function readGenofficeAnchor(block: WordDocument['blocks'][number]): number | null {
  const value = (block.style as Style | undefined)?.[ANCHOR_KEY];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function styleKey(style: Style | undefined): string {
  const entries = Object.entries(style ?? {}).filter(([key]) => key !== ANCHOR_KEY).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function projectedSignature(block: WordDocument['blocks'][number]): string {
  return JSON.stringify([
    block.kind,
    block.kind === 'table' ? (block.rows ?? []).map((row) => row.map((cell) => cell ?? '')) : (block.text ?? ''),
    block.kind === 'heading' ? block.level ?? 1 : 0,
    styleKey(block.style),
  ]);
}

function metisToGenerated(block: WordDocument['blocks'][number]): Record<string, unknown> {
  const style = (block.style ?? {}) as Style;
  const text = block.kind === 'table' ? (block.rows ?? []).map((row) => row.map((cell) => cell ?? '').join('\t')).join('\n') : block.text ?? '';
  const base: Record<string, unknown> = { runs: [{ text }] };
  if (block.kind === 'heading') {
    return { type: 'heading', level: Math.min(9, Math.max(1, block.level ?? 1)), ...base };
  }
  const list = stringValueOf(style.list);
  if (list === 'bullet' || list === 'numbered') {
    return {
      type: 'listItem',
      list: { kind: list, numId: list === 'bullet' ? '1' : '2', ilvl: Number(style.listLevel ?? 0) || 0 },
      ...base,
    };
  }
  const format: Record<string, unknown> = {};
  if (typeof style.align === 'string') format.align = style.align;
  if (typeof style.indentLeft === 'number') format.indentLeft = Math.round(style.indentLeft * 20);
  if (typeof style.indentRight === 'number') format.indentRight = Math.round(style.indentRight * 20);
  if (typeof style.firstLineIndent === 'number') format.indentFirstLine = Math.round(style.firstLineIndent * 20);
  if (typeof style.lineSpacing === 'number') format.lineSpacing = style.lineSpacing;
  if (typeof style.spaceBefore === 'number') format.spaceBefore = Math.round(style.spaceBefore * 20);
  if (typeof style.spaceAfter === 'number') format.spaceAfter = Math.round(style.spaceAfter * 20);
  if (Object.keys(format).length) return { type: 'paragraph', format, ...base };
  return { type: 'paragraph', ...base };
}

function stringValueOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface GenofficeExportImageResolver {
  (mediaId: string): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'image/jpeg'; displayName?: string } | undefined>;
}

export interface GenofficeExportResult {
  bytes: Uint8Array;
  warnings: OutcomeWordDocxWarning[];
  /** true when every visible original block survived unchanged (pure round trip) */
  bytePreserved: boolean;
}

/**
 * Align the stored WordDocument against the original package and emit
 * GenOffice save blocks. Throws 'genoffice_no_original' when the document
 * carries no anchor (caller falls back to the legacy codec).
 */
export async function exportDocxViaGenoffice(
  document: WordDocument,
  originalArchive: Buffer,
  resolveImage?: GenofficeExportImageResolver,
): Promise<GenofficeExportResult> {
  const parsed = (await parseDocx(new Uint8Array(originalArchive))) as unknown as ParsedLike & { internal: unknown };
  const warnings: OutcomeWordDocxWarning[] = [];
  const visible = parsed.blocks.filter((block) => !block.hidden);
  const anchorToMetis = new Map<number, WordDocument['blocks'][number]>();
  const consumedMetis = new Set<WordDocument['blocks'][number]>();

  // Classify stored blocks: anchored ones map onto original package positions;
  // unanchored ones are new blocks whose insertion point is the preceding
  // anchored block in editor order (null = document start).
  const newBlocksByPrevAnchor = new Map<number | null, WordDocument['blocks'][number][]>();
  let lastAnchor: number | null = null;
  for (const block of document.blocks) {
    const anchor = readGenofficeAnchor(block);
    if (anchor === null) {
      const bucket = newBlocksByPrevAnchor.get(lastAnchor) ?? [];
      bucket.push(block);
      newBlocksByPrevAnchor.set(lastAnchor, bucket);
      continue;
    }
    if (!anchorToMetis.has(anchor)) anchorToMetis.set(anchor, block);
    lastAnchor = anchor;
  }

  const finalBlocks: SaveBlockLike[] = [];
  let bytePreserved = true;

  const flushNew = (prevAnchor: number | null) => {
    const bucket = newBlocksByPrevAnchor.get(prevAnchor);
    if (!bucket) return;
    for (const block of bucket) {
      finalBlocks.push({ kind: 'generated', block: metisToGenerated(block) });
    }
    bytePreserved = false;
    newBlocksByPrevAnchor.delete(prevAnchor);
  };

  // New blocks positioned before the very first original block.
  flushNew(null);

  for (const genBlock of visible) {
    const anchor = genBlock.docxIndex as number;
    const metisBlock = anchorToMetis.get(anchor);
    if (!metisBlock) {
      // Deleted by the user (no METIS counterpart) unless it is a passthrough
      // carrier (sectPr/OLE preview) — those always survive byte-for-byte.
      if (genBlock.type === 'passthrough') finalBlocks.push({ kind: 'original', docxIndex: anchor });
      else bytePreserved = false;
      continue;
    }
    consumedMetis.add(metisBlock);
    const projected = projectGenofficeBlock(genBlock);
    if (projected && projectedSignature(projected) === projectedSignature(normalizeStored(metisBlock))) {
      finalBlocks.push({ kind: 'original', docxIndex: anchor });
    } else {
      bytePreserved = false;
      await pushMetisAsSaveBlocks(metisBlock, finalBlocks, resolveImage, warnings);
    }
    flushNew(anchor);
  }
  // New blocks appended after the last original block.
  for (const [, bucket] of newBlocksByPrevAnchor) {
    for (const block of bucket) {
      finalBlocks.push({ kind: 'generated', block: metisToGenerated(block) });
    }
    bytePreserved = false;
  }
  newBlocksByPrevAnchor.clear();

  const saved = await saveDocx(parsed as never, finalBlocks as never, {});
  return { bytes: saved, warnings, bytePreserved };
}

async function pushMetisAsSaveBlocks(
  block: WordDocument['blocks'][number],
  finalBlocks: SaveBlockLike[],
  resolveImage: GenofficeExportImageResolver | undefined,
  warnings: OutcomeWordDocxWarning[],
): Promise<void> {
  if (block.kind === 'table') {
    const rows = (block.rows ?? [[]]).map((row) => row.map((cell) => ({ paras: (cell ?? '').split('\n') })));
    const model = { rows, colWidthsPct: [] as number[] };
    finalBlocks.push({ kind: 'xml', xml: generateTableModelXml(model as never) });
    return;
  }
  if (block.kind === 'image' && block.imageRef && resolveImage) {
    const resolved = await resolveImage(block.imageRef).catch(() => undefined);
    if (resolved) {
      const size = decodeImageSize(resolved.bytes);
      finalBlocks.push({
        kind: 'image',
        image: { base64: resolved.bytes.toString('base64'), mime: resolved.mediaType, widthPx: size.widthPx, heightPx: size.heightPx },
      });
      return;
    }
    warnings.push({ code: 'unsupported_drawing', message: '一张图片的媒体不可读取，已保留为可见占位。' });
  }
  finalBlocks.push({ kind: 'generated', block: metisToGenerated(block) });
}

function normalizeStored(block: WordDocument['blocks'][number]): WordDocument['blocks'][number] {
  if (block.kind === 'table') return block;
  const style = { ...(block.style ?? {}) } as Style;
  delete style[ANCHOR_KEY];
  return { ...block, style };
}
