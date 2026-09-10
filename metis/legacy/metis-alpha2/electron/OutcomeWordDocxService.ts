/**
 * DOCX codec for the Outcomes Word editor.
 *
 * The codec intentionally has one editable representation: WordDocument. It
 * produces a normal OOXML package with the project ZipWriter and maps the
 * common portable subset back into that model. OOXML features which cannot be
 * represented by WordDocument are surfaced as warnings instead of being
 * silently presented as lossless imports.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipWriter } from '../engine/export/renderers/ZipWriter.js';
import { WordDocumentSchema, type OutcomeWordDocxImportPreview, type OutcomeWordDocxWarning, type WordDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import { importDocxViaGenoffice, exportDocxViaGenoffice, readGenofficeSnapshot, extractGenofficeImagesByRef, GENOFFICE_IMAGE_REF_PREFIX } from './office/genofficeBridge.js';

const OFFICE_ENGINE_ENV = (process.env.METIS_OFFICE_ENGINE ?? 'genoffice').toLowerCase();
export const GENOFFICE_ENABLED = OFFICE_ENGINE_ENV !== 'legacy';
const ORIGINAL_ARCHIVE_KEY = '_originalArchiveMediaId';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const A4 = { width: 11906, height: 16838 };
const LETTER = { width: 12240, height: 15840 };
const IMAGE_SIGNATURES = {
  png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  jpeg: Buffer.from([255, 216, 255]),
} as const;
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PICTURE_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const WORDPROCESSING_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Style = Record<string, unknown>;
type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number };
type DocxImageType = 'image/png' | 'image/jpeg';
type DocxImage = { order: number; imageRef: string; mediaPath: string; mediaType: DocxImageType; displayName: string; bytes: Buffer };
type DocxManagedImage = { mediaId: string; mediaType: DocxImageType; displayName: string; bytes: Buffer };
type DocxImagePart = DocxManagedImage & { partName: string; relationshipId: string };
type DocxImagePersisted = { id: string; mediaType: DocxImageType; displayName: string };

export type OutcomeWordDocxExport = { bytes: Buffer; warnings: OutcomeWordDocxWarning[] };
export type OutcomeWordDocxImport = { document: WordDocument; preview: OutcomeWordDocxImportPreview; warnings: OutcomeWordDocxWarning[] };
export type OutcomeWordDocxServiceOptions = {
  /** Explicit test/rollback selector. Production defaults to GenOffice. */
  engine?: 'genoffice' | 'legacy';
  resolveManagedImage?: (mediaId: string) => Promise<DocxManagedImage | undefined>;
  /** Reads the persisted original package for byte-preserving export (project/outcome/media scoped). */
  resolveOriginalArchive?: (mediaId: string) => Promise<Buffer | undefined>;
  /** Persists a freshly imported original package so later exports can stay byte-preserving. */
  persistOriginalArchive?: (archive: Buffer, displayName: string) => Promise<string | undefined>;
};
export type OutcomeWordDocxMediaPersist = (image: DocxImage) => Promise<DocxImagePersisted | undefined>;
export type OutcomeWordDocxMediaRollback = (mediaIds: readonly string[]) => Promise<void>;

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}
function decodeXml(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code))).replace(/&amp;/gu, '&');
}
function attrs(tag: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) values[match[1]!] = match[2] ?? match[3] ?? '';
  return values;
}
function attr(tag: string, name: string): string | undefined { const value = attrs(tag)[name]; return value === undefined ? undefined : decodeXml(value); }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function firstNumber(style: Style, ...keys: string[]): number | undefined {
  for (const key of keys) { const value = numberValue(style[key]); if (value !== undefined) return value; }
  return undefined;
}
function boolValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function twips(points: number): number { return Math.round(points * 20); }
function centimetersToPoints(value: number): number { return value * 72 / 2.54; }
function points(value: string | undefined): number | undefined { const result = Number(value); return Number.isFinite(result) ? Math.round((result / 20) * 100) / 100 : undefined; }
function halfPoints(value: string | undefined): number | undefined { const result = Number(value); return Number.isFinite(result) ? Math.round((result / 2) * 100) / 100 : undefined; }
function onOff(tag: string | undefined): boolean | undefined {
  if (!tag) return undefined;
  const value = attr(tag, 'w:val');
  return value === '0' || value === 'false' || value === 'off' ? false : true;
}
function tagValue(xml: string, name: string): string | undefined { return xml.match(new RegExp(`<${name}\\b[^>]*>`, 'u'))?.[0]; }
function contents(xml: string, name: string): string | undefined { return xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'u'))?.[1]; }
function textRuns(xml: string): string {
  const tokens = xml.match(/<w:(?:t\b[^>]*>[\s\S]*?<\/w:t>|tab\b[^>]*\/?\s*>|br\b[^>]*\/?\s*>)/gu) ?? [];
  return tokens.map((token) => token.startsWith('<w:t') ? decodeXml(token.replace(/^<w:t\b[^>]*>/u, '').replace(/<\/w:t>$/u, '')) : token.startsWith('<w:tab') ? '\t' : '\n').join('');
}
function color(style: Style): string | undefined {
  const candidate = stringValue(style.color) ?? stringValue(style.fontColor);
  const hex = candidate?.replace(/^#/u, '').toUpperCase();
  return hex && /^[0-9A-F]{6}$/u.test(hex) ? hex : undefined;
}
function pageDimensions(page: Style): { width: number; height: number } {
  const width = numberValue(page.width);
  const height = numberValue(page.height);
  if (width && height) return { width: Math.round(width), height: Math.round(height) };
  return page.paper === 'Letter' ? LETTER : A4;
}
function paragraphProperties(style: Style, fallbackLineSpacing?: number, headingLevel?: number): string {
  const parts: string[] = [];
  if (headingLevel) parts.push(`<w:pStyle w:val="Heading${headingLevel}"/>`);
  const align = stringValue(style.align);
  if (align && ['left', 'center', 'right', 'justify'].includes(align)) parts.push(`<w:jc w:val="${align}"/>`);
  const indent: string[] = [];
  const fontSize = firstNumber(style, 'fontSizePt', 'fontSize') ?? 12;
  const left = firstNumber(style, 'indentLeftPt', 'indentLeft');
  const right = firstNumber(style, 'indentRightPt', 'indentRight');
  const first = firstNumber(style, 'firstLineIndentPt', 'firstLineIndent')
    ?? (() => { const characters = firstNumber(style, 'firstLineIndentChars'); return characters === undefined ? undefined : characters * fontSize; })();
  if (left !== undefined) indent.push(`w:left="${twips(left)}"`);
  if (right !== undefined) indent.push(`w:right="${twips(right)}"`);
  if (first !== undefined) indent.push(`w:firstLine="${twips(first)}"`);
  if (indent.length) parts.push(`<w:ind ${indent.join(' ')}/>`);
  const spacing: string[] = [];
  const before = firstNumber(style, 'spaceBeforePt', 'spaceBefore');
  const after = firstNumber(style, 'spaceAfterPt', 'spaceAfter');
  const line = firstNumber(style, 'lineSpacing') ?? fallbackLineSpacing;
  if (before !== undefined) spacing.push(`w:before="${twips(before)}"`);
  if (after !== undefined) spacing.push(`w:after="${twips(after)}"`);
  if (line !== undefined) spacing.push(`w:line="${Math.round(line * 240)}"`, 'w:lineRule="auto"');
  if (spacing.length) parts.push(`<w:spacing ${spacing.join(' ')}/>`);
  const list = stringValue(style.list);
  if (list === 'bullet' || list === 'numbered') parts.push(`<w:numPr><w:ilvl w:val="${Math.max(0, Math.round(numberValue(style.listLevel) ?? 0))}"/><w:numId w:val="${list === 'bullet' ? 1 : 2}"/></w:numPr>`);
  return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : '';
}
function runProperties(style: Style): string {
  const parts: string[] = [];
  const fontFamily = stringValue(style.fontFamily);
  if (fontFamily) { const safe = escapeXml(fontFamily); parts.push(`<w:rFonts w:ascii="${safe}" w:hAnsi="${safe}" w:eastAsia="${safe}"/>`); }
  const fontSize = firstNumber(style, 'fontSizePt', 'fontSize');
  if (fontSize !== undefined) parts.push(`<w:sz w:val="${Math.max(1, Math.round(fontSize * 2))}"/>`);
  if (boolValue(style.bold)) parts.push('<w:b/>');
  if (boolValue(style.italic)) parts.push('<w:i/>');
  if (boolValue(style.underline)) parts.push('<w:u w:val="single"/>');
  const textColor = color(style); if (textColor) parts.push(`<w:color w:val="${textColor}"/>`);
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}
function paragraphXml(text: string, style: Style = {}, fallbackLineSpacing?: number, headingLevel?: number): string {
  return `<w:p>${paragraphProperties(style, fallbackLineSpacing, headingLevel)}<w:r>${runProperties(style)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}
function mediaExtension(mediaType: DocxImageType): 'png' | 'jpg' { return mediaType === 'image/png' ? 'png' : 'jpg'; }
function imageSignatureOk(bytes: Buffer, mediaType: DocxImageType): boolean {
  return mediaType === 'image/png' ? bytes.subarray(0, IMAGE_SIGNATURES.png.length).equals(IMAGE_SIGNATURES.png) : bytes.subarray(0, IMAGE_SIGNATURES.jpeg.length).equals(IMAGE_SIGNATURES.jpeg);
}
function imageDrawingXml(part: DocxImagePart, numericId: number): string {
  const displayName = escapeXml(part.displayName);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5486400" cy="3657600"/><wp:docPr id="${numericId}" name="${displayName}" descr="${displayName}"/><a:graphic><a:graphicData uri="${PICTURE_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${numericId}" name="${displayName}"/><pic:cNvPicPr/><pic:nvPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${part.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3657600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function tableXml(rows: string[][]): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const grid = `<w:tblGrid>${Array.from({ length: columnCount }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>`;
  const body = rows.map((row) => `<w:tr>${Array.from({ length: columnCount }, (_, index) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphXml(row[index] ?? '')}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7C0CE"/><w:left w:val="single" w:sz="4" w:color="B7C0CE"/><w:bottom w:val="single" w:sz="4" w:color="B7C0CE"/><w:right w:val="single" w:sz="4" w:color="B7C0CE"/><w:insideH w:val="single" w:sz="4" w:color="B7C0CE"/><w:insideV w:val="single" w:sz="4" w:color="B7C0CE"/></w:tblBorders></w:tblPr>${grid}${body}</w:tbl>`;
}
function headerFooterXml(kind: 'hdr' | 'ftr', text: string, pageNumber: boolean): string {
  const paragraphs = text.split(/\r?\n/gu).filter((line) => line.length > 0).map((line) => paragraphXml(line));
  if (kind === 'ftr' && pageNumber) paragraphs.push('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${kind} xmlns:w="${W_NS}">${paragraphs.join('') || '<w:p/>'}</w:${kind}>`;
}
function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="等线"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${[1,2,3,4,5,6].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:rPr><w:b/><w:sz w:val="${Math.max(22, 36 - level * 3)}"/></w:rPr></w:style>`).join('')}</w:styles>`;
}
function numberingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
}
function packageParts(document: WordDocument, imageParts: ReadonlyMap<string, DocxImagePart> = new Map()): Map<string, Buffer> {
  const page = document.page as Style;
  const size = pageDimensions(page);
  const margin = (legacy: string, centimeters: string): number => firstNumber(page, centimeters) !== undefined
    ? centimetersToPoints(firstNumber(page, centimeters)!)
    : firstNumber(page, legacy) ?? 72;
  const margins = { top: margin('marginTop', 'marginTopCm'), right: margin('marginRight', 'marginRightCm'), bottom: margin('marginBottom', 'marginBottomCm'), left: margin('marginLeft', 'marginLeftCm') };
  const pageNumber = page.pageNumber === true;
  const body = document.blocks.map((block, index) => {
    if (block.kind === 'table') return tableXml(block.rows ?? [[]]);
    if (block.kind === 'image') {
      const part = imageParts.get(block.imageRef ?? '');
      return part ? imageDrawingXml(part, index + 1) : paragraphXml(`[图像：${block.imageRef ?? block.text ?? '未命名'}]`);
    }
    const style = (block.style ?? {}) as Style;
    return paragraphXml(block.text ?? '', style, numberValue(page.lineSpacing), block.kind === 'heading' ? block.level ?? 1 : undefined);
  });
  body.push(`<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="${size.width}" w:h="${size.height}"/><w:pgMar w:top="${twips(margins.top)}" w:right="${twips(margins.right)}" w:bottom="${twips(margins.bottom)}" w:left="${twips(margins.left)}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WORDPROCESSING_DRAWING_NS}" xmlns:a="${DRAWING_NS}" xmlns:pic="${PICTURE_NS}"><w:body>${body.join('')}</w:body></w:document>`;
  const mediaDefaults = [...new Set([...imageParts.values()].map((part) => part.mediaType))]
    .map((mediaType) => `<Default Extension="${mediaExtension(mediaType)}" ContentType="${mediaType}"/>`).join('');
  const imageRelationships = [...imageParts.values()]
    .map((part) => `<Relationship Id="${part.relationshipId}" Type="${OFFICE_REL_NS}/image" Target="media/${part.partName}"/>`).join('');
  const entries = new Map<string, Buffer>([
    ['[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`, 'utf8')],
    ['_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`, 'utf8')],
    ['word/document.xml', Buffer.from(documentXml, 'utf8')],
    ['word/styles.xml', Buffer.from(stylesXml(), 'utf8')],
    ['word/numbering.xml', Buffer.from(numberingXml(), 'utf8')],
    ['word/header1.xml', Buffer.from(headerFooterXml('hdr', document.header, false), 'utf8')],
    ['word/footer1.xml', Buffer.from(headerFooterXml('ftr', document.footer, pageNumber), 'utf8')],
    ['word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R_NS}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${R_NS}/header" Target="header1.xml"/><Relationship Id="rId4" Type="${R_NS}/footer" Target="footer1.xml"/>${imageRelationships}</Relationships>`, 'utf8')],
  ]);
  for (const part of new Set(imageParts.values())) entries.set(`word/media/${part.partName}`, part.bytes);
  return entries;
}
function readEntries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 65_536); offset -= 1) if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  if (eocd < 0) throw new Error('docx_zip_invalid');
  const count = archive.readUInt16LE(eocd + 10); let offset = archive.readUInt32LE(eocd + 16); const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('docx_central_directory_invalid');
    const nameLength = archive.readUInt16LE(offset + 28); const extra = archive.readUInt16LE(offset + 30); const comment = archive.readUInt16LE(offset + 32);
    entries.push({ name: archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), method: archive.readUInt16LE(offset + 10), compressedSize: archive.readUInt32LE(offset + 20), localHeaderOffset: archive.readUInt32LE(offset + 42) });
    offset += 46 + nameLength + extra + comment;
  }
  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    const header = entry.localHeaderOffset;
    if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_SIGNATURE) throw new Error('docx_local_header_invalid');
    const start = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28);
    const compressed = archive.subarray(start, start + entry.compressedSize);
    if (compressed.length !== entry.compressedSize) throw new Error('docx_entry_truncated');
    result.set(entry.name, entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`docx_unsupported_method_${entry.method}`); })());
  }
  return result;
}
function outerElement(xml: string, name: string): string | undefined { return xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'u'))?.[0]; }
function elementEnd(xml: string, start: number, name: string): number {
  const matcher = new RegExp(`<${name}\\b[^>]*?(?:/>|>)|</${name}>`, 'gu'); matcher.lastIndex = start; let depth = 0;
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) { if (match[0]!.startsWith(`</${name}`)) { depth -= 1; if (depth === 0) return matcher.lastIndex; } else if (!/\/>$/u.test(match[0]!)) depth += 1; }
  return -1;
}
function directBodyBlocks(xml: string): Array<{ kind: 'p' | 'tbl'; xml: string }> {
  const body = outerElement(xml, 'w:body'); if (!body) return []; const open = body.indexOf('>') + 1; const close = body.lastIndexOf('</w:body>'); const result: Array<{ kind: 'p' | 'tbl'; xml: string }> = [];
  let cursor = open;
  while (cursor < close) { const next = body.indexOf('<w:', cursor); if (next < 0 || next >= close) break; const name = body.slice(next).match(/^<w:(p|tbl)\b/u)?.[1]; if (!name) { const end = body.indexOf('>', next); cursor = end < 0 ? close : end + 1; continue; } const end = elementEnd(body, next, `w:${name}`); if (end < 0) break; result.push({ kind: name === 'p' ? 'p' : 'tbl', xml: body.slice(next, end) }); cursor = end; }
  return result;
}
function pushWarning(warnings: OutcomeWordDocxWarning[], code: OutcomeWordDocxWarning['code'], message: string): void { if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message }); }
function parsePropertyStyle(pPr: string, rPr: string, listKinds: ReadonlyMap<number, 'bullet' | 'numbered'>): Style {
  const style: Style = {};
  const font = tagValue(rPr, 'w:rFonts'); const fontFamily = attr(font ?? '', 'w:eastAsia') ?? attr(font ?? '', 'w:ascii') ?? attr(font ?? '', 'w:hAnsi'); if (fontFamily) style.fontFamily = fontFamily;
  const size = halfPoints(attr(tagValue(rPr, 'w:sz') ?? '', 'w:val')); if (size !== undefined) style.fontSize = size;
  const bold = onOff(tagValue(rPr, 'w:b')); if (bold !== undefined) style.bold = bold; const italic = onOff(tagValue(rPr, 'w:i')); if (italic !== undefined) style.italic = italic;
  const underline = onOff(tagValue(rPr, 'w:u')); if (underline !== undefined) style.underline = underline; const textColor = attr(tagValue(rPr, 'w:color') ?? '', 'w:val'); if (textColor && /^[0-9a-f]{6}$/iu.test(textColor)) style.color = `#${textColor.toUpperCase()}`;
  const align = attr(tagValue(pPr, 'w:jc') ?? '', 'w:val'); if (align && ['left', 'center', 'right', 'justify'].includes(align)) style.align = align;
  const indent = tagValue(pPr, 'w:ind'); const left = points(attr(indent ?? '', 'w:left')); const right = points(attr(indent ?? '', 'w:right')); const first = points(attr(indent ?? '', 'w:firstLine')); if (left !== undefined) style.indentLeft = left; if (right !== undefined) style.indentRight = right; if (first !== undefined) style.firstLineIndent = first;
  const spacing = tagValue(pPr, 'w:spacing'); const before = points(attr(spacing ?? '', 'w:before')); const after = points(attr(spacing ?? '', 'w:after')); const line = attr(spacing ?? '', 'w:line'); if (before !== undefined) style.spaceBefore = before; if (after !== undefined) style.spaceAfter = after; if (line && attr(spacing ?? '', 'w:lineRule') !== 'exact') { const value = Number(line); if (Number.isFinite(value)) style.lineSpacing = Math.round((value / 240) * 100) / 100; }
  const num = contents(pPr, 'w:numPr'); const numId = Number(attr(tagValue(num ?? '', 'w:numId') ?? '', 'w:val')); if (Number.isFinite(numId)) { style.list = listKinds.get(numId) ?? (numId === 1 ? 'bullet' : 'numbered'); const level = Number(attr(tagValue(num ?? '', 'w:ilvl') ?? '', 'w:val')); if (Number.isFinite(level)) style.listLevel = level; }
  return style;
}
function parseNumberingKinds(xml: string | undefined): Map<number, 'bullet' | 'numbered'> {
  if (!xml) return new Map([[1, 'bullet'], [2, 'numbered']]);
  const abstractKinds = new Map<number, 'bullet' | 'numbered'>();
  for (const match of xml.matchAll(/<w:abstractNum\b[^>]*>([\s\S]*?)<\/w:abstractNum>/gu)) {
    const id = Number(attr(match[0], 'w:abstractNumId')); const format = attr(tagValue(match[1]!, 'w:numFmt') ?? '', 'w:val');
    if (Number.isFinite(id) && format) abstractKinds.set(id, format === 'bullet' ? 'bullet' : 'numbered');
  }
  const result = new Map<number, 'bullet' | 'numbered'>();
  for (const match of xml.matchAll(/<w:num\b[^>]*>([\s\S]*?)<\/w:num>/gu)) {
    const numberId = Number(attr(match[0], 'w:numId')); const abstractId = Number(attr(tagValue(match[1]!, 'w:abstractNumId') ?? '', 'w:val')); const kind = abstractKinds.get(abstractId);
    if (Number.isFinite(numberId) && kind) result.set(numberId, kind);
  }
  return result;
}
function parseStyleDefinitions(xml: string | undefined, listKinds: ReadonlyMap<number, 'bullet' | 'numbered'>): Map<string, Style> {
  if (!xml) return new Map();
  const raw = new Map<string, { basedOn?: string; properties: Style }>();
  for (const match of xml.matchAll(/<w:style\b[^>]*>([\s\S]*?)<\/w:style>/gu)) {
    if (attr(match[0], 'w:type') !== 'paragraph') continue;
    const id = attr(match[0], 'w:styleId'); if (!id) continue;
    const body = match[1]!; raw.set(id, { basedOn: attr(tagValue(body, 'w:basedOn') ?? '', 'w:val'), properties: parsePropertyStyle(contents(body, 'w:pPr') ?? '', contents(body, 'w:rPr') ?? '', listKinds) });
  }
  const resolved = new Map<string, Style>();
  const resolve = (id: string, visited = new Set<string>()): Style => {
    const existing = resolved.get(id); if (existing) return existing; const definition = raw.get(id); if (!definition || visited.has(id)) return {};
    const value = { ...(definition.basedOn ? resolve(definition.basedOn, new Set([...visited, id])) : {}), ...definition.properties }; resolved.set(id, value); return value;
  };
  for (const id of raw.keys()) resolve(id); return resolved;
}
function parseStyle(paragraph: string, warnings: OutcomeWordDocxWarning[], listKinds: ReadonlyMap<number, 'bullet' | 'numbered'>, definitions: ReadonlyMap<string, Style>): Style {
  const pPr = contents(paragraph, 'w:pPr') ?? ''; const firstRun = outerElement(paragraph, 'w:r'); const rPr = firstRun ? contents(firstRun, 'w:rPr') ?? '' : '';
  const runCount = [...paragraph.matchAll(/<w:r\b[^>]*>/gu)].length;
  if (runCount > 1 && /<w:rPr\b/iu.test(paragraph)) pushWarning(warnings, 'unsupported_inline_style', '含多段不同字符样式的段落已按首个文本运行样式导入。');
  const styleId = attr(tagValue(pPr, 'w:pStyle') ?? '', 'w:val'); return { ...(styleId ? definitions.get(styleId) ?? {} : {}), ...parsePropertyStyle(pPr, rPr, listKinds) };
}
function parseParagraph(xml: string, id: string, warnings: OutcomeWordDocxWarning[], listKinds: ReadonlyMap<number, 'bullet' | 'numbered'>, definitions: ReadonlyMap<string, Style>): WordDocument['blocks'][number] {
  if (/<w:(?:drawing|object|pict)\b/iu.test(xml)) pushWarning(warnings, 'unsupported_drawing', '图片、图形或嵌入对象不能映射为可编辑 WordDocument 内容。');
  if (/<w:(?:hyperlink|ins|del|moveFrom|moveTo)\b/iu.test(xml)) pushWarning(warnings, /<w:hyperlink\b/iu.test(xml) ? 'unsupported_hyperlink' : 'unsupported_revision', '超链接或修订记录已按纯文本导入。');
  if (/<w:(?:fldSimple|instrText)\b/iu.test(xml)) pushWarning(warnings, 'unsupported_field', '除页码外的 Word 域已按当前可见文本导入。');
  const pPr = contents(xml, 'w:pPr') ?? ''; const pStyle = attr(tagValue(pPr, 'w:pStyle') ?? '', 'w:val'); const heading = pStyle?.match(/^Heading([1-6])$/iu);
  return { id, kind: heading ? 'heading' : 'paragraph', ...(heading ? { level: Number(heading[1]) } : {}), text: textRuns(xml), style: parseStyle(xml, warnings, listKinds, definitions) };
}
function directTableChildren(xml: string, elementName: 'w:tr' | 'w:tc'): string[] {
  const rootName = elementName === 'w:tr' ? 'w:tbl' : 'w:tr'; const rootStart = xml.indexOf(`<${rootName}`); if (rootStart < 0) return [];
  const rootOpen = xml.indexOf('>', rootStart); const rootEnd = elementEnd(xml, rootStart, rootName); if (rootOpen < 0 || rootEnd < 0) return [];
  const result: string[] = []; let cursor = rootOpen + 1;
  while (cursor < rootEnd) {
    const start = xml.indexOf(`<${elementName}`, cursor); if (start < 0 || start >= rootEnd) break;
    const end = elementEnd(xml, start, elementName); if (end < 0 || end > rootEnd) break;
    result.push(xml.slice(start, end)); cursor = end;
  }
  return result;
}
function parseTable(xml: string, id: string, warnings: OutcomeWordDocxWarning[]): WordDocument['blocks'][number] {
  if (/<w:(?:gridSpan|vMerge|tblLayout|tblpPr|tblStyle|shd|tcBorders|vAlign|tcMar)\b/iu.test(xml) || /<w:tc\b[\s\S]*?<w:tbl\b/iu.test(xml)) pushWarning(warnings, 'unsupported_table_layout', '嵌套、合并、浮动或带有单元格样式的表格已扁平化为普通表格。');
  const rows = directTableChildren(xml, 'w:tr').map((row) => directTableChildren(row, 'w:tc').map((cell) => textRuns(cell)));
  return { id, kind: 'table', rows: rows.length ? rows : [['']] };
}
function relationshipTarget(rels: string, type: 'header' | 'footer', id: string | undefined): string | undefined {
  if (!id) return undefined; for (const match of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/gu)) { const values = attrs(match[0]); if (values.Id === id && values.Type?.endsWith(`/${type}`)) return `word/${values.Target?.replace(/^\/?word\//u, '') ?? ''}`; } return undefined;
}
function headerFooterText(xml: string | undefined, warnings: OutcomeWordDocxWarning[]): { text: string; pageNumber: boolean } {
  if (!xml) return { text: '', pageNumber: false }; if (/<w:(?:drawing|object|pict|tbl)\b/iu.test(xml)) pushWarning(warnings, 'unsupported_section', '页眉页脚中的图形或表格未映射到 WordDocument。');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu)]; const pageNumber = /(?:<w:fldSimple\b[^>]*w:instr="[^"]*PAGE|<w:instrText\b[^>]*>\s*PAGE\s*<\/w:instrText>)/iu.test(xml);
  return { text: paragraphs.filter((paragraph) => !/(?:<w:fldSimple\b[^>]*w:instr="[^"]*PAGE|<w:instrText\b[^>]*>\s*PAGE\s*<\/w:instrText>)/iu.test(paragraph[0]!)).map((paragraph) => textRuns(paragraph[0]!)).filter(Boolean).join('\n'), pageNumber };
}
function relationshipTargetPath(rels: string, id: string | undefined): string | undefined {
  if (!id) return undefined;
  for (const match of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/gu)) {
    const values = attrs(match[0]); if (values.Id !== id || !values.Target) continue;
    const target = values.Target.startsWith('/') ? values.Target.slice(1) : `word/${values.Target}`;
    const segments: string[] = []; for (const segment of target.split('/')) { if (!segment || segment === '.') continue; if (segment === '..') segments.pop(); else segments.push(segment); }
    return segments.join('/');
  }
  return undefined;
}
function extractParagraphImage(xml: string, entries: Map<string, Buffer>, rels: string, order: number): DocxImage | undefined {
  const drawings = xml.match(/<w:drawing\b[\s\S]*?<\/w:drawing>/gu) ?? [];
  const drawing = drawings[0];
  if (drawings.length !== 1 || !drawing || textRuns(xml).trim() || !/<wp:inline\b[\s\S]*?<\/wp:inline>/u.test(drawing)) return undefined;
  const embed = attr(drawing.match(/<a:blip\b[^>]*>/u)?.[0] ?? '', 'r:embed'); const mediaPath = relationshipTargetPath(rels, embed); if (!mediaPath) return undefined;
  const bytes = entries.get(mediaPath); if (!bytes) return undefined;
  const lower = mediaPath.toLowerCase(); const mediaType: DocxImageType | undefined = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : undefined;
  if (!mediaType || !imageSignatureOk(bytes, mediaType)) return undefined;
  const displayName = attr(drawing.match(/<wp:docPr\b[^>]*>/u)?.[0] ?? '', 'name') ?? mediaPath.split('/').pop() ?? `image-${order}`;
  return { order, imageRef: `docx-import-image-${order}`, mediaPath, mediaType, displayName, bytes };
}
function parseWordDocument(entries: Map<string, Buffer>): OutcomeWordDocxImport {
  const documentXml = entries.get('word/document.xml')?.toString('utf8'); if (!documentXml) throw new Error('docx_document_missing');
  const warnings: OutcomeWordDocxWarning[] = []; const rels = entries.get('word/_rels/document.xml.rels')?.toString('utf8') ?? ''; let imageOrder = 0;
  const sourceImages: DocxImage[] = [];
  const listKinds = parseNumberingKinds(entries.get('word/numbering.xml')?.toString('utf8')); const definitions = parseStyleDefinitions(entries.get('word/styles.xml')?.toString('utf8'), listKinds); const blocks = directBodyBlocks(documentXml).map((item, index) => {
    if (item.kind !== 'p') return parseTable(item.xml, `docx-table-${index + 1}`, warnings);
    const image = extractParagraphImage(item.xml, entries, rels, imageOrder + 1);
    if (image) { imageOrder += 1; sourceImages.push(image); return { id: image.imageRef, kind: 'image' as const, imageRef: image.imageRef, mediaType: image.mediaType, displayName: image.displayName }; }
    return parseParagraph(item.xml, `docx-p-${index + 1}`, warnings, listKinds, definitions);
  });
  const sectPr = contents(documentXml, 'w:sectPr') ?? ''; const page: Style = {}; const pgSz = tagValue(sectPr, 'w:pgSz'); const pgMar = tagValue(sectPr, 'w:pgMar'); const width = Number(attr(pgSz ?? '', 'w:w')); const height = Number(attr(pgSz ?? '', 'w:h'));
  if (Number.isFinite(width) && Number.isFinite(height)) { page.width = width; page.height = height; page.paper = width === LETTER.width && height === LETTER.height ? 'Letter' : width === A4.width && height === A4.height ? 'A4' : 'custom'; }
  for (const [key, attribute] of [['marginTop', 'w:top'], ['marginRight', 'w:right'], ['marginBottom', 'w:bottom'], ['marginLeft', 'w:left']] as const) { const value = points(attr(pgMar ?? '', attribute)); if (value !== undefined) page[key] = value; }
  const headerRef = tagValue(sectPr, 'w:headerReference'); const footerRef = tagValue(sectPr, 'w:footerReference'); const header = headerFooterText(entries.get(relationshipTarget(rels, 'header', attr(headerRef ?? '', 'r:id')) ?? '')?.toString('utf8'), warnings); const footer = headerFooterText(entries.get(relationshipTarget(rels, 'footer', attr(footerRef ?? '', 'r:id')) ?? '')?.toString('utf8'), warnings); if (footer.pageNumber) page.pageNumber = true;
  const documentWithoutBaseSection = documentXml.replace(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/iu, '');
  if (/<w:(?:altChunk|sectPr)\b/iu.test(documentWithoutBaseSection)) pushWarning(warnings, 'unsupported_section', '多节、替代内容或非标准节属性仅保留了当前基础页面设置。');
  const parsed = WordDocumentSchema.safeParse({ type: 'word', blocks, page, header: header.text, footer: footer.text }); if (!parsed.success) throw new Error('docx_word_document_invalid');
  const preview = {
    images: sourceImages.map((image) => ({
      blockId: image.imageRef,
      mediaType: image.mediaType,
      displayName: image.displayName,
      byteLength: image.bytes.length,
    })),
  } satisfies OutcomeWordDocxImportPreview;
  return { document: parsed.data, preview, warnings };
}

