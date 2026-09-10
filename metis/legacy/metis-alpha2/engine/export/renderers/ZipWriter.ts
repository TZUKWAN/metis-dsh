/**
 * Minimal ZIP archive writer using only Node.js built-in `zlib`.
 *
 * Produces spec-compliant ZIP files (PKZIP / APPNOTE 6.3.10) that are
 * accepted by Microsoft Word, LibreOffice, and other OOXML consumers.
 *
 * Features:
 * - DEFLATE compression (method 8) via `zlib.deflateRawSync`
 * - STORE mode (method 0) as fallback for very small or incompressible data
 * - CRC-32 checksums per entry
 * - Local file headers + central directory + end-of-central-directory record
 * - Deterministic output (no timestamps) for reproducible builds
 *
 * This module does NOT depend on any npm package — only `node:zlib`.
 */

import { deflateRawSync } from 'node:zlib';
import { crc32 } from './Crc32.js';

export interface ZipFileEntry {
  /** Path inside the archive, using forward slashes (e.g. "word/document.xml"). */
  name: string;
  /** Raw file content. */
  data: Uint8Array;
}

// ── ZIP format constants (APPNOTE 4.4.x) ──────────────────────────

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_HEADER_SIGNATURE = 0x02014b50;
const END_CENTRAL_DIR_SIGNATURE = 0x06054b50;

const VERSION_NEEDED = 20; // 2.0 — supports deflate
const VERSION_MADE_BY = 20;

const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

const GENERAL_PURPOSE_FLAG = 0;

// Fixed DOS timestamp: 2025-01-01 00:00:00 — deterministic for reproducibility.
// DOS date: ((year - 1980) << 9) | (month << 5) | day
// DOS time: (hour << 11) | (minute << 5) | (second / 2)
const DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = (0 << 11) | (0 << 5) | 0;

const DEFLATE_THRESHOLD = 32; // Don't bother compressing tiny payloads

// ── Buffer helpers ────────────────────────────────────────────────

function writeUint16LE(buf: number[], value: number): void {
  buf.push(value & 0xFF, (value >>> 8) & 0xFF);
}

function writeUint32LE(buf: number[], value: number): void {
  buf.push(
    value & 0xFF,
    (value >>> 8) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 24) & 0xFF,
  );
}

/**
 * Deterministic ZIP archive writer.
 *
 * Usage:
 * ```ts
 * const zip = new ZipWriter();
 * zip.addFile('word/document.xml', Buffer.from(xml, 'utf8'));
 * const archive = zip.toBuffer();
 * ```
 */
export class ZipWriter {
  private readonly entries: ZipFileEntry[] = [];

  addFile(name: string, data: Uint8Array): void {
    if (name.length === 0) {
      throw new Error('ZIP entry name must not be empty');
    }
    if (name.includes('\\')) {
      throw new Error(`ZIP entry name must use forward slashes: ${name}`);
    }
    this.entries.push({ name, data });
  }

  /**
   * Produce the complete ZIP archive as a Buffer.
   *
   * Throws if no files have been added (an empty ZIP is never useful
   * and likely indicates a bug in the caller).
   */
  toBuffer(): Buffer {
    if (this.entries.length === 0) {
      throw new Error('ZIP archive must contain at least one file');
    }

    const localParts: Buffer[] = [];
    const centralEntries: {
      name: string;
      crc: number;
      method: number;
      compressedSize: number;
      uncompressedSize: number;
      localHeaderOffset: number;
    }[] = [];

    let currentOffset = 0;

    for (const entry of this.entries) {
      const nameBytes = Buffer.from(entry.name, 'utf8');
      const crc = crc32(entry.data);

      let compressed: Buffer;
      let method: number;

      if (entry.data.length >= DEFLATE_THRESHOLD) {
        const deflated = deflateRawSync(Buffer.from(entry.data));
        // Only use deflate if it actually saves space.
        if (deflated.length < entry.data.length) {
          compressed = deflated;
          method = METHOD_DEFLATE;
        } else {
          compressed = Buffer.from(entry.data);
          method = METHOD_STORE;
        }
      } else {
        compressed = Buffer.from(entry.data);
        method = METHOD_STORE;
      }

      // Local file header (30 bytes + name)
      const lfh: number[] = [];
      writeUint32LE(lfh, LOCAL_FILE_HEADER_SIGNATURE);
      writeUint16LE(lfh, VERSION_NEEDED);
      writeUint16LE(lfh, GENERAL_PURPOSE_FLAG);
      writeUint16LE(lfh, method);
      writeUint16LE(lfh, DOS_TIME);
      writeUint16LE(lfh, DOS_DATE);
      writeUint32LE(lfh, crc);
      writeUint32LE(lfh, compressed.length);
      writeUint32LE(lfh, entry.data.length);
      writeUint16LE(lfh, nameBytes.length);
      writeUint16LE(lfh, 0); // extra field length

      const lfhBuffer = Buffer.from(lfh);
      localParts.push(lfhBuffer, nameBytes, compressed);

      centralEntries.push({
        name: entry.name,
        crc,
        method,
        compressedSize: compressed.length,
        uncompressedSize: entry.data.length,
        localHeaderOffset: currentOffset,
      });

      currentOffset += lfhBuffer.length + nameBytes.length + compressed.length;
    }

    // Central directory
    const centralParts: Buffer[] = [];
    let centralDirSize = 0;

    for (const ce of centralEntries) {
      const nameBytes = Buffer.from(ce.name, 'utf8');
      const cdh: number[] = [];
      writeUint32LE(cdh, CENTRAL_DIR_HEADER_SIGNATURE);
      writeUint16LE(cdh, VERSION_MADE_BY);
      writeUint16LE(cdh, VERSION_NEEDED);
      writeUint16LE(cdh, GENERAL_PURPOSE_FLAG);
      writeUint16LE(cdh, ce.method);
      writeUint16LE(cdh, DOS_TIME);
      writeUint16LE(cdh, DOS_DATE);
      writeUint32LE(cdh, ce.crc);
      writeUint32LE(cdh, ce.compressedSize);
      writeUint32LE(cdh, ce.uncompressedSize);
      writeUint16LE(cdh, nameBytes.length);
      writeUint16LE(cdh, 0); // extra field length
      writeUint16LE(cdh, 0); // comment length
      writeUint16LE(cdh, 0); // disk number start
      writeUint16LE(cdh, 0); // internal attrs
      writeUint32LE(cdh, 0); // external attrs
      writeUint32LE(cdh, ce.localHeaderOffset);

      const cdhBuffer = Buffer.from(cdh);
      centralParts.push(cdhBuffer, nameBytes);
      centralDirSize += cdhBuffer.length + nameBytes.length;
    }

    const centralDirOffset = currentOffset;

    // End of central directory record (22 bytes)
    const eocd: number[] = [];
    writeUint32LE(eocd, END_CENTRAL_DIR_SIGNATURE);
    writeUint16LE(eocd, 0); // number of this disk
    writeUint16LE(eocd, 0); // disk where central dir starts
    writeUint16LE(eocd, centralEntries.length);
    writeUint16LE(eocd, centralEntries.length);
    writeUint32LE(eocd, centralDirSize);
    writeUint32LE(eocd, centralDirOffset);
    writeUint16LE(eocd, 0); // comment length

    return Buffer.concat([
      ...localParts,
      ...centralParts,
      Buffer.from(eocd),
    ]);
  }
}
