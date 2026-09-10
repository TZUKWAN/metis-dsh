import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import {
  FUNDING_TEMPLATE_LIMITS,
  FundingTemplateObservationDocumentSchema,
  FundingTemplateSafeIdSchema,
  FundingTemplateTimestampSchema,
  type FundingParagraphObservation,
  type FundingStyleObservation,
  type FundingTemplateObservationDocument,
} from '../engine/runtime/FundingTemplateContract.js';

const ADAPTER_VERSION = '1.0.0' as const;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_XML_CHARS = 8 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const requireFromAdapter = createRequire(import.meta.url);

type ObservedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// eslint-disable-next-line no-control-regex -- filesystem request strings reject C0/C1 controls
const UNSAFE_PATH_TEXT = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'u');

export const FundingTemplateObservationFileRequestSchema = z.strictObject({
  filePath: z.string().min(1).max(32_768).refine((value) => !UNSAFE_PATH_TEXT.test(value)),
  trustedRoot: z.string().min(1).max(32_768).refine((value) => !UNSAFE_PATH_TEXT.test(value)),
  documentId: FundingTemplateSafeIdSchema,
  extractedAt: FundingTemplateTimestampSchema,
});

export const FUNDING_TEMPLATE_OBSERVATION_ADAPTER_LIMITS = Object.freeze({
  fileBytes: MAX_FILE_BYTES,
  pages: FUNDING_TEMPLATE_LIMITS.pages,
  blocks: FUNDING_TEMPLATE_LIMITS.blocks,
  archiveEntries: MAX_ARCHIVE_ENTRIES,
  archiveUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  archiveEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
  compressionRatio: MAX_COMPRESSION_RATIO,
} as const);

export interface FundingTemplateObservationFileRequest {
  filePath: string;
  trustedRoot: string;
  documentId: string;
  extractedAt: number;
}

export interface FundingDocxStructureSummary {
  sourceDigest: string;
  paragraphCount: number;
  tableCount: number;
  styleCount: number;
  explicitPageBreakCount: number;
  pageSetupObserved: boolean;
  structureDigest: string;
}

export type FundingTemplateObservationAdapterResult =
  | { ok: true; document: FundingTemplateObservationDocument }
  | {
      ok: false;
      code:
        | 'invalid_request'
        | 'path_outside_trusted_root'
        | 'symlink_rejected'
        | 'file_not_found'
        | 'file_too_large'
        | 'unstable_file'
        | 'unsupported_format'
        | 'invalid_pdf'
        | 'pdf_limit_exceeded'
        | 'invalid_docx'
        | 'unsafe_archive'
        | 'archive_limit_exceeded'
        | 'docx_layout_unobservable'
        | 'insufficient_observations'
        | 'observation_invalid';
      issues: string[];
      docxStructure?: FundingDocxStructureSummary;
    };

interface StableFile {
  bytes: Buffer;
  extension: '.pdf' | '.docx';
}

interface ZipEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
  madeBy: number;
}

interface PdfLineItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontFamily: string | null;
  bold: boolean;
  italic: boolean;
}

interface DocxParagraphDigest {
  textDigest: string;
  styleId: string | null;
}

interface DocxTableDigest {
  rows: number;
  columns: number;
  cellTextDigests: string[];
}

interface DocxInspection {
  paragraphs: DocxParagraphDigest[];
  tables: DocxTableDigest[];
  styles: FundingStyleObservation[];
  explicitPageBreakCount: number;
  pageSetup: {
    widthPt: number;
    heightPt: number;
    marginsPt: { top: number; right: number; bottom: number; left: number };
  } | null;
}

