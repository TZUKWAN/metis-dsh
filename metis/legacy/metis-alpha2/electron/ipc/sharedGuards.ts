/**
 * Shared helpers for domain IPC registrars (Task 3).
 * These mirror small pure helpers that previously lived in `electron/main.ts`
 * (`isRecord`, `mimeForLocalFile`, `parseBrowserBounds`, `executionOwnerFor`);
 * they depend only on their arguments, so registrars can stay import-cycle
 * free from `main.ts`.
 */

import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { ExecutionOwnerIdentity } from '../ExecutionCapabilityRegistry.js';
import type { BrowserBounds } from '../BrowserService.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mimeForLocalFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.tex': 'application/x-tex',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return known[extension] ?? 'application/octet-stream';
}

export function parseBrowserBounds(raw: unknown): BrowserBounds | null {
  const r = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  if (!r) return null;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function executionOwnerFor(event: IpcMainInvokeEvent): ExecutionOwnerIdentity {
  const frame = event.senderFrame;
  if (!frame) throw new Error('Execution owner is unavailable');
  return {
    webContentsId: event.sender.id,
    mainFrameProcessId: frame.processId,
    mainFrameRoutingId: frame.routingId,
  };
}
