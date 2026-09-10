import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import {
  createResearchMediaAttachFailure,
  decodeResearchMediaAttachRequest,
  decodeResearchMediaAttachResult,
} from '../../engine/runtime/ResearchMediaRuntimeContract.js';
import { isAuthorizedRendererMainFrame } from '../../electron/RendererAuthorization.js';
import { createSecureIpcHandler, decoded, rejected } from '../../electron/SecureIpc.js';

const mainSource = fs.readFileSync(
  path.resolve(process.cwd(), 'electron/main.ts'),
  'utf8',
);
const fileCapabilityHandlerSource = fs.readFileSync(
  path.resolve(process.cwd(), 'electron/FileCapabilityHandler.ts'),
  'utf8',
);

function handlerSource(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) return '';
  const end = mainSource.indexOf('ipcMain.handle(', start + 1);
  return mainSource.slice(start, end < 0 ? mainSource.length : end);
}

interface TestEvent extends IpcMainInvokeEvent {
  authorization: {
    senderWindowMatches: boolean;
    senderFrameMatches: boolean;
    senderFrameUrl: string;
    expectedEntryUrl: string;
  };
}

function event(
  authorization: Partial<TestEvent['authorization']> = {},
  owner = { webContentsId: 101, processId: 201, routingId: 301 },
): TestEvent {
  return {
    authorization: {
      senderWindowMatches: true,
      senderFrameMatches: true,
      senderFrameUrl: 'file:///C:/app/dist/index.html',
      expectedEntryUrl: 'file:///C:/app/dist/index.html',
      ...authorization,
    },
    sender: { id: owner.webContentsId },
    senderFrame: {
      processId: owner.processId,
      routingId: owner.routingId,
    },
  } as unknown as TestEvent;
}

const request = {
  projectId: 'project_media_contract',
  sourceId: 'source_media_contract',
  capabilityId: `fc_${'a'.repeat(32)}`,
  caption: 'Owner-bound image',
  ordinal: 0,
};

describe('P0 research media IPC ownership boundary', () => {
  it('wires the production handler through main-frame authorization and event-derived owner', () => {
    const source = handlerSource('research:mediaAttach');
    expect(source).toContain('authorize: requireRendererMainFrame');
    expect(source).toContain('decodeResearchMediaAttachRequest');
    expect(source).toContain('researchMedia?.attach(request, executionOwnerFor(event))');
    expect(source).not.toMatch(/researchMedia\?\.attach\(request\)\b/u);

    const useSource = handlerSource('fileCapability:use');
    expect(useSource).toContain('createFileCapabilityUseHandler');
    expect(useSource).toContain('registry: fileCapabilities');
    expect(fileCapabilityHandlerSource).toContain(
      'registry.resolve(request, executionOwnerFor(event))',
    );
    expect(mainSource).toContain("mainWindow.webContents.once('destroyed'");
    expect(mainSource).toContain('fileCapabilities.clearWebContents(fileCapabilityWebContentsId)');
  });

  it('rejects a secondary window and a subframe before attach executes', async () => {
    const attach = vi.fn((_request: unknown, owner: unknown) => ({
      success: true as const,
      code: 'research_media_attached' as const,
      media: {
        sourceId: 'source_media_contract',
        caption: 'Owner-bound image',
        ordinal: 0,
        displayName: 'image.png',
        mediaType: 'image/png' as const,
        byteLength: 68,
        sha256: '0'.repeat(64),
        widthPx: 1,
        heightPx: 1,
      },
      owner,
    }));
    const handler = createSecureIpcHandler({
      authorize: (ipcEvent: IpcMainInvokeEvent) => {
        const candidate = ipcEvent as TestEvent;
        if (!isAuthorizedRendererMainFrame(candidate.authorization)) {
          throw new Error('Unauthorized renderer');
        }
      },
      decode: ([rawRequest]) => {
        const decodedRequest = decodeResearchMediaAttachRequest(rawRequest);
        return decodedRequest ? decoded(decodedRequest) : rejected();
      },
      execute: (decodedRequest, ipcEvent) => {
        const frame = ipcEvent.senderFrame;
        if (!frame) return createResearchMediaAttachFailure();
        return attach(decodedRequest, {
          webContentsId: ipcEvent.sender.id,
          mainFrameProcessId: frame.processId,
          mainFrameRoutingId: frame.routingId,
        });
      },
      present: decodeResearchMediaAttachResult,
      recover: createResearchMediaAttachFailure,
    });

    await expect(handler(event({ senderWindowMatches: false }), request)).resolves.toEqual(
      createResearchMediaAttachFailure(),
    );
    await expect(handler(event({ senderFrameMatches: false }), request)).resolves.toEqual(
      createResearchMediaAttachFailure(),
    );
    expect(attach).not.toHaveBeenCalled();

    const result = await handler(event(), request);
    expect(result.success).toBe(false);
    // The presenter rejected the test-only owner echo, proving owner never crosses IPC.
    expect(attach).toHaveBeenCalledWith(request, {
      webContentsId: 101,
      mainFrameProcessId: 201,
      mainFrameRoutingId: 301,
    });
    expect(JSON.stringify(result)).not.toContain('owner');
  });
});