class AdapterFailure extends Error {
  constructor(
    readonly code: Exclude<FundingTemplateObservationAdapterResult, { ok: true }>['code'],
    readonly safeIssue: string,
    readonly docxStructure?: FundingDocxStructureSummary,
  ) {
    super(safeIssue);
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function bundledPdfJsAssetDirectory(directory: 'cmaps' | 'standard_fonts'): string {
  try {
    const packageRoot = path.dirname(requireFromAdapter.resolve('pdfjs-dist/package.json'));
    return `${path.join(packageRoot, directory)}${path.sep}`;
  } catch {
    throw new AdapterFailure('invalid_pdf', 'Bundled PDF text resources are unavailable');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Non-JSON value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function stableRead(request: FundingTemplateObservationFileRequest): Promise<StableFile> {
  let rootReal: string;
  let fileReal: string;
  try {
    const rootStat = await fs.lstat(request.trustedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new AdapterFailure('symlink_rejected', 'Trusted root must be a real directory');
    }
    rootReal = await fs.realpath(request.trustedRoot);
    const fileStat = await fs.lstat(request.filePath);
    if (!fileStat.isFile()) throw new AdapterFailure('file_not_found', 'Template input is not a regular file');
    if (fileStat.isSymbolicLink()) throw new AdapterFailure('symlink_rejected', 'Template input cannot be a symbolic link');
    fileReal = await fs.realpath(request.filePath);
  } catch (error) {
    if (error instanceof AdapterFailure) throw error;
    throw new AdapterFailure('file_not_found', 'Template input is unavailable');
  }
  if (!isContained(rootReal, fileReal)) {
    throw new AdapterFailure('path_outside_trusted_root', 'Template input is outside the trusted root');
  }
  const extension = path.extname(fileReal).toLocaleLowerCase('en-US');
  if (extension !== '.pdf' && extension !== '.docx') {
    throw new AdapterFailure('unsupported_format', 'Only PDF and DOCX inputs are supported');
  }

  const handle = await fs.open(fileReal, fsConstants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new AdapterFailure('file_not_found', 'Template input is not a regular file');
    if (before.size <= 0 || before.size > MAX_FILE_BYTES) {
      throw new AdapterFailure('file_too_large', 'Template input exceeds the file-size boundary');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino
      || before.dev !== after.dev
      || bytes.length !== after.size) {
      throw new AdapterFailure('unstable_file', 'Template input changed while it was read');
    }
    const finalReal = await fs.realpath(request.filePath);
    if (finalReal !== fileReal) throw new AdapterFailure('unstable_file', 'Template input identity changed while it was read');
    const finalStat = await fs.stat(finalReal);
    if (finalStat.ino !== after.ino
      || finalStat.dev !== after.dev
      || finalStat.size !== after.size
      || finalStat.mtimeMs !== after.mtimeMs) {
      throw new AdapterFailure('unstable_file', 'Template input path was replaced while it was read');
    }
    return { bytes, extension };
  } finally {
    await handle.close();
  }
}

function inferContentRole(text: string, fontSize: number, medianFontSize: number): FundingParagraphObservation['contentRole'] {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (/(?:不超过|限\s*\d+\s*(?:字|字符|词)|必填|不能为空|no more than|maximum|required)/iu.test(normalized)) {
    return 'instruction';
  }
  if (/^(?:[一二三四五六七八九十百]+|\d+(?:\.\d+)?)[、.．)）]/u.test(normalized)
    || fontSize >= medianFontSize + 2
    || /^(?:项目名称|课题名称|申请人|负责人|依托单位|研究基础|研究目标|研究方法|研究计划|预期成果|经费预算|参考文献)\s*[：:]?$/u.test(normalized)
    || /^(?:project title|applicant|organization|research basis|objectives?|methods?|research plan|expected outputs?|budget|references)\s*:?[\s]*$/iu.test(normalized)) {
    return 'template_label';
  }
  return 'unknown';
}

function safeBounds(x: number, y: number, width: number, height: number, pageWidth: number, pageHeight: number): ObservedBounds | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const left = Math.max(0, Math.min(pageWidth, x));
  const top = Math.max(0, Math.min(pageHeight, y));
  const right = Math.max(left, Math.min(pageWidth, x + width));
  const bottom = Math.max(top, Math.min(pageHeight, y + height));
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function groupPdfLines(items: PdfLineItem[], pageWidth: number, pageHeight: number) {
  const ordered = [...items].sort((left, right) => {
    const vertical = left.y - right.y;
    return Math.abs(vertical) > 1.5 ? vertical : left.x - right.x;
  });
  const lines: Array<{ items: PdfLineItem[]; y: number }> = [];
  for (const item of ordered) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 1.5);
    if (line) line.items.push(item);
    else lines.push({ items: [item], y: item.y });
  }
  return lines.flatMap((line) => {
    const sorted = line.items.sort((left, right) => left.x - right.x);
    const first = sorted[0];
    if (!first) return [];
    let text = '';
    let previousRight = first.x;
    for (const item of sorted) {
      if (text.length > 0 && item.x - previousRight > Math.max(1, item.height * 0.2)) text += ' ';
      text += item.text;
      previousRight = item.x + item.width;
    }
    text = text.replace(/\s+/gu, ' ').trim();
    if (text.length === 0) return [];
    const x = Math.min(...sorted.map((item) => item.x));
    const y = Math.min(...sorted.map((item) => item.y));
    const right = Math.max(...sorted.map((item) => item.x + item.width));
    const bottom = Math.max(...sorted.map((item) => item.y + item.height));
    const bounds = safeBounds(x, y, right - x, bottom - y, pageWidth, pageHeight);
    if (!bounds) return [];
    const primary = [...sorted].sort((left, right) => right.text.length - left.text.length)[0] ?? first;
    return [{ text, bounds, primary }];
  });
}

async function observePdf(
  bytes: Buffer,
  request: FundingTemplateObservationFileRequest,
): Promise<FundingTemplateObservationDocument> {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))) {
    throw new AdapterFailure('invalid_pdf', 'PDF signature is invalid');
  }
  let pdfjs: typeof import('pdfjs-dist');
  try {
    pdfjs = await import('pdfjs-dist');
  } catch {
    throw new AdapterFailure('invalid_pdf', 'Bundled PDF parser is unavailable');
  }
  const sourceDigest = sha256(bytes);
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: bundledPdfJsAssetDirectory('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: bundledPdfJsAssetDirectory('standard_fonts'),
    useSystemFonts: true,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: true,
  });
  let document: import('pdfjs-dist').PDFDocumentProxy;
  try {
    document = await loadingTask.promise;
  } catch {
    throw new AdapterFailure('invalid_pdf', 'PDF structure could not be parsed');
  }
  try {
    if (document.numPages <= 0 || document.numPages > FUNDING_TEMPLATE_LIMITS.pages) {
      throw new AdapterFailure('pdf_limit_exceeded', 'PDF page count exceeds the observation boundary');
    }
    const pages: FundingTemplateObservationDocument['pages'] = [];
    const blocks: FundingTemplateObservationDocument['blocks'] = [];
    const styles = new Map<string, FundingStyleObservation>();
    let ordinal = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ pageNumber, widthPt: viewport.width, heightPt: viewport.height, observedMarginsPt: null });
      const textContent = await page.getTextContent({ disableNormalization: false });
      const rawItems: PdfLineItem[] = [];
      for (const raw of textContent.items) {
        if (!('str' in raw) || raw.str.trim().length === 0) continue;
        const transform = pdfjs.Util.transform(viewport.transform, raw.transform);
        const fontHeight = Math.max(0.1, Math.hypot(transform[2] ?? 0, transform[3] ?? 0));
        const x = transform[4] ?? 0;
        const baselineY = transform[5] ?? 0;
        const width = Math.max(0.1, Math.abs(raw.width));
        const bounds = safeBounds(x, baselineY - fontHeight, width, fontHeight, viewport.width, viewport.height);
        if (!bounds) continue;
        const family = textContent.styles[raw.fontName]?.fontFamily ?? null;
        const nameForTraits = `${raw.fontName} ${family ?? ''}`;
        rawItems.push({
          text: raw.str,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          fontName: raw.fontName,
          fontFamily: family,
          bold: /(?:bold|semibold|demi|black)/iu.test(nameForTraits),
          italic: /(?:italic|oblique)/iu.test(nameForTraits),
        });
      }
      const medianSize = rawItems.length === 0
        ? 0
        : [...rawItems].sort((left, right) => left.height - right.height)[Math.floor(rawItems.length / 2)]?.height ?? 0;
      const lines = groupPdfLines(rawItems, viewport.width, viewport.height);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (!line) continue;
        const fontSizePt = Number(line.primary.height.toFixed(4));
        const styleIdentity = `${line.primary.fontFamily ?? 'unidentified-family'}:${fontSizePt}:${line.primary.bold}:${line.primary.italic}`;
        const styleId = `pdf-style:${sha256(styleIdentity).slice(0, 24)}`;
        if (!styles.has(styleId)) {
          styles.set(styleId, {
            styleId,
            fontFamily: line.primary.fontFamily,
            fontSizePt,
            fontWeight: line.primary.bold ? 'bold' : 'normal',
            italic: line.primary.italic,
            alignment: null,
            lineSpacingPt: null,
            paragraphBeforePt: null,
            paragraphAfterPt: null,
          });
        }
        blocks.push({
          kind: 'paragraph',
          blockId: `pdf-p${pageNumber}-l${lineIndex + 1}`,
          pageNumber,
          ordinal,
          bounds: line.bounds,
          text: line.text.slice(0, FUNDING_TEMPLATE_LIMITS.textCharsPerBlock),
          contentRole: inferContentRole(line.text, fontSizePt, medianSize),
          styleId,
        });
        ordinal += 1;
        if (blocks.length > FUNDING_TEMPLATE_LIMITS.blocks) {
          throw new AdapterFailure('pdf_limit_exceeded', 'PDF text block count exceeds the observation boundary');
        }
      }
      page.cleanup();
    }
    if (blocks.length === 0) {
      throw new AdapterFailure('insufficient_observations', 'PDF contains no observable text blocks');
    }
    const candidate: FundingTemplateObservationDocument = {
      contractVersion: 1,
      documentId: request.documentId,
      sourceFormat: 'pdf',
      sourceDigest,
      extractedAt: request.extractedAt,
      extractor: { name: 'metis-pdfjs-observation-adapter', version: ADAPTER_VERSION },
      pageCount: document.numPages,
      pages,
      styles: [...styles.values()],
      blocks,
    };
    const parsed = FundingTemplateObservationDocumentSchema.safeParse(candidate);
    if (!parsed.success) throw new AdapterFailure('observation_invalid', 'PDF observations do not satisfy the engine contract');
    return parsed.data;
  } finally {
    await document.destroy();
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new AdapterFailure('invalid_docx', 'DOCX central directory is missing');
}

