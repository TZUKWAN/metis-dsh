import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ipcMain, nativeTheme } from 'electron';
import type { EmbeddedViewSession } from './genofficeEmbeddedTypes.js';

/**
 * Compatibility IPC surface for a Docs renderer hosted inside METIS's window.
 *
 * The standalone child process satisfies these channels via the app's own
 * main; embedded mode re-implements only the channels exercised by the
 * single-file open→edit→save loop (validated by outcome-genoffice E2E), and
 * degrades everything else honestly instead of fabricating results. Every
 * handler that accepts a path is scoped to the owning session directory.
 */

export interface DocsCompatHost {
  getSessionByWebContents(webContentsId: number): EmbeddedViewSession | undefined;
  readFileBytes(session: EmbeddedViewSession): Promise<Buffer>;
  writeSessionFile(session: EmbeddedViewSession, bytes: Buffer): Promise<void>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pathInsideSession(session: EmbeddedViewSession, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const lowerDir = session.filePath.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  const dir = path.dirname(lowerDir);
  // Windows separators included; the session dir name is unique per token, so
  // a prefix check cannot escape into sibling sessions.
  if (!(lowerCandidate.startsWith(dir + '\\') || lowerCandidate.startsWith(dir + '/'))) {
    return null;
  }
  return candidate;
}

let themeOverride: 'light' | 'dark' | 'system' | null = null;
const themeListeners = new Set<(value: string) => void>();

/**
 * Registers a compat handler only when METIS itself has not claimed the
 * channel. Host-owned handlers win: the embedded renderer must never shadow
 * the main app's IPC surface (e.g. `project:list`).
 *
 * 注意：Electron 的 ipcMain.listenerCount() 只统计 .on() 监听器，不统计
 * .handle() 的 invoke 处理器，所以不能用 listenerCount 判定通道归属；
 * 这里直接尝试 handle() 并吞掉 "second handler" 错误来让位给主应用。
 */
function compatHandle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  try {
    ipcMain.handle(channel, handler as never);
  } catch {
    // METIS 已拥有该通道：保留主应用实现，不覆盖。
  }
}

export function setEmbeddedGenofficeTheme(value: unknown): boolean {
  if (value !== 'light' && value !== 'dark' && value !== 'system') return false;
  themeOverride = value;
  for (const listener of themeListeners) listener(value);
  return true;
}

/** Bridges METIS theme changes into every embedded GenOffice view. */
export function onEmbeddedThemeChanged(listener: (value: string) => void): void {
  themeListeners.add(listener);
}

