/**
 * Zero-dependency PPTX codec for the Outcomes PPT Grid editor.
 *
 * It writes an ordinary PresentationML package with ZipWriter and reads the
 * portable PPT subset back into PptDocument. Master/layout/animation/chart and
 * binary-media fidelity are intentionally not claimed: unsupported constructs
 * are represented only where possible and reported as warnings.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipWriter } from '../engine/export/renderers/ZipWriter.js';
import { PptDocumentSchema, type OutcomePptxWarning, type PptDocument, type PptElement } from '../engine/runtime/OutcomeRuntimeContract.js';
import { isSafeSvgBuffer } from './OutcomeSvgSecurity.js';
import { exportPptxViaGenoffice, importPptxViaGenoffice, GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY } from './office/genofficePptxBridge.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EMU = 914_400;
const DIMENSIONS = {
  '16:9': { cx: 13.333333 * EMU, cy: 7.5 * EMU, grid: 32 },
  '4:3': { cx: 10 * EMU, cy: 7.5 * EMU, grid: 24 },
} as const;
type Ratio = keyof typeof DIMENSIONS;
type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number };
type RecordValue = Record<string, unknown>;
export type OutcomePptxManagedImageReference = { mediaId: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; displayName: string };
export type OutcomePptxManagedImage = OutcomePptxManagedImageReference & { bytes: Buffer };
export type OutcomePptxServiceOptions = {
  /** Explicit test/rollback selector. Production defaults to GenOffice. */
  engine?: 'genoffice' | 'legacy';
  resolveManagedImage?: (reference: OutcomePptxManagedImageReference) => Promise<OutcomePptxManagedImage | undefined>;
  resolveOriginalArchive?: (mediaId: string) => Promise<Buffer | undefined>;
};
type MediaPart = OutcomePptxManagedImage & { partName: string };
type SlideImageBinding = { elementIndex: number; relationshipId: string; media: MediaPart };
type ManagedImagePlan = { slides: SlideImageBinding[][]; media: MediaPart[] };

export type OutcomePptxExport = { bytes: Buffer; warnings: OutcomePptxWarning[] };
export type OutcomePptxImport = { document: PptDocument; warnings: OutcomePptxWarning[] };

