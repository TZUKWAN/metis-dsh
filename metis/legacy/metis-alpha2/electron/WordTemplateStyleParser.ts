import { inflateRawSync } from 'node:zlib';
import type { WordFormattingConfig } from '../engine/outcomes/WordDocumentFormatting.js';
import { type MutableFormattingDraft, type MutableFormattingSlot } from '../engine/outcomes/GuidelineFormatting.js';

/**
 * Reads the layout rules of an uploaded .docx template (journal requirements,
 * thesis/company templates) and maps them onto WordFormattingConfig so they
 * can be previewed and applied to an outcome with the existing formatting
 * engine. Only rules that can be mapped safely are applied; everything the
 * template carries but we refuse to guess is reported in `unrecognized`.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const TWIPS_PER_CM = 566.929;

type Style = Record<string, unknown>;
type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number };

export interface WordTemplateStyleResult {
  config: WordFormattingConfig;
  /** Human-readable description of every rule that was mapped. */
  recognized: string[];
  /** Template aspects detected but intentionally not migrated. */
  unrecognized: string[];
}

function decodeXml(value: string): string {
  return value.replace(/&(?:lt|gt|quot|apos|amp);/gu, (entity) => (
    entity === '&lt;' ? '<' : entity === '&gt;' ? '>' : entity === '&quot;' ? '"' : entity === '&apos;' ? "'" : '&'
  ));
}

function attrs(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:]+)="([^"]*)"/gu)) result[match[1]!] = decodeXml(match[2]!);
  return result;
}

function attr(tag: string, name: string): string | undefined {
  const value = attrs(tag)[name];
  return value === undefined ? undefined : decodeXml(value);
}

function tagValue(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}\\b[^>]*>`, 'u'))?.[0];
}

function contents(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'u'))?.[1];
}

function points(value: string | undefined): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) ? Math.round((result / 20) * 100) / 100 : undefined;
}

function halfPoints(value: string | undefined): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) ? Math.round((result / 2) * 100) / 100 : undefined;
}

function onOff(tag: string | undefined): boolean | undefined {
  if (!tag) return undefined;
  const value = attr(tag, 'w:val');
  if (value === undefined) return true;
  if (/^(1|true|on)$/iu.test(value)) return true;
  if (/^(0|false|off)$/iu.test(value)) return false;
  return undefined;
}

function readEntries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 65_536); offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('docx_zip_invalid');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('docx_central_directory_invalid');
    const nameLength = archive.readUInt16LE(offset + 28);
    const extra = archive.readUInt16LE(offset + 30);
    const comment = archive.readUInt16LE(offset + 32);
    entries.push({
      name: archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: archive.readUInt16LE(offset + 10),
      compressedSize: archive.readUInt32LE(offset + 20),
      localHeaderOffset: archive.readUInt32LE(offset + 42),
    });
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

function parsePropertyStyle(pPr: string, rPr: string): Style {
  const style: Style = {};
  const font = tagValue(rPr, 'w:rFonts');
  const fontFamily = attr(font ?? '', 'w:eastAsia') ?? attr(font ?? '', 'w:ascii') ?? attr(font ?? '', 'w:hAnsi');
  if (fontFamily) style.fontFamily = fontFamily;
  const size = halfPoints(attr(tagValue(rPr, 'w:sz') ?? '', 'w:val'));
  if (size !== undefined) style.fontSize = size;
  const bold = onOff(tagValue(rPr, 'w:b'));
  if (bold !== undefined) style.bold = bold;
  const textColor = attr(tagValue(rPr, 'w:color') ?? '', 'w:val');
  if (textColor && /^[0-9a-f]{6}$/iu.test(textColor)) style.color = `#${textColor.toUpperCase()}`;
  const align = attr(tagValue(pPr, 'w:jc') ?? '', 'w:val');
  if (align && ['left', 'center', 'right', 'justify'].includes(align)) style.align = align;
  const indent = tagValue(pPr, 'w:ind');
  const first = points(attr(indent ?? '', 'w:firstLine'));
  if (first !== undefined) style.firstLineIndent = first;
  const spacing = tagValue(pPr, 'w:spacing');
  const before = points(attr(spacing ?? '', 'w:before'));
  const after = points(attr(spacing ?? '', 'w:after'));
  const line = attr(spacing ?? '', 'w:line');
  if (before !== undefined) style.spaceBefore = before;
  if (after !== undefined) style.spaceAfter = after;
  if (line && attr(spacing ?? '', 'w:lineRule') !== 'exact') {
    const value = Number(line);
    if (Number.isFinite(value)) style.lineSpacing = Math.round((value / 240) * 100) / 100;
  }
  return style;
}

