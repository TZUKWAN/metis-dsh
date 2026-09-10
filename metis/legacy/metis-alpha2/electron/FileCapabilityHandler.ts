/**
 * FileCapability IPC handler factory — side-effect-free, dependency-injected.
 *
 * Extracted from main.ts so that production and test can share the same handler
 * logic without importing main entry or relying on mutable module state.
 *
 * Dependencies (non-reactive):
 *  - `mainWindow`: BrowserWindow for checking ownership / sender identity
 *  - `rendererEntryUrl`: expected URL origin for renderer frame authorization
 *  - `registry`: FileCapabilityRegistry instance
 */

import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  createFileCapabilityFailure,
  decodeFileCapabilityUseRequest,
  decodeFileCapabilityUseResult,
  type FileCapabilityUseRequest,
  type FileCapabilityUseResult,
} from '../engine/runtime/FileCapabilityContract.js';
import { FileCapabilityRegistry } from './FileCapabilityRegistry.js';
import type { ExecutionOwnerIdentity } from './ExecutionCapabilityRegistry.js';
import { createSecureIpcHandler, decoded, rejected } from './SecureIpc.js';
import { isAuthorizedRendererMainFrame } from './RendererAuthorization.js';

function authorizeMainFrame(
  event: IpcMainInvokeEvent,
  deps: FileCapabilityHandlerDeps,
): BrowserWindow {
  const mainWindow = deps.getMainWindow();
  const window = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const senderWindowMatches = Boolean(
    window && window === mainWindow && !window.isDestroyed(),
  );
  const senderFrameMatches = Boolean(
    senderWindowMatches && senderFrame === mainWindow?.webContents.mainFrame,
  );
  if (!senderWindowMatches || !senderFrameMatches) {
    throw new Error('Unauthorized IPC sender');
  }
  // Exact URL authorization via shared RendererAuthorization module
  if (!isAuthorizedRendererMainFrame({
    senderWindowMatches,
    senderFrameMatches,
    senderFrameUrl: senderFrame?.url ?? '',
    expectedEntryUrl: deps.getRendererEntryUrl(),
  })) {
    throw new Error('Unauthorized IPC sender');
  }
  return window!;
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

export async function executeFileCapabilityUse(
  request: FileCapabilityUseRequest,
  event: IpcMainInvokeEvent,
  registry: FileCapabilityRegistry,
): Promise<FileCapabilityUseResult> {
  const resolved = registry.resolve(request, executionOwnerFor(event));
  if (!resolved.ok) return resolved.failure;
  if (request.operation === 'file' || request.operation === 'folder') {
    const { shell } = await import('electron');
    const error = await shell.openPath(resolved.resolvedPath);
    return error.length === 0
      ? { success: true, operation: request.operation, capability: resolved.capability }
      : createFileCapabilityFailure();
  }
  if (request.operation === 'read') {
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(resolved.resolvedPath);
    if (!stat.isFile() || stat.size > request.maxBytes) return createFileCapabilityFailure();
    const data = await fs.readFile(resolved.resolvedPath);
    return {
      success: true,
      operation: 'read',
      capability: resolved.capability,
      data: new Uint8Array(data),
    };
  }
  if (resolved.capability.mime === 'application/pdf') {
    const { getPdfReader } = await import('../engine/research/PdfReader.js');
    const reader = getPdfReader();
    const parsed = await reader.readFile(resolved.resolvedPath, { includeOutline: false });
    const text = parsed.pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join('\n\n');
    return {
      success: true,
      operation: 'extract',
      capability: resolved.capability,
      text: text.slice(0, request.maxChars),
      truncated: text.length > request.maxChars,
    };
  }
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(resolved.resolvedPath, 'utf8');
  return {
    success: true,
    operation: 'extract',
    capability: resolved.capability,
    text: text.slice(0, request.maxChars),
    truncated: text.length > request.maxChars,
  };
}

export interface FileCapabilityHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  getRendererEntryUrl: () => string;
  registry: FileCapabilityRegistry;
}

export function createFileCapabilityUseHandler(deps: FileCapabilityHandlerDeps) {
  return createSecureIpcHandler<
    FileCapabilityUseRequest,
    unknown,
    FileCapabilityUseResult
  >({
    authorize: (event) => authorizeMainFrame(event, deps),
    decode: (rawArgs) => {
      const request = decodeFileCapabilityUseRequest(rawArgs[0]);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: (request, event) =>
      executeFileCapabilityUse(request, event, deps.registry),
    present: decodeFileCapabilityUseResult,
    recover: createFileCapabilityFailure,
  });
}