function escapeXml(value: string): string { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;'); }
function decodeXml(value: string): string { return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&#x([0-9a-f]+);/giu, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16))).replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code))).replace(/&amp;/gu, '&'); }
function attributes(tag: string): Record<string, string> { const result: Record<string, string> = {}; for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) result[match[1]!] = decodeXml(match[2] ?? match[3] ?? ''); return result; }
function attribute(tag: string | undefined, name: string): string | undefined { return tag ? attributes(tag)[name] : undefined; }
function tagValue(xml: string, name: string): string | undefined { return xml.match(new RegExp(`<${name}\\b[^>]*>`, 'u'))?.[0]; }
function contents(xml: string, name: string): string | undefined { return xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'u'))?.[1]; }
function xmlText(xml: string): string { return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gu)].map((match) => decodeXml(match[1] ?? '')).join(''); }
function numberOr(value: string | undefined, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function stringProp(props: RecordValue, key: string): string { const value = props[key]; return typeof value === 'string' ? value : ''; }
function hexColor(value: unknown, fallback: string): string { const candidate = typeof value === 'string' ? value.replace(/^#/u, '').toUpperCase() : ''; return /^[0-9A-F]{6}$/u.test(candidate) ? candidate : fallback; }
function styleNumber(value: unknown, minimum: number): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : undefined; }
function styleFont(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function solidFillXml(value: unknown): string { const color = hexColor(value, ''); return color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : ''; }
function shapeStyleXml(element: PptElement, geometry: string, arrow = ''): string {
  const props = element.props as RecordValue; const fill = solidFillXml(props.fillColor); const borderColor = hexColor(props.borderColor, ''); const borderWidth = styleNumber(props.borderWidth, 0);
  const hasLine = Boolean(borderColor || borderWidth !== undefined || geometry === 'line'); if (!fill && !hasLine) return '';
  const width = borderWidth === undefined ? (geometry === 'line' ? 19_050 : 12_700) : Math.round(Math.min(1_000, borderWidth) * 12_700);
  return `${fill}${hasLine ? `<a:ln w="${width}">${solidFillXml(borderColor)}${arrow}</a:ln>` : ''}`;
}
function textRunProperties(props: RecordValue): string {
  const fontSize = styleNumber(props.fontSize, 1); const fontFamily = styleFont(props.fontFamily); const textColor = solidFillXml(props.textColor);
  const size = fontSize === undefined ? '' : ` sz="${Math.round(Math.min(1_000, fontSize) * 100)}"`;
  const font = fontFamily ? `<a:latin typeface="${escapeXml(fontFamily)}"/><a:ea typeface="${escapeXml(fontFamily)}"/><a:cs typeface="${escapeXml(fontFamily)}"/>` : '';
  return `<a:rPr lang="zh-CN" dirty="0"${size}>${textColor}${font}</a:rPr>`;
}
function themeFont(theme: RecordValue, key: 'titleFont' | 'bodyFont'): string | undefined {
  const direct = styleFont(theme[key]); if (direct) return direct;
  const scheme = theme.fontScheme; return scheme && typeof scheme === 'object' && !Array.isArray(scheme) ? styleFont((scheme as RecordValue)[key]) : undefined;
}
function warning(warnings: OutcomePptxWarning[], code: OutcomePptxWarning['code'], message: string): void { if (!warnings.some((item) => item.code === code)) warnings.push({ code, message }); }

type ImageCrop = { left: number; top: number; right: number; bottom: number };
type ImageMask = 'roundRect' | 'ellipse' | 'triangle';
type ImageTransform = { rotationDeg?: number; flipH?: boolean; flipV?: boolean; crop?: ImageCrop; opacity?: number; mask?: ImageMask };
const IMAGE_MASKS = new Set<ImageMask>(['roundRect', 'ellipse', 'triangle']);
function finitePropNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function normalizeRotation(value: unknown): number | undefined {
  const raw = finitePropNumber(value); if (raw === undefined) return undefined;
  const normalized = raw % 360; return normalized < 0 ? normalized + 360 : normalized;
}
function normalizeCrop(value: unknown): ImageCrop | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const crop = value as Record<string, unknown>;
  const left = finitePropNumber(crop.left); const top = finitePropNumber(crop.top); const right = finitePropNumber(crop.right); const bottom = finitePropNumber(crop.bottom);
  if ([left, top, right, bottom].some((part) => part === undefined) || left! < 0 || top! < 0 || right! < 0 || bottom! < 0 || left! > 1 || top! > 1 || right! > 1 || bottom! > 1 || left! + right! >= 1 || top! + bottom! >= 1) return undefined;
  return { left: left!, top: top!, right: right!, bottom: bottom! };
}
function normalizeOpacity(value: unknown): number | undefined {
  const opacity = finitePropNumber(value); return opacity !== undefined && opacity >= 0 && opacity <= 1 ? opacity : undefined;
}
function normalizeImageTransform(props: RecordValue, warnings?: OutcomePptxWarning[]): ImageTransform {
  const result: ImageTransform = {};
  if (Object.prototype.hasOwnProperty.call(props, 'rotationDeg')) {
    const rotation = normalizeRotation(props.rotationDeg); if (rotation === undefined) warning(warnings ?? [], 'unsupported_image', '图片旋转值无效，已按无旋转降级。'); else result.rotationDeg = rotation;
  }
  for (const key of ['flipH', 'flipV'] as const) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    if (typeof props[key] === 'boolean') result[key] = props[key] as boolean; else warning(warnings ?? [], 'unsupported_image', '图片翻转值无效，已按原始方向降级。');
  }
  if (Object.prototype.hasOwnProperty.call(props, 'crop')) {
    const crop = normalizeCrop(props.crop); if (crop) result.crop = crop; else warning(warnings ?? [], 'unsupported_image', '图片裁切范围无效，已按完整图片导出。');
  }
  if (Object.prototype.hasOwnProperty.call(props, 'opacity')) {
    const opacity = normalizeOpacity(props.opacity); if (opacity !== undefined) result.opacity = opacity; else warning(warnings ?? [], 'unsupported_image', '图片透明度无效，已按完全不透明导出。');
  }
  if (Object.prototype.hasOwnProperty.call(props, 'mask')) {
    const mask = props.mask; if (typeof mask === 'string' && IMAGE_MASKS.has(mask as ImageMask)) result.mask = mask as ImageMask; else if (mask !== undefined && mask !== 'rect') warning(warnings ?? [], 'unsupported_image', '图片蒙版类型不受支持，已按矩形图片导出。');
  }
  return result;
}
function mediaTypeFromPath(mediaPath: string): string | undefined {
  const lower = mediaPath.toLowerCase();
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return undefined;
}
function unsupportedMediaWarning(warnings: OutcomePptxWarning[], mediaType: string): void {
  warning(warnings, 'unsupported_media', `${mediaType} 图片当前不能安全写入 Outcomes 媒体库，已保留为可见占位。`);
}
function slideRelationshipTarget(entries: Map<string, Buffer>, slidePath: string, embed: string): string | undefined {
  const relsPath = slidePath.replace(/^ppt\/slides\//u, 'ppt/slides/_rels/').replace(/\.xml$/u, '.xml.rels');
  const rels = entries.get(relsPath)?.toString('utf8') ?? '';
  for (const relation of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/gu)) {
    const attrs = attributes(relation[0]);
    if (attrs.Id !== embed || !attrs.Target) continue;
    const target = attrs.Target.startsWith('/') ? `ppt${attrs.Target}` : normalizePackagePath(`ppt/slides/${attrs.Target}`);
    return target.replace(/^\//u, '');
  }
  return undefined;
}
function parseImageTransform(xml: string, warnings: OutcomePptxWarning[]): RecordValue {
  const result: RecordValue = {};
  const shapeProperties = contents(xml, 'p:spPr') ?? '';
  const transform = tagValue(shapeProperties, 'a:xfrm');
  if (transform) {
    const rotation = attribute(transform, 'rot');
    if (rotation !== undefined) { const raw = Number(rotation); if (Number.isFinite(raw)) result.rotationDeg = normalizeRotation(raw / 60_000); else warning(warnings, 'unsupported_image', '图片旋转值无效，已按无旋转导入。'); }
    for (const key of ['flipH', 'flipV'] as const) {
      const value = attribute(transform, key); if (value === undefined) continue;
      if (value === '1' || value.toLowerCase() === 'true') result[key] = true;
      else if (value === '0' || value.toLowerCase() === 'false') result[key] = false;
      else warning(warnings, 'unsupported_image', '图片翻转值无效，已按原始方向导入。');
    }
  }
  const blipFill = contents(xml, 'p:blipFill') ?? '';
  const cropTag = tagValue(blipFill, 'a:srcRect');
  if (cropTag) {
    const values = ['l', 't', 'r', 'b'].map((key) => Number(attribute(cropTag, key) ?? '0'));
    if (values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100_000) && values[0]! + values[2]! < 100_000 && values[1]! + values[3]! < 100_000) {
      if (values.some((value) => value !== 0)) result.crop = { left: values[0]! / 100_000, top: values[1]! / 100_000, right: values[2]! / 100_000, bottom: values[3]! / 100_000 };
    } else warning(warnings, 'unsupported_image', '图片裁切范围超出支持边界，已按完整图片导入。');
  }
  const alphaTag = tagValue(blipFill, 'a:alphaModFix');
  if (alphaTag) {
    const amount = Number(attribute(alphaTag, 'amt')); if (Number.isFinite(amount) && amount >= 0 && amount <= 100_000) result.opacity = amount / 100_000; else warning(warnings, 'unsupported_image', '图片透明度值无效，已按完全不透明导入。');
  }
  const geometry = tagValue(shapeProperties, 'a:prstGeom'); const mask = attribute(geometry, 'prst');
  if (mask && mask !== 'rect') { if (IMAGE_MASKS.has(mask as ImageMask)) result.mask = mask as ImageMask; else warning(warnings, 'unsupported_image', '图片蒙版类型不受支持，已按矩形图片导入。'); }
  return result;
}

export type ExtractedSlideImage = { elementOrder: number; mediaPath: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; displayName: string; bytes: Buffer };
/** Normalize an OPC package path that may contain `..`/`.` segments relative to a folder. */
function normalizePackagePath(raw: string): string {
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  return out.join('/');
}
/**
 * OUT reverse-image import: pull real picture binaries out of an imported PPTX.
 * Resolves each slide's `<p:pic><a:blip r:embed>` to its relationship target, reads
 * the media part bytes, and only accepts PNG/JPEG whose magic signature is verified.
 * Returns [] (no fabrication) when a binding is absent or the bytes are not a
 * supported image. This keeps binary-media fidelity honest instead of claiming it.
 */
export function extractSlideImages(entries: Map<string, Buffer>, slidePath: string, slideXml: string): ExtractedSlideImage[] {
  const relsPath = slidePath.replace(/^ppt\/slides\//u, 'ppt/slides/_rels/').replace(/\.xml$/u, '.xml.rels');
  const rels = entries.get(relsPath)?.toString('utf8') ?? '';
  const relTargets = new Map<string, string>();
  for (const relation of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/gu)) {
    const attrs = attributes(relation[0]);
    if (attrs.Id && attrs.Target) {
      const target = attrs.Target.startsWith('/') ? `ppt${attrs.Target}` : normalizePackagePath(`ppt/slides/${attrs.Target}`);
      relTargets.set(attrs.Id, target.replace(/^\//u, ''));
    }
  }
  const result: ExtractedSlideImage[] = [];
  let order = 0;
  for (const pic of slideXml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gu)) {
    order += 1;
    const blip = pic[0].match(/<a:blip\b[^>]*>/u)?.[0];
    const embed = attribute(blip, 'r:embed');
    if (!embed) continue;
    const mediaPath = relTargets.get(embed);
    const bytes = mediaPath ? entries.get(mediaPath) : undefined;
    if (!mediaPath || !bytes) continue;
    const lower = mediaPath.toLowerCase();
    const expectedType = lower.endsWith('.png') ? 'image/png' : (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg' : lower.endsWith('.svg') ? 'image/svg+xml' : undefined;
    if (!expectedType) continue;
    const png = expectedType === 'image/png' && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const jpeg = expectedType === 'image/jpeg' && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const svg = expectedType === 'image/svg+xml' && isSafeSvgBuffer(bytes);
    if (!(png || jpeg || svg)) continue;
    result.push({ elementOrder: order, mediaPath, mediaType: expectedType, displayName: mediaPath.split('/').pop() ?? mediaPath, bytes });
  }
  return result;
}

function readEntries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_558); index -= 1) if (archive.readUInt32LE(index) === EOCD) { eocd = index; break; }
  if (eocd < 0) throw new Error('pptx_zip_invalid');
  const count = archive.readUInt16LE(eocd + 10); let offset = archive.readUInt32LE(eocd + 16); const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL) throw new Error('pptx_central_directory_invalid');
    const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({ name: archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), method: archive.readUInt16LE(offset + 10), compressedSize: archive.readUInt32LE(offset + 20), localHeaderOffset: archive.readUInt32LE(offset + 42) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    const header = entry.localHeaderOffset;
    if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL) throw new Error('pptx_local_header_invalid');
    const dataStart = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28);
    const data = archive.subarray(dataStart, dataStart + entry.compressedSize);
    if (data.length !== entry.compressedSize) throw new Error('pptx_entry_truncated');
    if (entry.method === 0) result.set(entry.name, data);
    else if (entry.method === 8) result.set(entry.name, inflateRawSync(data));
    else throw new Error(`pptx_unsupported_method_${entry.method}`);
  }
  return result;
}
function elementEnd(xml: string, start: number, name: string): number {
  const matcher = new RegExp(`<${name}\\b[^>]*?(?:/>|>)|</${name}>`, 'gu'); matcher.lastIndex = start; let depth = 0;
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) { if (match[0]!.startsWith(`</${name}`)) { depth -= 1; if (depth === 0) return matcher.lastIndex; } else if (!/\/>$/u.test(match[0]!)) depth += 1; }
  return -1;
}
function directSlideElements(xml: string): Array<{ kind: 'sp' | 'cxnSp' | 'pic' | 'graphicFrame' | 'grpSp'; xml: string }> {
  const tree = contents(xml, 'p:spTree'); if (!tree) return []; const result: Array<{ kind: 'sp' | 'cxnSp' | 'pic' | 'graphicFrame' | 'grpSp'; xml: string }> = []; let cursor = 0;
  while (cursor < tree.length) {
    const next = tree.indexOf('<p:', cursor); if (next < 0) break; const kind = tree.slice(next).match(/^<p:(sp|cxnSp|pic|graphicFrame|grpSp)\b/u)?.[1] as 'sp' | 'cxnSp' | 'pic' | 'graphicFrame' | 'grpSp' | undefined;
    if (!kind) { const end = tree.indexOf('>', next); cursor = end < 0 ? tree.length : end + 1; continue; }
    const end = elementEnd(tree, next, `p:${kind}`); if (end < 0) break; result.push({ kind, xml: tree.slice(next, end) }); cursor = end;
  }
  return result;
}
function dimensions(ratio: Ratio) { return DIMENSIONS[ratio]; }
function gridPosition(xml: string, ratio: Ratio, warnings: OutcomePptxWarning[]): { x: number; y: number; width: number; height: number } {
  const transform = contents(xml, 'a:xfrm') ?? xml; const off = tagValue(transform, 'a:off'); const ext = tagValue(transform, 'a:ext'); const size = dimensions(ratio);
  const rawX = Math.round(numberOr(attribute(off, 'x'), 0) / size.cx * size.grid); const rawY = Math.round(numberOr(attribute(off, 'y'), 0) / size.cy * 18);
  const rawWidth = Math.max(1, Math.round(numberOr(attribute(ext, 'cx'), size.cx / 3) / size.cx * size.grid)); const rawHeight = Math.max(1, Math.round(numberOr(attribute(ext, 'cy'), size.cy / 8) / size.cy * 18));
  const x = Math.max(0, Math.min(size.grid - 1, rawX)); const y = Math.max(0, Math.min(17, rawY)); const width = Math.max(1, Math.min(size.grid - x, rawWidth)); const height = Math.max(1, Math.min(18 - y, rawHeight));
  if (x !== rawX || y !== rawY || width !== rawWidth || height !== rawHeight) warning(warnings, 'unsupported_shape', '部分形状超出 PPT Grid 范围，导入时已裁剪为可编辑边界。');
  return { x, y, width, height };
}
function shapeType(xml: string, kind: 'sp' | 'cxnSp'): PptElement['type'] {
  if (kind === 'cxnSp') return /<a:(?:headEnd|tailEnd)\b/iu.test(xml) ? 'arrow' : 'line';
  const name = attribute(tagValue(xml, 'p:cNvPr'), 'name') ?? ''; const encoded = name.match(/^METIS:([A-Za-z]+):/u)?.[1];
  if (encoded && ['text', 'rect', 'roundRect', 'ellipse', 'triangle', 'line', 'arrow'].includes(encoded)) return encoded as PptElement['type'];
  const geometry = attribute(tagValue(xml, 'a:prstGeom'), 'prst');
  if (geometry === 'roundRect' || geometry === 'ellipse' || geometry === 'triangle') return geometry;
  if (geometry === 'line') return 'line';
  return xmlText(xml) ? 'text' : 'rect';
}
function themeSlotColor(theme: string, slot: string): string | undefined {
  const value = contents(theme, slot) ?? ''; const srgb = attribute(tagValue(value, 'a:srgbClr'), 'val');
  if (srgb && /^[0-9A-F]{6}$/iu.test(srgb)) return `#${srgb.toUpperCase()}`;
  const system = attribute(tagValue(value, 'a:sysClr'), 'lastClr');
  return system && /^[0-9A-F]{6}$/iu.test(system) ? `#${system.toUpperCase()}` : undefined;
}
function parseTheme(entries: Map<string, Buffer>, warnings: OutcomePptxWarning[]): RecordValue {
  const theme = entries.get('ppt/theme/theme1.xml')?.toString('utf8'); if (!theme) return {};
  const primary = themeSlotColor(theme, 'a:accent1'); const accent = themeSlotColor(theme, 'a:accent2');
  const surface = themeSlotColor(theme, 'a:lt1') ?? themeSlotColor(theme, 'a:lt2'); const text = themeSlotColor(theme, 'a:dk1') ?? themeSlotColor(theme, 'a:dk2');
  const fontScheme = contents(theme, 'a:fontScheme') ?? ''; const majorFont = contents(fontScheme, 'a:majorFont') ?? ''; const minorFont = contents(fontScheme, 'a:minorFont') ?? '';
  const titleFont = attribute(tagValue(majorFont, 'a:latin') ?? tagValue(majorFont, 'a:ea'), 'typeface'); const bodyFont = attribute(tagValue(minorFont, 'a:latin') ?? tagValue(minorFont, 'a:ea'), 'typeface');
  if (!primary && !accent && !surface && !text) warning(warnings, 'unsupported_theme', 'PPT 主题使用了当前模型不能完整映射的颜色定义。');
  return {
    ...(primary ? { primary } : {}), ...(accent ? { accent } : {}), ...(surface ? { surface } : {}), ...(text ? { text } : {}),
    ...(titleFont ? { titleFont } : {}), ...(bodyFont ? { bodyFont } : {}),
  };
}
function themeColorValue(theme: RecordValue, scheme: string): string | undefined {
  const key = scheme === 'accent1' ? 'primary' : scheme === 'accent2' ? 'accent' : scheme === 'lt1' || scheme === 'lt2' ? 'surface' : scheme === 'dk1' || scheme === 'dk2' ? 'text' : undefined;
  const value = key ? theme[key] : undefined; return typeof value === 'string' && /^#[0-9A-F]{6}$/iu.test(value) ? value.toUpperCase() : undefined;
}
function colorValueFromXml(xml: string, theme: RecordValue): string | undefined {
  const srgb = attribute(tagValue(xml, 'a:srgbClr'), 'val'); if (srgb && /^[0-9A-F]{6}$/iu.test(srgb)) return `#${srgb.toUpperCase()}`;
  const system = attribute(tagValue(xml, 'a:sysClr'), 'lastClr'); if (system && /^[0-9A-F]{6}$/iu.test(system)) return `#${system.toUpperCase()}`;
  const scheme = attribute(tagValue(xml, 'a:schemeClr'), 'val'); return scheme ? themeColorValue(theme, scheme) : undefined;
}
function parseShapeStyles(xml: string, theme: RecordValue): RecordValue {
  const props: RecordValue = {}; const shapeProperties = contents(xml, 'p:spPr') ?? '';
  const fill = contents(shapeProperties, 'a:solidFill') ?? ''; const fillColor = colorValueFromXml(fill, theme); if (fillColor) props.fillColor = fillColor;
  const lineTag = tagValue(shapeProperties, 'a:ln'); const line = contents(shapeProperties, 'a:ln') ?? '';
  if (lineTag) {
    const width = Number(attribute(lineTag, 'w')); if (Number.isFinite(width) && width >= 0) props.borderWidth = Number((width / 12_700).toFixed(4));
    const borderColor = colorValueFromXml(line, theme); if (borderColor) props.borderColor = borderColor;
  }
  const textBody = contents(xml, 'p:txBody') ?? '';
  // A non-self-closing rPr carries children (solidFill, latin/ea/cs fonts...);
  // a lazy alternation would truncate at the first self-closed child such as
  // <a:srgbClr/>, silently dropping every font tag after it. Match the
  // self-closed form first, then the full open/close block.
  const run = textBody.match(/<a:(?:rPr|defRPr)\b[^>]*\/>|<a:(?:rPr|defRPr)\b[^>]*>[\s\S]*?<\/a:(?:rPr|defRPr)>/u)?.[0] ?? '';
  const runTag = tagValue(run, 'a:rPr') ?? tagValue(run, 'a:defRPr'); const fontSize = Number(attribute(runTag, 'sz')); if (Number.isFinite(fontSize) && fontSize > 0) props.fontSize = Number((fontSize / 100).toFixed(4));
  const fontTag = tagValue(run, 'a:latin') ?? tagValue(run, 'a:ea') ?? tagValue(run, 'a:cs'); const fontFamily = attribute(fontTag, 'typeface'); if (fontFamily) props.fontFamily = fontFamily;
  const textColor = colorValueFromXml(run, theme); if (textColor) props.textColor = textColor;
  return props;
}
function slidePaths(entries: Map<string, Buffer>, presentation: string): string[] {
  const rels = entries.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? ''; const targets = new Map<string, string>();
  for (const relation of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/gu)) { const attrs = attributes(relation[0]); if (attrs.Id && attrs.Target?.startsWith('slides/')) targets.set(attrs.Id, `ppt/${attrs.Target.replace(/^\//u, '')}`); }
  const ordered = [...presentation.matchAll(/<p:sldId\b[^>]*>/gu)].map((slide) => targets.get(attribute(slide[0], 'r:id') ?? '')).filter((value): value is string => Boolean(value));
  return ordered.length ? ordered : [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function parsePpt(entries: Map<string, Buffer>): OutcomePptxImport {
  const presentation = entries.get('ppt/presentation.xml')?.toString('utf8'); if (!presentation) throw new Error('pptx_presentation_missing'); const warnings: OutcomePptxWarning[] = [];
  const theme = parseTheme(entries, warnings);
  const size = tagValue(presentation, 'p:sldSz'); const type = attribute(size, 'type'); const ratio: Ratio = type === 'screen4x3' || (numberOr(attribute(size, 'cx'), 16) / numberOr(attribute(size, 'cy'), 9) < 1.5) ? '4:3' : '16:9';
  const paths = slidePaths(entries, presentation); if (!paths.length) throw new Error('pptx_slides_missing');
  const pages = paths.flatMap((path, pageIndex) => {
    const slide = entries.get(path)?.toString('utf8'); if (!slide) return [];
    if (/<p:(?:timing|transition)\b/iu.test(slide)) warning(warnings, 'unsupported_animation', '动画和切换效果未映射到 PPT Grid。');
    if (/<c:chart\b|<p:graphicFrame\b[\s\S]*?<c:chart\b/iu.test(slide)) warning(warnings, 'unsupported_chart', '图表未保留为可编辑图表；请在 PPT Studio 中重新创建。');
    const elements: PptElement[] = []; let title = `幻灯片 ${pageIndex + 1}`;
    const slideImages = extractSlideImages(entries, path, slide); let picOrder = 0;
    for (const item of directSlideElements(slide)) {
      if (item.kind === 'grpSp') { warning(warnings, 'unsupported_shape', '组合形状未映射为独立可编辑元素。'); continue; }
      if (item.kind === 'graphicFrame') { warning(warnings, 'unsupported_shape', '表格或复杂图形框未完整映射。'); continue; }
      if (item.kind === 'pic') {
        picOrder += 1;
        const position = gridPosition(item.xml, ratio, warnings);
        const embed = attribute(item.xml.match(/<a:blip\b[^>]*>/u)?.[0], 'r:embed');
        const mediaPath = embed ? slideRelationshipTarget(entries, path, embed) : undefined;
        const unsupportedType = mediaPath ? mediaTypeFromPath(mediaPath) : undefined;
        const image = slideImages.find((candidate) => candidate.elementOrder === picOrder);
        if (unsupportedType && !image) unsupportedMediaWarning(warnings, unsupportedType);
        if (image) {
          // Real extracted binary media is surfaced on the element (mediaType/name +
          // extracted flag); writing it into the project-private OutcomeMedia store
          // and persisting an import-owned version remains a separate integration.
          elements.push({ id: `ppt-${pageIndex + 1}-image-${elements.length + 1}`, type: 'image', ...position, locked: false, props: { text: '图片占位', importedImage: true, extractedImage: true, extractedImageOrder: image.elementOrder, mediaType: image.mediaType, mediaName: image.displayName, ...parseShapeStyles(item.xml, theme), ...parseImageTransform(item.xml, warnings) } });
        } else {
          if (!unsupportedType) warning(warnings, 'unsupported_image', '图片二进制未导入；已保留可编辑图片占位。');
          elements.push({ id: `ppt-${pageIndex + 1}-image-${elements.length + 1}`, type: 'image', ...position, locked: false, props: { text: '图片占位', importedImage: true, ...parseShapeStyles(item.xml, theme), ...parseImageTransform(item.xml, warnings) } });
        }
        continue;
      }
      const text = xmlText(item.xml); const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/iu.test(item.xml); if (isTitle) { if (text) title = text; continue; }
      const position = gridPosition(item.xml, ratio, warnings); elements.push({ id: `ppt-${pageIndex + 1}-element-${elements.length + 1}`, type: shapeType(item.xml, item.kind), ...position, locked: false, props: { ...parseShapeStyles(item.xml, theme), ...(text ? { text } : {}) } });
    }
    return [{ id: `slide-${pageIndex + 1}`, title, pageType: pageIndex === 0 ? 'cover' : 'content', humanModified: false, status: 'complete' as const, elements }];
  });
  if (entries.has('ppt/notesSlides/notesSlide1.xml') || [...entries.keys()].some((name) => name.startsWith('ppt/notesSlides/'))) warning(warnings, 'unsupported_notes', '演讲者备注未导入 PPT Grid。');
  const masters = [...entries.keys()].filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/u.test(name)); if (masters.some((name) => /<p:sp\b/iu.test(entries.get(name)?.toString('utf8') ?? ''))) warning(warnings, 'unsupported_master', '母版中的形状和占位符未映射到 PPT Grid。');
  const document = PptDocumentSchema.parse({ type: 'ppt', ratio, theme, templateId: null, generationSkillId: null, pages });
  return { document, warnings };
}
function groupTree(): string { return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'; }
function textBody(text: string, props: RecordValue = {}, fontFallback?: string): string {
  const textProps = { ...props, ...(styleFont(props.fontFamily) ? {} : (fontFallback ? { fontFamily: fontFallback } : {})) };
  return `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${textRunProperties(textProps)}<a:t>${escapeXml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>`;
}
function shapeXml(type: PptElement['type'], element: PptElement, numericId: number, ratio: Ratio, title = false, document?: PptDocument): string {
  const size = dimensions(ratio); const x = Math.round(element.x / size.grid * size.cx); const y = Math.round(element.y / 18 * size.cy); const width = Math.round(element.width / size.grid * size.cx); const height = Math.round(element.height / 18 * size.cy);
  const geometry = type === 'roundRect' ? 'roundRect' : type === 'ellipse' ? 'ellipse' : type === 'triangle' ? 'triangle' : type === 'line' || type === 'arrow' ? 'line' : 'rect'; const props = element.props as RecordValue; const text = stringProp(props, 'text');
  const arrow = type === 'arrow' ? '<a:headEnd type="triangle"/><a:tailEnd type="triangle"/>' : ''; const theme = document?.theme ?? {}; const fallbackFont = themeFont(theme, title ? 'titleFont' : 'bodyFont');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${numericId}" name="METIS:${type}:${escapeXml(element.id)}"/><p:cNvSpPr${type === 'text' ? ' txBox="1"' : ''}/><p:nvPr>${title ? '<p:ph type="title"/>' : ''}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${shapeStyleXml(element, geometry, arrow)}</p:spPr>${text ? textBody(text, props, fallbackFont) : ''}</p:sp>`;
}
function placeholderElement(element: PptElement): PptElement { return { ...element, type: 'rect', props: { ...element.props, text: stringProp(element.props as RecordValue, 'text') || `[${element.type} 占位]` } }; }
function imageXml(element: PptElement, numericId: number, ratio: Ratio, relationshipId: string, displayName: string, warnings: OutcomePptxWarning[]): string {
  const size = dimensions(ratio); const x = Math.round(element.x / size.grid * size.cx); const y = Math.round(element.y / 18 * size.cy); const width = Math.round(element.width / size.grid * size.cx); const height = Math.round(element.height / 18 * size.cy);
  const transform = normalizeImageTransform(element.props as RecordValue, warnings);
  const rotation = transform.rotationDeg === undefined ? '' : ` rot="${Math.round(transform.rotationDeg * 60_000)}"`;
  const flipH = Object.prototype.hasOwnProperty.call(transform, 'flipH') ? ` flipH="${transform.flipH ? '1' : '0'}"` : '';
  const flipV = Object.prototype.hasOwnProperty.call(transform, 'flipV') ? ` flipV="${transform.flipV ? '1' : '0'}"` : '';
  const crop = transform.crop;
  const srcRect = crop ? `<a:srcRect l="${Math.round(crop.left * 100_000)}" t="${Math.round(crop.top * 100_000)}" r="${Math.round(crop.right * 100_000)}" b="${Math.round(crop.bottom * 100_000)}"/>` : '';
  const opacity = transform.opacity === undefined ? '' : `<a:alphaModFix amt="${Math.round(transform.opacity * 100_000)}"/>`;
  const geometry = transform.mask ?? 'rect';
  const blip = opacity ? `<a:blip r:embed="${relationshipId}">${opacity}</a:blip>` : `<a:blip r:embed="${relationshipId}"/>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${numericId}" name="METIS:image:${escapeXml(element.id)}" descr="${escapeXml(displayName)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch>${srcRect}</p:blipFill><p:spPr><a:xfrm${rotation}${flipH}${flipV}><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${shapeStyleXml(element, geometry)}</p:spPr></p:pic>`;
}
function slideXml(page: PptDocument['pages'][number], document: PptDocument, warnings: OutcomePptxWarning[], imageBindings: readonly SlideImageBinding[]): string {
  let id = 3; const title: PptElement = { id: `title-${page.id}`, type: 'text', x: 2, y: 1, width: document.ratio === '4:3' ? 20 : 28, height: 2, locked: false, props: { text: page.title } };
  const bindingByElement = new Map(imageBindings.map((binding) => [binding.elementIndex, binding]));
  const elements = page.elements.map((element, elementIndex) => {
    const image = bindingByElement.get(elementIndex);
    if (image) return imageXml(element, id++, document.ratio, image.relationshipId, image.media.displayName, warnings);
    if (element.type === 'image') {
      const mediaType = stringProp(element.props as RecordValue, 'mediaType');
      if (mediaType === 'image/gif' || mediaType === 'image/webp' || mediaType === 'image/svg+xml') unsupportedMediaWarning(warnings, mediaType);
      else warning(warnings, 'unsupported_image', 'PPT Grid 图片导出为可见占位形状；该元素没有可验证的已持久化图片二进制。');
    } else if (element.type === 'chart') warning(warnings, 'unsupported_chart', 'PPT Grid 图表导出为可见占位形状；原始图表结构尚未嵌入 PPTX。');
    else if (['svg', 'table', 'group'].includes(element.type)) warning(warnings, 'unsupported_shape', `PPT Grid ${element.type} 元素导出为可见占位形状。`);
    return shapeXml(['image', 'chart', 'svg', 'table', 'group'].includes(element.type) ? 'rect' : element.type, ['image', 'chart', 'svg', 'table', 'group'].includes(element.type) ? placeholderElement(element) : element, id++, document.ratio, false, document);
  });
  const surface = hexColor(document.theme.surface, 'FFFFFF');
  const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${surface}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${background}<p:spTree>${groupTree()}${shapeXml('text', title, 2, document.ratio, true, document)}${elements.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function themeXml(document: PptDocument): string {
  const primary = hexColor(document.theme.primary, '4472C4'); const accent = hexColor(document.theme.accent, 'ED7D31');
  const surface = hexColor(document.theme.surface, 'FFFFFF'); const text = hexColor(document.theme.text, '183B59');
  const titleFont = themeFont(document.theme, 'titleFont') ?? 'Aptos Display'; const bodyFont = themeFont(document.theme, 'bodyFont') ?? 'Aptos';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="METIS"><a:themeElements><a:clrScheme name="METIS"><a:dk1><a:srgbClr val="${text}"/></a:dk1><a:lt1><a:srgbClr val="${surface}"/></a:lt1><a:dk2><a:srgbClr val="${text}"/></a:dk2><a:lt2><a:srgbClr val="${surface}"/></a:lt2><a:accent1><a:srgbClr val="${primary}"/></a:accent1><a:accent2><a:srgbClr val="${accent}"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="METIS"><a:majorFont><a:latin typeface="${escapeXml(titleFont)}"/><a:ea typeface="${escapeXml(titleFont)}"/><a:cs typeface="${escapeXml(titleFont)}"/></a:majorFont><a:minorFont><a:latin typeface="${escapeXml(bodyFont)}"/><a:ea typeface="${escapeXml(bodyFont)}"/><a:cs typeface="${escapeXml(bodyFont)}"/></a:minorFont></a:fontScheme><a:fmtScheme name="METIS"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:shade val="90000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:noFill/></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}
function packageParts(document: PptDocument, warnings: OutcomePptxWarning[], imagePlan: ManagedImagePlan = { slides: document.pages.map(() => []), media: [] }): Map<string, Buffer> {
  const size = dimensions(document.ratio); const entries = new Map<string, Buffer>(); const slideOverrides = document.pages.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const mediaDefaults = [...new Set(imagePlan.media.map((media) => media.mediaType))].map((mediaType) => `<Default Extension="${mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'svg'}" ContentType="${mediaType}"/>`).join('');
  entries.set('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`, 'utf8'));
  entries.set('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>', 'utf8'));
  const slideIds = document.pages.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('');
  entries.set('ppt/presentation.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${Math.round(size.cx)}" cy="${Math.round(size.cy)}" type="${document.ratio === '4:3' ? 'screen4x3' : 'screen16x9'}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`, 'utf8'));
  entries.set('ppt/_rels/presentation.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${document.pages.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`, 'utf8'));
  entries.set('ppt/slideMasters/slideMaster1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="METIS"><p:spTree>${groupTree()}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`, 'utf8'));
  entries.set('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>', 'utf8'));
  entries.set('ppt/slideLayouts/slideLayout1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${groupTree()}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`, 'utf8'));
  entries.set('ppt/slideLayouts/_rels/slideLayout1.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>', 'utf8'));
  entries.set('ppt/theme/theme1.xml', Buffer.from(themeXml(document), 'utf8'));
  document.pages.forEach((page, index) => {
    const imageBindings = imagePlan.slides[index] ?? [];
    entries.set(`ppt/slides/slide${index + 1}.xml`, Buffer.from(slideXml(page, document, warnings, imageBindings), 'utf8'));
    const imageRelationships = imageBindings.map((binding) => `<Relationship Id="${binding.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${binding.media.partName}"/>`).join('');
    entries.set(`ppt/slides/_rels/slide${index + 1}.xml.rels`, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${imageRelationships}</Relationships>`, 'utf8'));
  });
  for (const media of imagePlan.media) entries.set(`ppt/media/${media.partName}`, media.bytes);
  return entries;
}

export class OutcomePptxService {
  constructor(private readonly options: OutcomePptxServiceOptions = {}) {}
  private useGenoffice(): boolean {
    if (this.options.engine) return this.options.engine === 'genoffice';
    return process.env.METIS_OFFICE_ENGINE?.toLowerCase() !== 'legacy' && process.env.NODE_ENV !== 'test';
  }
  private encode(document: PptDocument, warnings: OutcomePptxWarning[], imagePlan?: ManagedImagePlan): OutcomePptxExport {
    const zip = new ZipWriter(); for (const [name, data] of packageParts(document, warnings, imagePlan)) zip.addFile(name, data); const bytes = zip.toBuffer();
    if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt32LE(bytes.length - 22) !== EOCD) throw new Error('pptx_zip_write_invalid');
    return { bytes, warnings };
  }
  exportDocument(document: PptDocument): OutcomePptxExport {
    const parsed = PptDocumentSchema.parse(document); const warnings: OutcomePptxWarning[] = [];
    return this.encode(parsed, warnings);
  }
  async exportManagedDocument(document: PptDocument): Promise<OutcomePptxExport> {
    if (this.useGenoffice() && this.options.resolveOriginalArchive) {
      const mediaId = document.theme[GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY];
      if (typeof mediaId === 'string' && mediaId) {
        const original = await this.options.resolveOriginalArchive(mediaId).catch(() => undefined);
        if (original) {
          const result = await exportPptxViaGenoffice(document, original);
          if (!result.requiresLegacy) return { bytes: Buffer.from(result.bytes), warnings: result.warnings };
          // Structural changes (new/deleted/reordered Grid elements) are not
          // silently discarded: fall through to the existing full writer,
          // which is the authoritative path for such changes in P2.
        }
      }
    }
    const parsed = PptDocumentSchema.parse(document); const warnings: OutcomePptxWarning[] = []; const resolve = this.options.resolveManagedImage;
    if (!resolve) return this.encode(parsed, warnings);
    const mediaById = new Map<string, MediaPart>(); const slides: SlideImageBinding[][] = [];
    for (const page of parsed.pages) {
      const bindings: SlideImageBinding[] = [];
      for (const [elementIndex, element] of page.elements.entries()) {
        if (element.type !== 'image') continue;
        const props = element.props as RecordValue; const mediaId = stringProp(props, 'mediaId'); const mediaType = stringProp(props, 'mediaType'); const displayName = stringProp(props, 'displayName');
        if (!mediaId || !displayName || (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/svg+xml')) {
          if (mediaType === 'image/gif' || mediaType === 'image/webp' || mediaType === 'image/svg+xml') unsupportedMediaWarning(warnings, mediaType);
          else warning(warnings, 'unsupported_image', 'PPT Grid 图片没有完整的已持久化 mediaId、mediaType、displayName 引用，导出为占位形状。');
          continue;
        }
        let resolved: OutcomePptxManagedImage | undefined;
        try { resolved = await resolve({ mediaId, mediaType, displayName }); } catch { resolved = undefined; }
        const imageSignature = resolved?.mediaType === 'image/png' ? resolved.bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : resolved?.mediaType === 'image/jpeg' ? resolved.bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) : resolved?.mediaType === 'image/svg+xml' ? isSafeSvgBuffer(resolved.bytes) : false;
        if (!resolved || resolved.mediaId !== mediaId || resolved.mediaType !== mediaType || resolved.displayName !== displayName || resolved.bytes.length === 0 || resolved.bytes.length > 20 * 1024 * 1024 || !imageSignature) { warning(warnings, 'unsupported_image', 'PPT Grid 图片引用的持久化二进制不可读取、无权访问或格式不受支持，导出为占位形状。'); continue; }
        let media = mediaById.get(resolved.mediaId);
        if (!media) { media = { ...resolved, partName: `image${mediaById.size + 1}.${resolved.mediaType === 'image/png' ? 'png' : resolved.mediaType === 'image/jpeg' ? 'jpg' : 'svg'}` }; mediaById.set(media.mediaId, media); }
        bindings.push({ elementIndex, relationshipId: `rId${bindings.length + 2}`, media });
      }
      slides.push(bindings);
    }
    return this.encode(parsed, warnings, { slides, media: [...mediaById.values()] });
  }
  async exportFile(filePath: string, document: PptDocument): Promise<OutcomePptxExport> { const result = this.options.resolveManagedImage || this.options.resolveOriginalArchive ? await this.exportManagedDocument(document) : this.exportDocument(document); await writeFile(filePath, result.bytes); return result; }
  importBuffer(archive: Buffer): OutcomePptxImport { return parsePpt(readEntries(archive)); }
  async importFile(filePath: string): Promise<OutcomePptxImport> { return this.importBufferV2(await readFile(filePath)); }
  async importBufferV2(archive: Buffer): Promise<OutcomePptxImport> {
    if (this.useGenoffice()) {
      try {
        const imported = await importPptxViaGenoffice(archive);
        return { document: imported.document, warnings: imported.warnings };
      } catch {
        // Unsupported/corrupt packages fall back to the existing codec.
      }
    }
    return this.importBuffer(archive);
  }
  /**
   * Resolve the extracted-image markers from an unsaved import into durable media
   * handles. The caller owns persistence and authorization; this codec only
   * rereads the original package and returns a document with managed references.
   */
  async commitImportedMedia(filePath: string, document: PptDocument, persist: (image: ExtractedSlideImage) => Promise<{ id: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; displayName: string } | undefined>): Promise<PptDocument> {
    const entries = readEntries(await readFile(filePath));
    return this.commitImportedMediaEntries(entries, document, persist);
  }

  async commitImportedMediaBuffer(archive: Buffer, document: PptDocument, persist: (image: ExtractedSlideImage) => Promise<{ id: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; displayName: string } | undefined>): Promise<PptDocument> {
    return this.commitImportedMediaEntries(readEntries(archive), document, persist);
  }

  private async commitImportedMediaEntries(entries: Map<string, Buffer>, document: PptDocument, persist: (image: ExtractedSlideImage) => Promise<{ id: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; displayName: string } | undefined>): Promise<PptDocument> {
    const parsed = PptDocumentSchema.parse(document);
    const presentation = entries.get('ppt/presentation.xml')?.toString('utf8') ?? '';
    const paths = presentation ? slidePaths(entries, presentation) : [];
    const pages: PptDocument['pages'] = [];
    for (const [pageIndex, page] of parsed.pages.entries()) {
      const slidePath = paths[pageIndex] ?? `ppt/slides/slide${pageIndex + 1}.xml`;
      const slideXml = entries.get(slidePath)?.toString('utf8') ?? '';
      const extracted = extractSlideImages(entries, slidePath, slideXml);
      const elements: PptElement[] = [];
      for (const element of page.elements) {
        if (element.type !== 'image') { elements.push(element); continue; }
        const props = element.props as RecordValue;
        if (props.extractedImage !== true) { elements.push(element); continue; }
        const order = typeof props.extractedImageOrder === 'number' ? props.extractedImageOrder : undefined;
        const image = order === undefined ? undefined : extracted.find((candidate) => candidate.elementOrder === order);
        if (!image) { elements.push(element); continue; }
        const managed = await persist(image);
        if (!managed) throw new Error('pptx_media_persist_failed');
        const nextProps: RecordValue = { ...props, mediaId: managed.id, mediaType: managed.mediaType, displayName: managed.displayName };
        delete nextProps.extractedImage;
        delete nextProps.extractedImageOrder;
        delete nextProps.importedImage;
        delete nextProps.mediaName;
        delete nextProps.text;
        elements.push({ ...element, props: nextProps });
      }
      pages.push({ ...page, elements });
    }
    return { ...parsed, pages };
  }
}