export class OutcomeWordDocxService {
  constructor(private readonly options: OutcomeWordDocxServiceOptions = {}) {}
  private useGenoffice(): boolean {
    if (this.options.engine) return this.options.engine === 'genoffice';
    return GENOFFICE_ENABLED && process.env.NODE_ENV !== 'test';
  }
  private encode(document: WordDocument, warnings: OutcomeWordDocxWarning[], imageParts: ReadonlyMap<string, DocxImagePart> = new Map()): OutcomeWordDocxExport {
    const zip = new ZipWriter(); for (const [name, bytes] of packageParts(document, imageParts)) zip.addFile(name, bytes); const bytes = zip.toBuffer();
    if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt32LE(bytes.length - 22) !== EOCD_SIGNATURE) throw new Error('docx_zip_write_invalid');
    return { bytes, warnings };
  }
  exportDocument(document: WordDocument): OutcomeWordDocxExport {
    const parsed = WordDocumentSchema.parse(document); const warnings: OutcomeWordDocxWarning[] = [];
    if (parsed.blocks.some((block) => block.kind === 'image')) pushWarning(warnings, 'unsupported_drawing', '当前同步 DOCX 导出未解析媒体存储；请使用 exportManagedDocument 导出已托管的 PNG/JPEG。');
    return this.encode(parsed, warnings);
  }
  async exportManagedDocument(document: WordDocument): Promise<OutcomeWordDocxExport> {
    if (this.useGenoffice() && this.options.resolveOriginalArchive) {
      const archiveMediaId = (document.page as Style)[ORIGINAL_ARCHIVE_KEY];
      if (typeof archiveMediaId === 'string' && archiveMediaId) {
        const original = await this.options.resolveOriginalArchive(archiveMediaId).catch(() => undefined);
        if (original) {
          const snapshot = readGenofficeSnapshot(document);
          const liveState = JSON.stringify({ header: document.header, footer: document.footer, page: Object.fromEntries(Object.entries(document.page as Style).filter(([key]) => key !== ORIGINAL_ARCHIVE_KEY && key !== '_genofficeSnapshot')) });
          const drifted = snapshot === undefined ? true : snapshot !== liveState;
          if (!drifted) {
            const resolveImage = this.options.resolveManagedImage
              ? async (mediaId: string) => {
                  const resolved = await this.options.resolveManagedImage!(mediaId).catch(() => undefined);
                  if (!resolved) return undefined;
                  return { bytes: resolved.bytes, mediaType: resolved.mediaType, displayName: resolved.displayName };
                }
              : undefined;
            const result = await exportDocxViaGenoffice(document, original, resolveImage);
            return { bytes: Buffer.from(result.bytes), warnings: result.warnings };
          }
          // header/footer/page drifted from the import snapshot: fall through to
          // the legacy full-generation codec (correct output, not byte-preserving).
        }
      }
    }
    const parsed = WordDocumentSchema.parse(document); const warnings: OutcomeWordDocxWarning[] = []; const resolve = this.options.resolveManagedImage;
    if (!resolve) return this.exportDocument(parsed);
    const imageParts = new Map<string, DocxImagePart>();
    for (const block of parsed.blocks) {
      if (block.kind !== 'image') continue;
      const mediaId = block.imageRef;
      if (!mediaId) { pushWarning(warnings, 'unsupported_drawing', 'Word 图片缺少受管媒体引用，已保留为可见占位。'); continue; }
      let resolved: DocxManagedImage | undefined;
      try { resolved = await resolve(mediaId); } catch { resolved = undefined; }
      if (!resolved || resolved.mediaId !== mediaId || !['image/png', 'image/jpeg'].includes(resolved.mediaType) || !resolved.displayName || resolved.bytes.length === 0 || resolved.bytes.length > 20 * 1024 * 1024 || !imageSignatureOk(resolved.bytes, resolved.mediaType)) {
        pushWarning(warnings, 'unsupported_drawing', 'Word 图片引用的项目媒体不可读取、无权访问或格式不受支持，已保留为可见占位。');
        continue;
      }
      if (!imageParts.has(mediaId)) imageParts.set(mediaId, { ...resolved, partName: `image${imageParts.size + 1}.${mediaExtension(resolved.mediaType)}`, relationshipId: `rId${imageParts.size + 5}` });
    }
    return this.encode(parsed, warnings, imageParts);
  }
  async exportFile(filePath: string, document: WordDocument): Promise<OutcomeWordDocxExport> { const result = this.options.resolveManagedImage || this.options.resolveOriginalArchive ? await this.exportManagedDocument(document) : this.exportDocument(document); await writeFile(filePath, result.bytes); return result; }
  importBuffer(archive: Buffer): OutcomeWordDocxImport { return parseWordDocument(readEntries(archive)); }
  async importFile(filePath: string): Promise<OutcomeWordDocxImport> { return this.importBufferV2(await readFile(filePath)); }
  /**
   * Engine-dispatched import. GenOffice path (default): full Block tree import
   * with per-block patch anchors and the original package kept for
   * byte-preserving export. Falls back to the legacy codec on any parse error.
   */
  async importBufferV2(archive: Buffer): Promise<OutcomeWordDocxImport> {
    if (this.useGenoffice()) {
      try {
        const result = await importDocxViaGenoffice(archive);
        const document = result.document;
        if (this.options.persistOriginalArchive) {
          const mediaId = await this.options.persistOriginalArchive(archive, 'original.docx').catch(() => undefined);
          if (mediaId) (document.page as Style)[ORIGINAL_ARCHIVE_KEY] = mediaId;
        }
        const preview = {
          images: result.images.map((image) => ({
            blockId: image.blockId,
            mediaType: image.mediaType,
            displayName: image.displayName,
            byteLength: image.bytes.length,
          })),
        } satisfies OutcomeWordDocxImportPreview;
        return { document, preview, warnings: result.warnings };
      } catch {
        // GenOffice could not parse this package — fall through to the legacy codec.
      }
    }
    return this.importBuffer(archive);
  }
  /** Save-time-only bridge: resolves imported inline PNG/JPEG bytes and never writes by itself. */
  async commitImportedMedia(archive: Buffer, document: WordDocument, persist: OutcomeWordDocxMediaPersist, rollback: OutcomeWordDocxMediaRollback): Promise<WordDocument> {
    const hasGenofficeImages = document.blocks.some((block) => block.kind === 'image' && block.imageRef?.startsWith(GENOFFICE_IMAGE_REF_PREFIX));
    if (this.useGenoffice() && hasGenofficeImages) {
      const parsed = WordDocumentSchema.parse(document);
      const imageMap = await extractGenofficeImagesByRef(archive);
      const created: string[] = [];
      try {
        const blocks: WordDocument['blocks'] = [];
        for (const block of parsed.blocks) {
          if (block.kind !== 'image' || !block.imageRef?.startsWith(GENOFFICE_IMAGE_REF_PREFIX)) { blocks.push(block); continue; }
          const image = imageMap.get(block.imageRef);
          if (!image) throw new Error('docx_media_source_missing');
          const managed = await persist({ order: 0, imageRef: block.imageRef, mediaPath: image.imageRef, mediaType: image.mediaType, displayName: image.displayName, bytes: image.bytes });
          if (!managed) throw new Error('docx_media_persist_failed');
          created.push(managed.id);
          blocks.push({ ...block, imageRef: managed.id, mediaType: managed.mediaType, displayName: managed.displayName });
        }
        return { ...parsed, blocks };
      } catch (error) { await rollback(created); throw error; }
    }
    const entries = readEntries(archive); const parsed = WordDocumentSchema.parse(document); const documentXml = entries.get('word/document.xml')?.toString('utf8'); const rels = entries.get('word/_rels/document.xml.rels')?.toString('utf8') ?? '';
    if (!documentXml) throw new Error('docx_document_missing');
    const sourceImages: DocxImage[] = []; for (const item of directBodyBlocks(documentXml)) if (item.kind === 'p') { const image = extractParagraphImage(item.xml, entries, rels, sourceImages.length + 1); if (image) sourceImages.push(image); }
    const created: string[] = [];
    try {
      const blocks = parsed.blocks.map((block) => {
        if (block.kind !== 'image' || !block.imageRef?.startsWith('docx-import-image-')) return block;
        const order = Number(block.imageRef.slice('docx-import-image-'.length)); const image = sourceImages[order - 1]; if (!image) throw new Error('docx_media_source_missing');
        return block;
      });
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]!; if (block.kind !== 'image' || !block.imageRef?.startsWith('docx-import-image-')) continue;
        const order = Number(block.imageRef.slice('docx-import-image-'.length)); const image = sourceImages[order - 1]; const managed = image ? await persist(image) : undefined;
        if (!managed) throw new Error('docx_media_persist_failed'); created.push(managed.id);
        blocks[index] = { ...block, imageRef: managed.id, mediaType: managed.mediaType, displayName: managed.displayName };
      }
      return { ...parsed, blocks };
    } catch (error) { await rollback(created); throw error; }
  }
}
