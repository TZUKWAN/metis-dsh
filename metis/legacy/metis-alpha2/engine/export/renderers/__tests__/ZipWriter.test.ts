import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { ZipWriter } from '../ZipWriter.js';
import { crc32 } from '../Crc32.js';

describe('ZipWriter', () => {
  it('produces a valid ZIP with PK signature', () => {
    const zip = new ZipWriter();
    zip.addFile('hello.txt', Buffer.from('Hello, World!', 'utf8'));
    const buf = zip.toBuffer();
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
  });

  it('round-trips: inflateRaw recovers original content', () => {
    const content = 'Test content for round-trip verification.';
    const zip = new ZipWriter();
    zip.addFile('test.txt', Buffer.from(content, 'utf8'));
    const buf = zip.toBuffer();

    // Find the local file header data and decompress
    // Local file header starts at offset 0: signature(4) + version(2) + flag(2) + method(2) + time(2) + date(2) + crc(4) + compSize(4) + uncompSize(4) + nameLen(2) + extraLen(2) = 30 bytes
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const dataOffset = 30 + nameLen + extraLen;
    const compSize = buf.readUInt32LE(18);
    const method = buf.readUInt16LE(8);

    const compressedData = buf.subarray(dataOffset, dataOffset + compSize);
    let decompressed: Buffer;
    if (method === 8) {
      decompressed = inflateRawSync(compressedData);
    } else {
      decompressed = compressedData; // stored
    }
    expect(decompressed.toString('utf8')).toBe(content);
  });

  it('rejects empty archive', () => {
    const zip = new ZipWriter();
    expect(() => zip.toBuffer()).toThrow();
  });

  it('handles multiple files', () => {
    const zip = new ZipWriter();
    zip.addFile('a.txt', Buffer.from('aaa', 'utf8'));
    zip.addFile('b.txt', Buffer.from('bbb', 'utf8'));
    const buf = zip.toBuffer();
    expect(buf.length).toBeGreaterThan(60);
    // Should contain both filenames
    const asText = buf.toString('latin1');
    expect(asText).toContain('a.txt');
    expect(asText).toContain('b.txt');
  });

  it('rejects backslash in entry names', () => {
    const zip = new ZipWriter();
    expect(() => zip.addFile('dir\\file.txt', Buffer.from('x'))).toThrow();
  });
});

describe('crc32', () => {
  it('computes CRC32 of known data correctly', () => {
    // CRC32 of "123456789" is 0xCBF43926
    const data = Buffer.from('123456789', 'ascii');
    expect(crc32(data)).toBe(0xCBF43926);
  });

  it('returns 0 for empty data', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