function safeZipName(raw: Buffer): string {
  const name = raw.toString('utf8');
  if (name.includes('\ufffd') || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/u.test(name)) {
    throw new AdapterFailure('unsafe_archive', 'DOCX contains an unsafe archive path');
  }
  const directory = name.endsWith('/');
  const segments = name.split('/');
  if (directory) segments.pop();
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new AdapterFailure('unsafe_archive', 'DOCX contains archive path traversal');
  }
  return name;
}

function parseZipEntries(bytes: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new AdapterFailure('unsafe_archive', 'Multi-disk DOCX archives are rejected');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new AdapterFailure('archive_limit_exceeded', 'ZIP64 DOCX archives are rejected');
  }
  if (entryCount <= 0 || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new AdapterFailure('archive_limit_exceeded', 'DOCX entry count exceeds the boundary');
  }
  if (eocd + 22 + commentLength !== bytes.length
    || centralOffset + centralSize !== eocd
    || centralOffset < 0) {
    throw new AdapterFailure('invalid_docx', 'DOCX central directory bounds are invalid');
  }
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new AdapterFailure('invalid_docx', 'DOCX central directory entry is invalid');
    }
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > centralOffset + centralSize || diskStart !== 0) {
      throw new AdapterFailure('invalid_docx', 'DOCX central directory entry exceeds its boundary');
    }
    const name = safeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (names.has(name)) throw new AdapterFailure('unsafe_archive', 'DOCX contains duplicate archive paths');
    names.add(name);
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
      throw new AdapterFailure('unsafe_archive', 'Encrypted DOCX entries are rejected');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new AdapterFailure('unsafe_archive', 'Unsupported DOCX compression is rejected');
    }
    if (uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new AdapterFailure('archive_limit_exceeded', 'DOCX entry exceeds the uncompressed-size boundary');
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new AdapterFailure('archive_limit_exceeded', 'DOCX entry has an invalid compression ratio');
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new AdapterFailure('archive_limit_exceeded', 'DOCX entry compression ratio exceeds the boundary');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new AdapterFailure('archive_limit_exceeded', 'DOCX uncompressed size exceeds the boundary');
    }
    const host = madeBy >>> 8;
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixType = unixMode & 0xf000;
    if (host === 3 && unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) {
      throw new AdapterFailure('unsafe_archive', 'DOCX links and special files are rejected');
    }
    entries.push({
      name, flags, compressionMethod, crc32: expectedCrc, compressedSize, uncompressedSize,
      localHeaderOffset, externalAttributes, madeBy,
    });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new AdapterFailure('invalid_docx', 'DOCX central directory size does not match its entries');
  }
  return entries;
}

function extractZipEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset < 0 || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new AdapterFailure('invalid_docx', 'DOCX local header is invalid');
  }
  const localFlags = bytes.readUInt16LE(offset + 6);
  const localCompression = bytes.readUInt16LE(offset + 8);
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const localName = safeZipName(bytes.subarray(offset + 30, offset + 30 + nameLength));
  if (localName !== entry.name || localCompression !== entry.compressionMethod || localFlags !== entry.flags) {
    throw new AdapterFailure('invalid_docx', 'DOCX local and central headers disagree');
  }
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataOffset < 0 || dataEnd > bytes.length) {
    throw new AdapterFailure('invalid_docx', 'DOCX entry data exceeds the archive');
  }
  const compressed = bytes.subarray(dataOffset, dataEnd);
  let output: Buffer;
  try {
    output = entry.compressionMethod === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES });
  } catch {
    throw new AdapterFailure('invalid_docx', 'DOCX entry decompression failed');
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
    throw new AdapterFailure('invalid_docx', 'DOCX entry integrity check failed');
  }
  return output;
}

function safeXml(bytes: Buffer, label: string): string {
  if (bytes.length > MAX_XML_CHARS) throw new AdapterFailure('archive_limit_exceeded', `${label} exceeds the XML boundary`);
  const xml = bytes.toString('utf8');
  if (xml.includes('\ufffd') || /<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new AdapterFailure('unsafe_archive', `${label} contains unsafe XML constructs`);
  }
  return xml;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/giu, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const hex = entity.match(/^&#x([a-f0-9]+);$/iu);
    const decimal = entity.match(/^&#(\d+);$/u);
    const codePoint = hex ? Number.parseInt(hex[1] ?? '', 16) : decimal ? Number.parseInt(decimal[1] ?? '', 10) : -1;
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new AdapterFailure('unsafe_archive', 'DOCX text contains an invalid XML entity');
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[A-Za-z#][^;\s]{0,32};/gu, () => {
    throw new AdapterFailure('unsafe_archive', 'DOCX text contains an unknown XML entity');
  });
}

function attribute(tag: string, localName: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu');
  const match = tag.match(pattern);
  return match ? decodeXmlText(match[1] ?? match[2] ?? '') : null;
}

function numericAttribute(tag: string, localName: string): number | null {
  const raw = attribute(tag, localName);
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function extractText(xml: string): string {
  const parts: string[] = [];
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/giu;
  for (const match of xml.matchAll(tokenPattern)) {
    if (match[1] !== undefined) parts.push(decodeXmlText(match[1]));
    else parts.push(' ');
  }
  return parts.join('').replace(/\s+/gu, ' ').trim();
}

function ensureRelationshipsAreInternal(entries: ReadonlyMap<string, Buffer>): void {
  for (const [name, bytes] of entries) {
    if (!name.endsWith('.rels')) continue;
    const xml = safeXml(bytes, 'DOCX relationships');
    for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*\/?\s*>/giu)) {
      const tag = match[0];
      const targetMode = attribute(tag, 'TargetMode');
      const targetRaw = attribute(tag, 'Target') ?? '';
      let target = targetRaw;
      try { target = decodeURIComponent(targetRaw); } catch { /* malformed percent syntax is rejected below */ }
      if (targetMode?.toLocaleLowerCase('en-US') === 'external'
        || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
        || target.startsWith('/')
        || target.startsWith('\\')
        || target.includes('\\')
        || target.split('/').some((segment) => segment === '..' || segment === '.')) {
        throw new AdapterFailure('unsafe_archive', 'DOCX contains an external or traversing relationship');
      }
    }
  }
}

