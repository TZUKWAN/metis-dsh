import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { auditFigures, type FigureAuditResult } from '../FigureAuditor.js';

function makePngBuffer(width: number, height: number): Buffer {
  // Minimal PNG: signature + IHDR + IEND. CRCs are ignored by the reader.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 0; // color type
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makePngChunk('IHDR', ihdrData);
  const iend = makePngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, iend]);
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const chunk = Buffer.concat([typeBuf, data]);
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(0, 0); // reader ignores CRC
  return Buffer.concat([lengthBuf, chunk, crcBuf]);
}

function issueTypes(result: FigureAuditResult, type: string): string[] {
  return result.figures.flatMap((f) => f.issues).filter((i) => i.type === type).map((i) => i.message);
}

describe('FigureAuditor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'figure-audit-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTex(name: string, content: string) {
    await fs.writeFile(path.join(tmpDir, name), content, 'utf-8');
  }

  async function writeFigure(name: string, data: Buffer) {
    await fs.writeFile(path.join(tmpDir, name), data);
  }

  it('detects missing figure files', async () => {
    await writeTex('main.tex', '\\begin{figure}\n\\includegraphics{missing.png}\n\\caption{A}\n\\label{fig:a}\n\\end{figure}\n');
    const result = await auditFigures(tmpDir);
    expect(result.totalIssues).toBeGreaterThanOrEqual(1);
    expect(issueTypes(result, 'missing_file').length).toBe(1);
  });

  it('detects missing caption and label', async () => {
    await writeFigure('plot.png', makePngBuffer(100, 100));
    await writeTex('main.tex', '\\begin{figure}\n\\includegraphics{plot.png}\n\\end{figure}\n');
    const result = await auditFigures(tmpDir);
    expect(issueTypes(result, 'missing_caption').length).toBe(1);
    expect(issueTypes(result, 'missing_label').length).toBe(1);
  });

  it('flags low-resolution bitmaps', async () => {
    await writeFigure('lowres.png', makePngBuffer(100, 100));
    await writeTex(
      'main.tex',
      '\\begin{figure}\n\\includegraphics[width=5cm]{lowres.png}\n\\caption{Screen cap}\n\\label{fig:low}\n\\end{figure}\n',
    );
    const result = await auditFigures(tmpDir);
    expect(issueTypes(result, 'low_resolution_bitmap').length).toBe(1);
  });

  it('suggests vector format for plots/diagrams', async () => {
    await writeFigure('chart.png', makePngBuffer(600, 400));
    await writeTex(
      'main.tex',
      '\\begin{figure}\n\\includegraphics[width=8cm]{chart.png}\n\\caption{Accuracy plot}\n\\label{fig:chart}\n\\end{figure}\n',
    );
    const result = await auditFigures(tmpDir);
    expect(issueTypes(result, 'raster_plot').length).toBe(1);
  });

  it('detects duplicate figure content', async () => {
    const buf = makePngBuffer(50, 50);
    await writeFigure('a.png', buf);
    await writeFigure('b.png', buf);
    await writeTex(
      'main.tex',
      '\\begin{figure}\n\\includegraphics{a.png}\n\\caption{A}\n\\label{fig:a}\n\\end{figure}\n' +
        '\\begin{figure}\n\\includegraphics{b.png}\n\\caption{B}\n\\label{fig:b}\n\\end{figure}\n',
    );
    const result = await auditFigures(tmpDir);
    expect(issueTypes(result, 'duplicate_figure').length).toBe(1);
  });

  it('detects includegraphics outside figure environments', async () => {
    await writeFigure('inline.png', makePngBuffer(10, 10));
    await writeTex('main.tex', '\\includegraphics{inline.png}\n');
    const result = await auditFigures(tmpDir);
    expect(result.figures.length).toBe(1);
    expect(result.figures[0]?.caption).toBeUndefined();
  });

  it('flags unsupported figure formats', async () => {
    await writeFigure('data.txt', Buffer.from('not an image'));
    await writeTex('main.tex', '\\begin{figure}\n\\includegraphics{data.txt}\n\\caption{T}\n\\label{fig:t}\n\\end{figure}\n');
    const result = await auditFigures(tmpDir);
    expect(issueTypes(result, 'unsupported_format').length).toBe(1);
  });

  it('flags raster-in-PDF wrappers', async () => {
    // PDF that only references an image XObject and contains no text operators.
    await writeFigure(
      'wrapped.pdf',
      Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 20 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream\nendobj\n5 0 obj\n<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 0 >>\nstream\nendstream\nendobj\nxref\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
      ),
    );
    await writeTex(
      'main.tex',
      '\\begin{figure}\n\\includegraphics{wrapped.pdf}\n\\caption{Wrapped}\n\\label{fig:wrap}\n\\end{figure}\n',
    );
    const result = await auditFigures(tmpDir);
    expect(issueTypes(result, 'raster_in_pdf').length).toBe(1);
  });
});