interface RawStyleDefinition { basedOn?: string; name?: string; properties: Style }

function parseStyleDefinitions(xml: string | undefined): Map<string, RawStyleDefinition> {
  const raw = new Map<string, RawStyleDefinition>();
  if (!xml) return raw;
  for (const match of xml.matchAll(/<w:style\b[^>]*>([\s\S]*?)<\/w:style>/gu)) {
    if (attr(match[0], 'w:type') !== 'paragraph') continue;
    const id = attr(match[0], 'w:styleId');
    if (!id) continue;
    const body = match[1]!;
    raw.set(id, {
      basedOn: attr(tagValue(body, 'w:basedOn') ?? '', 'w:val'),
      name: attr(tagValue(body, 'w:name') ?? '', 'w:val'),
      properties: parsePropertyStyle(contents(body, 'w:pPr') ?? '', contents(body, 'w:rPr') ?? ''),
    });
  }
  return raw;
}

function resolveStyle(raw: Map<string, RawStyleDefinition>, id: string, extraBase: Style = {}): Style {
  const merged: Style = { ...extraBase };
  const visit = (styleId: string, visited: Set<string>): void => {
    if (visited.has(styleId)) return;
    visited.add(styleId);
    const definition = raw.get(styleId);
    if (!definition) return;
    if (definition.basedOn) visit(definition.basedOn, visited);
    Object.assign(merged, definition.properties);
  };
  visit(id, new Set<string>());
  return merged;
}

function docDefaultsStyle(xml: string | undefined): Style {
  if (!xml) return {};
  const defaults = contents(xml, 'w:docDefaults') ?? '';
  const runDefault = contents(defaults, 'w:rPrDefault') ?? '';
  return parsePropertyStyle('', contents(runDefault, 'w:rPr') ?? '');
}

function styleIdForHeading(raw: Map<string, RawStyleDefinition>, level: number): string | undefined {
  const byId = `Heading${level}`;
  if (raw.has(byId)) return byId;
  for (const [id, definition] of raw) {
    if (definition.name?.toLowerCase() === `heading ${level}`) return id;
  }
  return undefined;
}

function alignment(value: unknown): 'left' | 'center' | 'right' | 'justify' | undefined {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify' ? value : undefined;
}

const ALIGN_LABELS: Record<string, string> = { left: '左对齐', center: '居中', right: '右对齐', justify: '两端对齐' };

function describeParagraph(prefix: string, style: Style): string | null {
  const parts: string[] = [];
  if (typeof style.fontFamily === 'string') parts.push(String(style.fontFamily));
  const size = typeof style.fontSize === 'number' ? style.fontSize : typeof style.fontSizePt === 'number' ? style.fontSizePt : undefined;
  if (size !== undefined) parts.push(`${size}pt`);
  if (typeof style.align === 'string') parts.push(ALIGN_LABELS[style.align] ?? style.align);
  if (typeof style.lineSpacing === 'number') parts.push(`${style.lineSpacing} 倍行距`);
  if (parts.length === 0) return null;
  return `${prefix}：${parts.join(' / ')}`;
}

