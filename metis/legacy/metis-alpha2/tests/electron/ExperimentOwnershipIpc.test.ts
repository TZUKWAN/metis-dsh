import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeExperimentDelete,
  decodeExperimentSave,
} from '../../engine/runtime/ExperimentMetadataContract.js';
import {
  decodeExperimentExecutionGrantRequest,
  decodeExperimentRunRequest,
  decodeExperimentScriptAttachRequest,
} from '../../engine/runtime/ExperimentRuntimeContract.js';
import { isAuthorizedRendererMainFrame } from '../../electron/RendererAuthorization.js';

const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
// 任务3：experiment 域 handler 已迁至 registerExperimentIpc.ts——ownership
// 断言的扫描范围随之覆盖 registrar（channel 集合不变，仅物理位置变化）。
const registrarSource = fs.readFileSync(path.resolve(process.cwd(), 'electron/ipc/registerExperimentIpc.ts'), 'utf8');

function handlerSource(channel: string): string {
  const source = mainSource.includes(`ipcMain.handle('${channel}'`) ? mainSource : registrarSource;
  const startMarker = source === registrarSource ? `dom.handle('${channel}'` : `ipcMain.handle('${channel}'`;
  const nextMarker = source === registrarSource ? 'dom.handle(' : 'ipcMain.handle(';
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(nextMarker, start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

describe('experiment IPC ownership boundary', () => {
  it('derives owners from authorized main-frame events for every execution operation', () => {
    for (const channel of [
      'experiment:attachScript',
      'experiment:requestRunGrant',
      'experiment:run',
      'experiment:cancel',
    ]) {
      const source = handlerSource(channel);
      expect(source).toContain('requireRendererMainFrame(event)');
      expect(source).toContain('executionOwnerFor(event)');
    }
    for (const channel of ['experiment:list', 'experiment:save', 'experiment:delete']) {
      expect(handlerSource(channel)).toContain('requireRendererMainFrame(event)');
    }
    const list = handlerSource('experiment:list');
    expect(list).toContain('getExperimentMetadata()');
    expect(list).not.toContain('getExperiments()');
    const hydration = handlerSource('data:loadAll');
    expect(hydration).toContain('getExperimentMetadata()');
    expect(hydration).not.toMatch(/\.\.\.data\b/u);
    const run = handlerSource('experiment:run');
    expect(run).toContain('updateExperimentRunState');
    expect(run).toContain("!['rejected', 'runtime_unavailable'].includes(result.status)");
  });

  it('rejects a secondary window and a subframe before authority is granted', () => {
    const authorized = {
      senderWindowMatches: true,
      senderFrameMatches: true,
      senderFrameUrl: 'file:///C:/app/dist/index.html',
      expectedEntryUrl: 'file:///C:/app/dist/index.html',
    };
    expect(isAuthorizedRendererMainFrame({ ...authorized, senderWindowMatches: false })).toBe(false);
    expect(isAuthorizedRendererMainFrame({ ...authorized, senderFrameMatches: false })).toBe(false);
    expect(isAuthorizedRendererMainFrame(authorized)).toBe(true);
  });

  it('rejects renderer-forged owner fields in every strict request DTO', () => {
    const owner = { webContentsId: 999, mainFrameProcessId: 999, mainFrameRoutingId: 999 };
    expect(decodeExperimentScriptAttachRequest({ experimentId: 'exp-1', owner })).toBeUndefined();
    expect(decodeExperimentExecutionGrantRequest({ experimentId: 'exp-1', owner })).toBeUndefined();
    expect(decodeExperimentRunRequest({
      experimentId: 'exp-1',
      grant: {},
      owner,
    })).toBeUndefined();
    expect(decodeExperimentDelete({ id: 'exp-1', owner })).toBeNull();
    expect(decodeExperimentSave({
      id: 'exp-1',
      name: 'Experiment',
      description: '',
      status: 'planned',
      parameters: {},
      metrics: {},
      tags: [],
      notes: '',
      linkedPaperIds: [],
      createdAt: 1,
      owner,
    })).toBeNull();
  });
});
