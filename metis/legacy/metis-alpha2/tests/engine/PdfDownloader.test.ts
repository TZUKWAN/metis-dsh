/**
 * Tests for PDF download helpers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { downloadFile, downloadPdfToDir, sanitizeFilename } from '../../engine/research/PdfDownloader.js';

describe('PdfDownloader', () => {
  let server: http.Server;
  let serverUrl = '';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-downloader-test-'));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/paper.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(Buffer.from('%PDF-1.4 test content'));
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/paper.pdf' });
        res.end();
      } else if (req.url === '/error') {
        res.writeHead(500);
        res.end('Internal Server Error');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads a PDF file', async () => {
    const dest = path.join(tmpDir, 'downloaded.pdf');
    await downloadFile(`${serverUrl}/paper.pdf`, dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest).toString()).toContain('%PDF-1.4');
  });

  it('follows redirects', async () => {
    const dest = path.join(tmpDir, 'redirected.pdf');
    await downloadFile(`${serverUrl}/redirect`, dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest).toString()).toContain('%PDF-1.4');
  });

  it('throws on non-2xx status', async () => {
    const dest = path.join(tmpDir, 'error.pdf');
    await expect(downloadFile(`${serverUrl}/error`, dest)).rejects.toThrow('Download failed with status 500');
  });

  it('sanitizes filenames', () => {
    expect(sanitizeFilename('hello/world.pdf')).toBe('world.pdf');
    expect(sanitizeFilename('hello world.pdf')).toBe('hello_world.pdf');
  });

  it('downloadPdfToDir returns success with path', async () => {
    const result = await downloadPdfToDir(`${serverUrl}/paper.pdf`, 'test.pdf', tmpDir);
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(tmpDir, 'test.pdf'));
    expect(fs.existsSync(result.path!)).toBe(true);
  });

  it('downloadPdfToDir rejects non-pdf URLs', async () => {
    const result = await downloadPdfToDir(`${serverUrl}/paper.txt`, 'test.pdf', tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not appear to be a PDF');
  });
});
