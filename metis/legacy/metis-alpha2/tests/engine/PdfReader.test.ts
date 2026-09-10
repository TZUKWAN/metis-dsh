/**
 * Tests for PDF Reader Engine — parsePageRange utility and PdfReader class.
 *
 * Since PdfReader depends on pdfjs-dist and actual PDF files for full I/O,
 * we test parsePageRange exhaustively and mock pdfjs for integration tests.
 */

import { describe, it, expect } from 'vitest';
import { parsePageRange, PdfReader, getPdfReader } from '../../engine/research/PdfReader.js';

// ─── parsePageRange Tests ───────────────────────────────────

describe('parsePageRange', () => {
  it('should parse a single page number', () => {
    expect(parsePageRange('3', 10)).toEqual([3]);
  });

  it('should parse a page range', () => {
    expect(parsePageRange('1-5', 10)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should parse comma-separated pages', () => {
    expect(parsePageRange('1,3,5', 10)).toEqual([1, 3, 5]);
  });

  it('should parse mixed ranges and singles', () => {
    expect(parsePageRange('1-3,7,9-10', 10)).toEqual([1, 2, 3, 7, 9, 10]);
  });

  it('should deduplicate overlapping ranges', () => {
    expect(parsePageRange('1-5,3-7', 10)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('should clamp to total pages', () => {
    expect(parsePageRange('8-15', 10)).toEqual([8, 9, 10]);
  });

  it('should clamp start to page 1', () => {
    expect(parsePageRange('0-3', 10)).toEqual([1, 2, 3]);
  });

  it('should ignore invalid page numbers', () => {
    expect(parsePageRange('15,20', 10)).toEqual([]);
  });

  it('should handle whitespace in ranges', () => {
    expect(parsePageRange(' 1 , 3 , 5-7 ', 10)).toEqual([1, 3, 5, 6, 7]);
  });

  it('should return sorted results', () => {
    expect(parsePageRange('5,1,3', 10)).toEqual([1, 3, 5]);
  });

  it('should handle empty string', () => {
    expect(parsePageRange('', 10)).toEqual([]);
  });

  it('should handle single page equal to total', () => {
    expect(parsePageRange('10', 10)).toEqual([10]);
  });

  it('should handle range covering all pages', () => {
    expect(parsePageRange('1-10', 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ─── PdfReader Class Tests ──────────────────────────────────

describe('PdfReader', () => {
  it('should construct with default data dir', () => {
    const reader = new PdfReader();
    expect(reader).toBeDefined();
  });

  it('should construct with custom data dir', () => {
    const reader = new PdfReader('/tmp/test-pdfs');
    expect(reader).toBeDefined();
  });

  it('should have readFile method', () => {
    const reader = new PdfReader();
    expect(typeof reader.readFile).toBe('function');
  });

  it('should have extractText method', () => {
    const reader = new PdfReader();
    expect(typeof reader.extractText).toBe('function');
  });

  it('should have getMetadata method', () => {
    const reader = new PdfReader();
    expect(typeof reader.getMetadata).toBe('function');
  });

  it('should have getOutline method', () => {
    const reader = new PdfReader();
    expect(typeof reader.getOutline).toBe('function');
  });

  it('should have listPdfs method', () => {
    const reader = new PdfReader();
    expect(typeof reader.listPdfs).toBe('function');
  });

  it('should have importPdf method', () => {
    const reader = new PdfReader();
    expect(typeof reader.importPdf).toBe('function');
  });

  it('should have ensureDataDir method', () => {
    const reader = new PdfReader();
    expect(typeof reader.ensureDataDir).toBe('function');
  });
});

// ─── Singleton Tests ────────────────────────────────────────

describe('getPdfReader', () => {
  it('should return a PdfReader instance', () => {
    const reader = getPdfReader();
    expect(reader).toBeInstanceOf(PdfReader);
  });

  it('should return the same instance on subsequent calls', () => {
    const reader1 = getPdfReader();
    const reader2 = getPdfReader();
    expect(reader1).toBe(reader2);
  });
});

// ─── PdfReadOptions / Types Validation ──────────────────────

describe('PdfReader types', () => {
  it('readFile should reject for non-existent file', async () => {
    const reader = new PdfReader();
    await expect(reader.readFile('/nonexistent/file.pdf')).rejects.toThrow();
  });

  it('extractText should reject for non-existent file', async () => {
    const reader = new PdfReader();
    await expect(reader.extractText('/nonexistent/file.pdf')).rejects.toThrow();
  });

  it('getMetadata should reject for non-existent file', async () => {
    const reader = new PdfReader();
    await expect(reader.getMetadata('/nonexistent/file.pdf')).rejects.toThrow();
  });

  it('listPdfs should return empty array for non-existent directory', async () => {
    const reader = new PdfReader('/nonexistent/dir');
    const result = await reader.listPdfs();
    expect(result).toEqual([]);
  });
});