function parseDocxStyles(stylesXml: string | null): FundingStyleObservation[] {
  if (stylesXml === null) return [];
  const styles: FundingStyleObservation[] = [];
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/giu)) {
    const startTag = match[1] ?? '';
    const body = match[2] ?? '';
    const styleId = attribute(startTag, 'styleId');
    if (!styleId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(styleId)) continue;
    const fontTag = body.match(/<w:rFonts\b[^>]*\/?\s*>/iu)?.[0] ?? '';
    const sizeTag = body.match(/<w:sz\b[^>]*\/?\s*>/iu)?.[0] ?? '';
    const alignTag = body.match(/<w:jc\b[^>]*\/?\s*>/iu)?.[0] ?? '';
    const spacingTag = body.match(/<w:spacing\b[^>]*\/?\s*>/iu)?.[0] ?? '';
    const fontFamily = attribute(fontTag, 'eastAsia') ?? attribute(fontTag, 'ascii') ?? null;
    const halfPoints = numericAttribute(sizeTag, 'val');
    const lineTwips = numericAttribute(spacingTag, 'line');
    const beforeTwips = numericAttribute(spacingTag, 'before');
    const afterTwips = numericAttribute(spacingTag, 'after');
    const alignment = attribute(alignTag, 'val');
    styles.push({
      styleId,
      fontFamily,
      fontSizePt: halfPoints !== null && halfPoints > 0 ? halfPoints / 2 : null,
      fontWeight: /<w:b(?:\s|\/|>)/iu.test(body) ? 'bold' : null,
      italic: /<w:i(?:\s|\/|>)/iu.test(body) ? true : null,
      alignment: alignment === 'left' || alignment === 'center' || alignment === 'right' || alignment === 'justify'
        ? alignment : null,
      lineSpacingPt: lineTwips !== null && lineTwips > 0 ? lineTwips / 20 : null,
      paragraphBeforePt: beforeTwips !== null && beforeTwips >= 0 ? beforeTwips / 20 : null,
      paragraphAfterPt: afterTwips !== null && afterTwips >= 0 ? afterTwips / 20 : null,
    });
  }
  return styles;
}

function inspectDocx(documentXml: string, stylesXml: string | null): DocxInspection {
  const paragraphs: DocxParagraphDigest[] = [];
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/giu)) {
    const body = match[1] ?? '';
    const text = extractText(body);
    if (text.length === 0) continue;
    const styleTag = body.match(/<w:pStyle\b[^>]*\/?\s*>/iu)?.[0] ?? '';
    paragraphs.push({ textDigest: sha256(text), styleId: attribute(styleTag, 'val') });
  }
  const tables: DocxTableDigest[] = [];
  for (const tableMatch of documentXml.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/giu)) {
    const tableXml = tableMatch[1] ?? '';
    const rows = [...tableXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/giu)];
    let columns = 0;
    const cellTextDigests: string[] = [];
    for (const row of rows) {
      const cells = [...(row[1] ?? '').matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/giu)];
      columns = Math.max(columns, cells.length);
      for (const cell of cells) cellTextDigests.push(sha256(extractText(cell[1] ?? '')));
    }
    tables.push({ rows: rows.length, columns, cellTextDigests });
  }
  const pageSizeTag = documentXml.match(/<w:pgSz\b[^>]*\/?\s*>/iu)?.[0] ?? '';
  const marginTag = documentXml.match(/<w:pgMar\b[^>]*\/?\s*>/iu)?.[0] ?? '';
  const widthTwips = numericAttribute(pageSizeTag, 'w');
  const heightTwips = numericAttribute(pageSizeTag, 'h');
  const marginValues = ['top', 'right', 'bottom', 'left'].map((name) => numericAttribute(marginTag, name));
  const pageSetup = widthTwips !== null && widthTwips > 0
    && heightTwips !== null && heightTwips > 0
    && marginValues.every((value) => value !== null && value >= 0)
    ? {
        widthPt: widthTwips / 20,
        heightPt: heightTwips / 20,
        marginsPt: {
          top: (marginValues[0] ?? 0) / 20,
          right: (marginValues[1] ?? 0) / 20,
          bottom: (marginValues[2] ?? 0) / 20,
          left: (marginValues[3] ?? 0) / 20,
        },
      }
    : null;
  const explicitPageBreakCount = [...documentXml.matchAll(/<w:br\b[^>]*w:type\s*=\s*["']page["'][^>]*\/>/giu)].length
    + [...documentXml.matchAll(/<w:lastRenderedPageBreak\b[^>]*\/>/giu)].length;
  return {
    paragraphs,
    tables,
    styles: parseDocxStyles(stylesXml),
    explicitPageBreakCount,
    pageSetup,
  };
}

function inspectDocxArchive(bytes: Buffer): FundingDocxStructureSummary {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new AdapterFailure('invalid_docx', 'DOCX ZIP signature is invalid');
  }
  const entries = parseZipEntries(bytes);
  const extracted = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (/^(?:word\/vbaProject\.bin|word\/activeX\/|word\/embeddings\/)/iu.test(entry.name)) {
      throw new AdapterFailure('unsafe_archive', 'DOCX active or embedded content is rejected');
    }
    if (entry.name === '[Content_Types].xml'
      || entry.name === 'word/document.xml'
      || entry.name === 'word/styles.xml'
      || entry.name.endsWith('.rels')) {
      extracted.set(entry.name, extractZipEntry(bytes, entry));
    }
  }
  const contentTypesBytes = extracted.get('[Content_Types].xml');
  const documentBytes = extracted.get('word/document.xml');
  if (!contentTypesBytes || !documentBytes) {
    throw new AdapterFailure('invalid_docx', 'DOCX required document parts are missing');
  }
  const contentTypes = decodeXmlText(safeXml(contentTypesBytes, 'DOCX content types'));
  if (/macroEnabled|vnd\.ms-office\.vbaProject/iu.test(contentTypes)) {
    throw new AdapterFailure('unsafe_archive', 'Macro-enabled Word packages are rejected');
  }
  if (!/wordprocessingml\.document\.main\+xml/iu.test(contentTypes)) {
    throw new AdapterFailure('invalid_docx', 'DOCX main document content type is invalid');
  }
  ensureRelationshipsAreInternal(extracted);
  const documentXml = safeXml(documentBytes, 'DOCX main document');
  const stylesBytes = extracted.get('word/styles.xml');
  const stylesXml = stylesBytes ? safeXml(stylesBytes, 'DOCX styles') : null;
  const inspection = inspectDocx(documentXml, stylesXml);
  const summaryPayload = {
    paragraphs: inspection.paragraphs,
    tables: inspection.tables,
    styles: inspection.styles,
    explicitPageBreakCount: inspection.explicitPageBreakCount,
    pageSetup: inspection.pageSetup,
  };
  return {
    sourceDigest: sha256(bytes),
    paragraphCount: inspection.paragraphs.length,
    tableCount: inspection.tables.length,
    styleCount: inspection.styles.length,
    explicitPageBreakCount: inspection.explicitPageBreakCount,
    pageSetupObserved: inspection.pageSetup !== null,
    structureDigest: sha256(canonicalJson(summaryPayload)),
  };
}

