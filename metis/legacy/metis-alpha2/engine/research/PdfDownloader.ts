/**
 * PDF downloader helpers for fetching open-access PDFs.
 *
 * Runs in Node.js (main process). Uses Node's built-in http/https modules
 * so it has no extra native dependencies.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_REDIRECTS = 8;

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function downloadFile(url: string, dest: string): Promise<void> {
  return downloadFileWithRedirects(url, dest, 0);
}

function downloadFileWithRedirects(url: string, dest: string, redirects: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      fs.unlink(dest, () => {});
      reject(error);
    };
    const req = protocol.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Do not open/truncate the destination before we know this is the
        // final response. Closing the first stream asynchronously used to
        // race with the redirected request and could leave an empty PDF.
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          rejectOnce(new Error(`Download exceeded ${MAX_REDIRECTS} redirects`));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).toString();
        void downloadFileWithRedirects(redirectUrl, dest, redirects + 1).then(
          () => { if (!settled) { settled = true; resolve(); } },
          (error: unknown) => rejectOnce(error instanceof Error ? error : new Error(String(error))),
        );
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        rejectOnce(new Error(`Download failed with status ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      void pipeline(res, file).then(
        () => { if (!settled) { settled = true; resolve(); } },
        (error: unknown) => rejectOnce(error instanceof Error ? error : new Error(String(error))),
      );
    });
    req.on('error', rejectOnce);
    req.setTimeout(30000, () => {
      req.destroy();
      rejectOnce(new Error('Download timed out'));
    });
  });
}

export function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export interface DownloadPdfResult {
  success: boolean;
  path?: string;
  error?: string;
}

export async function downloadPdfToDir(url: string, filename: string, papersDir: string): Promise<DownloadPdfResult> {
  if (typeof url !== 'string' || typeof filename !== 'string') {
    return { success: false, error: 'Invalid url or filename' };
  }
  if (!url.includes('.pdf')) {
    return { success: false, error: 'URL does not appear to be a PDF' };
  }
  try {
    ensureDir(papersDir);
    const safeName = sanitizeFilename(filename);
    const dest = path.join(papersDir, safeName);
    await downloadFile(url, dest);
    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