export function registerGenofficeDocsCompat(host: DocsCompatHost): void {
  // ── shared shell: theme / language ──
  compatHandle('app:get-theme', () => themeOverride ?? nativeTheme.themeSource);
  compatHandle('app:set-theme', (_event, value: unknown) => setEmbeddedGenofficeTheme(value));
  compatHandle('app:get-language', () => 'zh-CN');

  // ── docs open/save loop ──
  compatHandle('docs:consume-pending-open', async (event) => {
    const session = host.getSessionByWebContents(event.sender.id);
    if (!session) return null;
    const bytes = await host.readFileBytes(session);
    return {
      path: session.filePath,
      name: session.fileName,
      data: toArrayBuffer(bytes),
      hash: sha256(bytes),
    };
  });
  compatHandle('docs:consume-new-blank', () => null);
  compatHandle('docs:consume-ai-doc-content', () => null);

  compatHandle('docs:save', async (event, filePath: unknown, data: unknown) => {
    const session = host.getSessionByWebContents(event.sender.id);
    if (!session) return { ok: false as const, reason: 'no-session' };
    const scoped = pathInsideSession(session, filePath);
    if (!scoped || data === null || typeof data !== 'object') {
      return { ok: false as const, error: 'embedded_save_path_invalid' };
    }
    await host.writeSessionFile(session, Buffer.from(data as ArrayBuffer));
    return { ok: true as const, passwordIntentPending: false };
  });

  // 另存/新存一律重定向回会话文件：METIS 里“另存”的语义是同步成新版本，
  // 保持单一事实源，避免 dirty 基线漂移。
  compatHandle('docs:save-as', async (event) => {
    const session = host.getSessionByWebContents(event.sender.id);
    if (!session) return { canceled: true };
    return { path: session.filePath };
  });
  compatHandle('docs:save-new', async (event) => {
    const session = host.getSessionByWebContents(event.sender.id);
    if (!session) return { canceled: true };
    return { path: session.filePath };
  });

  compatHandle('docs:write-recovery', () => false);
  compatHandle('docs:recent', () => []);
  compatHandle('docs:password-intent-revision', () => 0);
  compatHandle('docs:discard-password-intents', () => undefined);
  compatHandle('docs:open-decrypt', () => ({ ok: false as const, reason: 'unsupported' }));
  compatHandle('docs:set-password', () => ({ ok: false as const }));
  compatHandle('docs:create-document', () => null);
  compatHandle('docs:open-path', async (event, filePath: unknown) => {
    const session = host.getSessionByWebContents(event.sender.id);
    if (!session || pathInsideSession(session, filePath) === null) return null;
    const bytes = await host.readFileBytes(session);
    return {
      path: session.filePath,
      name: session.fileName,
      data: toArrayBuffer(bytes),
      hash: sha256(bytes),
    };
  });
  compatHandle('docs:open', () => null); // no OS picker inside embed

  // ── honest degradations (real feature gaps are surfaced to the user) ──
  compatHandle('docs:print', () => false);
  compatHandle('docs:export-pdf', () => null);
  compatHandle('docs:print-pdf-buffer', () => false);
  compatHandle('docs:save-merged-pdf', () => ({ canceled: true }));
  compatHandle('docs:pick-image', () => null);
  compatHandle('files:pick', () => null);
  compatHandle('files:add', () => []);
  compatHandle('files:add-pasted-image', () => null);
  compatHandle('files:read-image', () => null);
  compatHandle('files:read', async (event, filePath: unknown) => {
    const session = host.getSessionByWebContents(event.sender.id);
    const scoped = session ? pathInsideSession(session, filePath) : null;
    if (!session || !scoped) return null;
    const bytes = await fsp.readFile(scoped);
    return bytes.toString('base64');
  });
  compatHandle('docs:copy-image-to-clipboard', () => false);
  compatHandle('docs:ai-generate-image', () => null);
  compatHandle('ai:fetch-image', () => null);

  // ── font metrics: GenOffice falls back to defaults when this is null ──
  compatHandle('docs:font-metrics', () => null);

  // ── multi-tab/window APIs do not exist inside one embedded surface ──
  compatHandle('win:new', (event, openPath?: unknown) => openPath ?? null);
  compatHandle('win:list', () => []);
  compatHandle('win:focus', () => false);

  // ── AI/project panels start locked-down exactly like standalone mode ──
  compatHandle('project:resolveChat', (_event, args: { tempChatId?: unknown }) => ({
    projectId: 'standalone',
    chatId: typeof args?.tempChatId === 'string' && args.tempChatId.length > 0 ? args.tempChatId : `standalone-${Date.now()}`,
  }));
  compatHandle('project:appendChat', () => undefined);
  compatHandle('project:loadChat', () => []);
  compatHandle('project:rebindChat', () => null);
  compatHandle('project:list', () => []);
  compatHandle('project:files', () => []);
  compatHandle('project:timeline', () => []);
  compatHandle('ai:gsk-status', () => ({ loggedIn: false }));
  compatHandle('ai:get-settings', () => ({
    provider: 'genspark',
    gskToolsEnabled: false,
    providers: { genspark: { apiKey: '', model: '' } },
  }));
  compatHandle('ai:set-settings', () => false);
  compatHandle('ai:stream-cancel', () => undefined);
  compatHandle('ai:chat', () => ({}));
  compatHandle('ai:web-search', () => []);
  compatHandle('ai:image-search', () => []);
}