/**
 * DOCX 申报书观察：Word 没有可信的最终渲染坐标，因此这里按单列文档流合成
 * 确定性的顺序布局（x/宽度取页边距，y 按段落高度累加、溢出换页）。坐标只用于
 * 满足引擎契约与保持块顺序，不代表渲染位置；文本、样式与表格结构均为真实解析。
 */
function observeDocx(
  bytes: Buffer,
  request: FundingTemplateObservationFileRequest,
): FundingTemplateObservationDocument {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new AdapterFailure('invalid_docx', 'DOCX ZIP signature is invalid');
  }
  const entries = parseZipEntries(bytes);
  const extracted = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (/^(?:word\/vbaProject\.bin|word\/activeX\/|word\/embeddings\/)/iu.test(entry.name)) {
      throw new AdapterFailure('unsafe_archive', 'DOCX active or embedded content is rejected');
    }
    if (entry.name === '[Content_Types].xml' || entry.name === 'word/document.xml' || entry.name === 'word/styles.xml' || entry.name.endsWith('.rels')) {
      extracted.set(entry.name, extractZipEntry(bytes, entry));
    }
  }
  const contentTypesBytes = extracted.get('[Content_Types].xml');
  const documentBytes = extracted.get('word/document.xml');
  if (!contentTypesBytes || !documentBytes) {
    throw new AdapterFailure('invalid_docx', 'DOCX required document parts are missing');
  }
  ensureRelationshipsAreInternal(extracted);
  const contentTypes = decodeXmlText(safeXml(contentTypesBytes, 'DOCX content types'));
  if (/macroEnabled|vnd\.ms-office\.vbaProject/iu.test(contentTypes)) {
    throw new AdapterFailure('unsafe_archive', 'Macro-enabled Word packages are rejected');
  }
  if (!/wordprocessingml\.document\.main\+xml/iu.test(contentTypes)) {
    throw new AdapterFailure('invalid_docx', 'DOCX main document content type is invalid');
  }
  const documentXml = safeXml(documentBytes, 'DOCX main document');
  const stylesBytes = extracted.get('word/styles.xml');
  const stylesXml = stylesBytes ? safeXml(stylesBytes, 'DOCX styles') : null;
  const inspection = inspectDocx(documentXml, stylesXml);
  const docStyles = inspection.styles;
  const widthPt = inspection.pageSetup?.widthPt ?? 595;
  const heightPt = inspection.pageSetup?.heightPt ?? 842;
  const marginsPt = inspection.pageSetup?.marginsPt ?? { top: 72, right: 72, bottom: 72, left: 72 };
  if (marginsPt.left + marginsPt.right >= widthPt || marginsPt.top + marginsPt.bottom >= heightPt) {
    throw new AdapterFailure('observation_invalid', 'DOCX page setup margins exceed the page');
  }

  const styleIdFor = (docStyleId: string | null): string | null => {
    if (!docStyleId) return null;
    return `docx-style-${sha256(docStyleId).slice(0, 24)}`;
  };
  const styleMap = new Map<string, FundingStyleObservation>();
  const styleByIdHash = new Map<string, FundingStyleObservation>();
  for (const style of docStyles) {
    const safeId = styleIdFor(style.styleId) ?? `docx-style-${sha256(style.styleId).slice(0, 24)}`;
    styleMap.set(safeId, { ...style, styleId: safeId });
    styleByIdHash.set(style.styleId, styleMap.get(safeId)!);
  }
  const fontSizeFor = (docStyleId: string | null): number => styleByIdHash.get(docStyleId ?? '')?.fontSizePt ?? 12;

  const contentWidth = Math.max(40, widthPt - marginsPt.left - marginsPt.right);
  const contentBottom = heightPt - marginsPt.bottom;
  const pages: FundingTemplateObservationDocument['pages'] = [
    { pageNumber: 1, widthPt, heightPt, observedMarginsPt: marginsPt },
  ];
  const blocks: FundingTemplateObservationDocument['blocks'] = [];
  let pageNumber = 1;
  let cursorY = marginsPt.top;
  let ordinal = 0;
  let blockCount = 0;

  const advancePage = (): void => {
    pageNumber += 1;
    if (pageNumber > FUNDING_TEMPLATE_LIMITS.pages) {
      throw new AdapterFailure('pdf_limit_exceeded', 'DOCX layout exceeds the observation page boundary');
    }
    pages.push({ pageNumber, widthPt, heightPt, observedMarginsPt: marginsPt });
    cursorY = marginsPt.top;
  };
  const pushParagraph = (text: string, docStyleId: string | null, fontSizePt: number, breaksPage: boolean): void => {
    if (breaksPage && cursorY > marginsPt.top) advancePage();
    const lineHeight = Math.max(14, fontSizePt * 1.5);
    const lines = Math.max(1, Math.ceil(text.length / 42));
    let height = lineHeight * lines;
    if (cursorY + height > contentBottom && cursorY > marginsPt.top) {
      // 块高于整页时截断到本页（不虚构跨页坐标），其余内容继续流式布局。
      height = Math.max(lineHeight, contentBottom - cursorY);
    }
    const bounds = safeBounds(marginsPt.left, cursorY, contentWidth, height, widthPt, heightPt);
    if (!bounds) return;
    cursorY = bounds.y + bounds.height;
    const styleId = styleIdFor(docStyleId);
    blocks.push({
      kind: 'paragraph',
      blockId: `docx-p${pageNumber}-${ordinal + 1}`,
      pageNumber,
      ordinal,
      bounds,
      text: text.slice(0, FUNDING_TEMPLATE_LIMITS.textCharsPerBlock),
      contentRole: inferContentRole(text, fontSizePt, 12),
      styleId,
    });
    ordinal += 1;
    blockCount += 1;
    if (blockCount > FUNDING_TEMPLATE_LIMITS.blocks) {
      throw new AdapterFailure('pdf_limit_exceeded', 'DOCX block count exceeds the observation boundary');
    }
  };

  // 单遍扫描 document.xml 的顶层段落与表格，保持文档顺序。
  const body = outerXmlSection(documentXml, 'w:body');
  let cursor = body ? body.indexOf('>') + 1 : 0;
  const bodyEnd = body ? body.lastIndexOf('</w:body>') : 0;
  while (cursor > 0 && cursor < bodyEnd) {
    const next = body!.indexOf('<w:', cursor);
    if (next < 0 || next >= bodyEnd) break;
    const name = body!.slice(next).match(/^<w:(p|tbl)\b/u)?.[1];
    if (!name) {
      const tagEnd = body!.indexOf('>', next);
      cursor = tagEnd < 0 ? bodyEnd : tagEnd + 1;
      continue;
    }
    const end = xmlElementEnd(body!, next, `w:${name}`);
    if (end < 0) break;
    const elementXml = body!.slice(next, end);
    cursor = end;
    if (name === 'p') {
      const text = extractText(elementXml);
      if (text.length === 0) continue;
      const docStyleId = attribute(elementXml.match(/<w:pStyle\b[^>]*\/?\s*>/iu)?.[0] ?? '', 'val');
      const fontSizePt = fontSizeFor(docStyleId);
      const breaksPage = /<w:br\b[^>]*w:type\s*=\s*["']page["']/iu.test(elementXml);
      pushParagraph(text, docStyleId, fontSizePt, breaksPage);
      continue;
    }
    // 表格：真实解析行列与单元格文本，坐标按行高合成，单元格 bounds 置空（契约允许）。
    const rows = [...elementXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/giu)];
    if (rows.length === 0) continue;
    interface PendingCell { rowIndex: number; columnIndex: number; text: string; docStyleId: string | null }
    const pendingCells: PendingCell[] = [];
    let columnCount = 0;
    rows.forEach((rowMatch, rowIndex) => {
      const cells = [...(rowMatch[1] ?? '').matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/giu)];
      columnCount = Math.max(columnCount, cells.length);
      cells.forEach((cellMatch, columnIndex) => {
        const cellXml = cellMatch[1] ?? '';
        const text = extractText(cellXml);
        const docStyleId = attribute(cellXml.match(/<w:pStyle\b[^>]*\/?\s*>/iu)?.[0] ?? '', 'val');
        pendingCells.push({ rowIndex, columnIndex, text, docStyleId });
      });
    });
    if (pendingCells.length === 0 || pendingCells.length > FUNDING_TEMPLATE_LIMITS.cellsPerTable) continue;
    if (cursorY + rows.length * 24 > contentBottom && cursorY > marginsPt.top) advancePage();
    const tableHeight = Math.min(rows.length * 24, Math.max(24, contentBottom - cursorY));
    const tableBounds = safeBounds(marginsPt.left, cursorY, contentWidth, tableHeight, widthPt, heightPt);
    if (!tableBounds) continue;
    cursorY = tableBounds.y + tableBounds.height;
    blocks.push({
      kind: 'table',
      blockId: `docx-t${pageNumber}-${ordinal + 1}`,
      pageNumber,
      ordinal,
      bounds: tableBounds,
      rowCount: rows.length,
      columnCount: Math.max(1, columnCount),
      cells: pendingCells.map((cell) => ({
        rowIndex: cell.rowIndex,
        columnIndex: cell.columnIndex,
        rowSpan: 1,
        columnSpan: 1,
        text: cell.text.slice(0, FUNDING_TEMPLATE_LIMITS.textCharsPerBlock),
        contentRole: inferContentRole(cell.text, fontSizeFor(cell.docStyleId), 12),
        styleId: styleIdFor(cell.docStyleId),
        bounds: null,
      })),
    });
    ordinal += 1;
    blockCount += 1;
    if (blockCount > FUNDING_TEMPLATE_LIMITS.blocks) {
      throw new AdapterFailure('pdf_limit_exceeded', 'DOCX block count exceeds the observation boundary');
    }
  }

  if (blocks.length === 0) {
    throw new AdapterFailure('insufficient_observations', 'DOCX contains no observable text blocks');
  }
  const candidate: FundingTemplateObservationDocument = {
    contractVersion: 1,
    documentId: request.documentId,
    sourceFormat: 'docx',
    sourceDigest: sha256(bytes),
    extractedAt: request.extractedAt,
    extractor: { name: 'metis-docx-observation-adapter', version: ADAPTER_VERSION },
    pageCount: pageNumber,
    pages,
    styles: [...styleMap.values()],
    blocks,
  };
  const parsed = FundingTemplateObservationDocumentSchema.safeParse(candidate);
  if (!parsed.success) throw new AdapterFailure('observation_invalid', 'DOCX observations do not satisfy the engine contract');
  return parsed.data;
}