/** Maps a heading style onto the config; returns the recognized-rule description. */
function applyHeading(config: MutableFormattingDraft, level: 1 | 2 | 3 | 4 | 5 | 6, style: Style): string | null {
  const heading: MutableFormattingSlot = {};
  if (typeof style.fontFamily === 'string') heading.fontFamily = style.fontFamily;
  if (typeof style.fontSize === 'number') heading.fontSizePt = style.fontSize;
  if (typeof style.color === 'string') heading.color = style.color;
  const align = alignment(style.align);
  if (align) heading.align = align;
  if (typeof style.lineSpacing === 'number') heading.lineSpacing = style.lineSpacing;
  if (typeof style.spaceBefore === 'number') heading.spaceBeforePt = style.spaceBefore;
  if (typeof style.spaceAfter === 'number') heading.spaceAfterPt = style.spaceAfter;
  if (Object.keys(heading).length === 0) return null;
  config.headings = { ...(config.headings ?? {}), [level]: heading };
  return describeParagraph(`${level} 级标题`, { ...heading, align: heading.align ?? style.align });
}

export function parseWordTemplateStyle(archive: Buffer): WordTemplateStyleResult {
  const entries = readEntries(archive);
  const stylesXml = entries.get('word/styles.xml')?.toString('utf8');
  const documentXml = entries.get('word/document.xml')?.toString('utf8');
  if (!documentXml) throw new Error('docx_document_missing');

  const config: MutableFormattingDraft = {};
  const recognized: string[] = [];
  const unrecognized: string[] = [];

  // ── 1. Style hierarchy: docDefaults → Normal → Heading1-6 ──
  const raw = parseStyleDefinitions(stylesXml);
  const base = docDefaultsStyle(stylesXml);
  const normalId = [...raw.entries()].find(([, definition]) => definition.name?.toLowerCase() === 'normal' || definition.name === '正文')?.[0]
    ?? ([...raw.keys()].find((id) => id.toLowerCase() === 'normal'));
  const bodyStyle = normalId ? resolveStyle(raw, normalId, base) : base;

  const body: MutableFormattingSlot = {};
  if (typeof bodyStyle.fontFamily === 'string') body.fontFamily = bodyStyle.fontFamily;
  if (typeof bodyStyle.fontSize === 'number') body.fontSizePt = bodyStyle.fontSize;
  if (typeof bodyStyle.color === 'string') body.color = bodyStyle.color;
  const bodyAlign = alignment(bodyStyle.align);
  if (bodyAlign) body.align = bodyAlign;
  if (typeof bodyStyle.lineSpacing === 'number' && bodyStyle.lineSpacing > 0) body.lineSpacing = bodyStyle.lineSpacing;
  if (typeof bodyStyle.spaceBefore === 'number') body.spaceBeforePt = bodyStyle.spaceBefore;
  if (typeof bodyStyle.spaceAfter === 'number') body.spaceAfterPt = bodyStyle.spaceAfter;
  if (typeof bodyStyle.firstLineIndent === 'number' && typeof bodyStyle.fontSize === 'number' && bodyStyle.fontSize > 0 && bodyStyle.firstLineIndent > 0) {
    body.firstLineIndentChars = Math.max(1, Math.round(bodyStyle.firstLineIndent / bodyStyle.fontSize));
  }
  const bodyDescription = describeParagraph('正文字体', { ...body, align: body.align });
  if (Object.keys(body).length > 0) {
    config.body = body;
    if (bodyDescription) recognized.push(bodyDescription);
  }

  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    const headingId = styleIdForHeading(raw, level);
    if (!headingId) continue;
    const headingStyle = resolveStyle(raw, headingId, bodyStyle);
    // A heading inherits the body look when the template does not define its
    // own; only report and apply rules that actually differ from the body.
    const differs = (Object.keys(headingStyle) as Array<keyof Style>).some((key) => headingStyle[key] !== bodyStyle[key]);
    if (!differs && level > 1) continue;
    const description = applyHeading(config, level, headingStyle);
    if (description) recognized.push(description);
  }

  // ── 2. Direct formatting sampled from the first body paragraphs ──
  // Templates often set the real body look as direct formatting on paragraphs
  // instead of the Normal style; the first text paragraphs are the evidence.
  if (documentXml) {
    const paragraphs = [...documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)].slice(0, 24);
    for (const match of paragraphs) {
      const paragraphXml = match[1] ?? '';
      if (!/<w:t\b/u.test(paragraphXml)) continue;
      if (/<w:pStyle\b[^>]*w:val="([^"]*)"/u.exec(paragraphXml)?.[1]?.toLowerCase().includes('heading')) continue;
      const direct = parsePropertyStyle(contents(paragraphXml, 'w:pPr') ?? '', contents(outerRun(paragraphXml), 'w:rPr') ?? '');
      if (config.body && typeof direct.fontFamily === 'string' && !config.body.fontFamily) { config.body.fontFamily = direct.fontFamily; recognized.push(`正文字体：${direct.fontFamily}（取自正文实际段落）`); }
      if (config.body && typeof direct.fontSize === 'number' && !config.body.fontSizePt) { config.body.fontSizePt = direct.fontSize; recognized.push(`正文字号：${direct.fontSize}pt（取自正文实际段落）`); }
      break;
    }
  }

  // ── 3. Page setup from sectPr ──
  const sectPr = contents(documentXml, 'w:sectPr') ?? '';
  const pgSz = tagValue(sectPr, 'w:pgSz');
  const width = Number(attr(pgSz ?? '', 'w:w'));
  const height = Number(attr(pgSz ?? '', 'w:h'));
  if (Number.isFinite(width) && Number.isFinite(height)) {
    const isA4 = Math.abs(width - 11906) <= 30 && Math.abs(height - 16838) <= 30;
    const isLetter = Math.abs(width - 12240) <= 30 && Math.abs(height - 15840) <= 30;
    if (isA4 || isLetter) {
      config.page = { ...(config.page ?? {}), paper: isA4 ? 'A4' : 'Letter' };
      recognized.push(`纸张：${isA4 ? 'A4' : 'Letter'}`);
    } else {
      unrecognized.push(`自定义纸张尺寸（${width}×${height} twips）未迁移，仅支持 A4/Letter`);
    }
  }
  const pgMar = tagValue(sectPr, 'w:pgMar');
  if (pgMar) {
    const margins: Array<[keyof NonNullable<WordFormattingConfig['page']>, string, string]> = [
      ['marginTopCm', 'w:top', '上'], ['marginBottomCm', 'w:bottom', '下'], ['marginLeftCm', 'w:left', '左'], ['marginRightCm', 'w:right', '右'],
    ];
    config.page = { ...(config.page ?? {}) };
    const applied: string[] = [];
    for (const [key, attribute, label] of margins) {
      const twipValue = Number(attr(pgMar, attribute));
      if (!Number.isFinite(twipValue) || twipValue <= 0) continue;
      const cm = Math.round((twipValue / TWIPS_PER_CM) * 100) / 100;
      config.page[key] = cm;
      applied.push(`${label} ${cm}cm`);
    }
    if (applied.length > 0) recognized.push(`页边距：${applied.join(' / ')}`);
  }

  if (entries.get('word/header1.xml') || /<w:headerReference\b/u.test(sectPr)) unrecognized.push('模板页眉未迁移（保留当前成果页眉）');
  if (entries.get('word/footer1.xml') || /<w:footerReference\b/u.test(sectPr)) unrecognized.push('模板页脚未迁移（保留当前成果页脚）');

  return { config: config as unknown as WordFormattingConfig, recognized, unrecognized };
}

function outerRun(paragraphXml: string): string {
  return paragraphXml.match(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/u)?.[0] ?? '';
}
