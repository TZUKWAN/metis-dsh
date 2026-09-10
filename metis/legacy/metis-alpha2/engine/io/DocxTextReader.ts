/**
 * DocxTextReader — 零依赖的 .docx 正文文本提取。
 *
 * .docx 是 ZIP 包，正文位于 word/document.xml。这里用 Central Directory
 * 精确定位条目（避开 local header 的 data descriptor 歧义），inflateRaw
 * 解压后按 <w:p>/<w:t> 还原段落文本。仅供参考材料导入使用，不做格式保留。
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD 最小 22 字节，注释最长 65535。
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65_536); offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('docx_zip_invalid');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryBuffer(buffer: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error('docx_local_header_invalid');
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const dataStart = header + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`docx_unsupported_method_${entry.method}`);
}

/** 从 word/document.xml 的 XML 文本中还原段落。 */
export function extractParagraphsFromDocumentXml(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/gu)) {
    const runs = [...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
      .map((run) => run[1] ?? '')
      .join('');
    const text = decodeXmlEntities(runs).trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&');
}

/** 读取 .docx 文件正文文本（以空行分段）。失败抛出带 docx_ 前缀的错误。 */
export function readDocxText(filePath: string, fs: { readFileSync(path: string): Buffer } = nodeFs): string {
  const archive = fs.readFileSync(filePath);
  const entries = readCentralDirectory(archive);
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml');
  if (!documentEntry) throw new Error('docx_document_missing');
  const xml = readEntryBuffer(archive, documentEntry).toString('utf8');
  return extractParagraphsFromDocumentXml(xml).join('\n\n');
}

import * as nodeFs from 'node:fs';