/** 取 xml 中 name 元素的完整外层片段（自 start 起），找不到返回 null。 */
function outerXmlSection(xml: string, name: string): string | null {
  const start = xml.indexOf(`<${name}`);
  if (start < 0) return null;
  const end = xmlElementEnd(xml, start, name);
  return end < 0 ? null : xml.slice(start, end);
}

/** 自 start 起找到 name 元素的闭合位置（含闭合标签），容错自闭合与嵌套。 */
function xmlElementEnd(xml: string, start: number, name: string): number {
  const matcher = new RegExp(`<${name}\\b[^>]*?(?:/>|>)|</${name}>`, 'gu');
  matcher.lastIndex = start;
  let depth = 0;
  for (let match = matcher.exec(xml); match; match = matcher.exec(xml)) {
    if (match[0].startsWith(`</${name}`)) {
      depth -= 1;
      if (depth === 0) return matcher.lastIndex;
    } else if (!/\/>$/u.test(match[0])) {
      depth += 1;
    }
  }
  return -1;
}

export async function observeFundingTemplateFile(
  rawRequest: unknown,
): Promise<FundingTemplateObservationAdapterResult> {
  const requestCheck = FundingTemplateObservationFileRequestSchema.safeParse(rawRequest);
  if (!requestCheck.success) {
    return { ok: false, code: 'invalid_request', issues: ['Observation request is invalid'] };
  }
  const request: FundingTemplateObservationFileRequest = requestCheck.data;
  try {
    const stable = await stableRead(request);
    if (stable.extension === '.pdf') {
      const document = await observePdf(stable.bytes, request);
      return { ok: true, document };
    }
    if (stable.extension === '.docx') {
      const document = observeDocx(stable.bytes, request);
      return { ok: true, document };
    }
    throw new AdapterFailure(
      'docx_layout_unobservable',
      'Unsupported template extension',
    );
  } catch (error) {
    if (error instanceof AdapterFailure) {
      return {
        ok: false,
        code: error.code,
        issues: [error.safeIssue],
        ...(error.docxStructure ? { docxStructure: error.docxStructure } : {}),
      };
    }
    return { ok: false, code: 'observation_invalid', issues: ['Template observation failed without exposing document content'] };
  }
}
