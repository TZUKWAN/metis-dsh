import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mainSource = fs.readFileSync(
  path.resolve(process.cwd(), 'electron/main.ts'),
  'utf8',
);

function sessionHandlerSource(
  channel: 'session:create' | 'session:list' | 'session:update' | 'session:delete',
): string {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) return '';
  const nextHandler = mainSource.indexOf('ipcMain.handle(', start + 1);
  const artifactSection = mainSource.indexOf('// ── Artifacts', start + 1);
  const candidates = [nextHandler, artifactSection].filter((value) => value >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : mainSource.length;
  return mainSource.slice(start, end);
}

describe('session IPC main-process boundary', () => {
  it.each([
    ['session:create', 'decodeSessionCreateRequest'],
    ['session:list', 'decodeSessionListRequest'],
    ['session:update', 'decodeSessionUpdateRequest'],
    ['session:delete', 'decodeSessionDeleteRequest'],
  ] as const)('%s authorizes the live main frame before decoding', (channel, decoder) => {
    const source = sessionHandlerSource(channel);
    expect(source).toContain('requireRendererMainFrame(event)');
    expect(source.indexOf('requireRendererMainFrame(event)')).toBeLessThan(source.indexOf(decoder));
    expect(source).toContain(decoder);
    expect(source).not.toContain('err.message');
    expect(source).not.toContain('String(err)');
  });

  it('lists only explicitly presented legacy fields and uses fixed recovery', () => {
    const source = sessionHandlerSource('session:list');
    expect(source).toContain('const filter = decoded.value.projectId');
    expect(source).toContain('createSessionListRecovery()');
    expect(source).not.toContain('return store.listSessions()');
  });

  it('updates only the decoded title/archive metadata patch', () => {
    const source = sessionHandlerSource('session:update');
    expect(source).toContain('const { scenarioId, activeArtifactIds, ...legacyPatch } = decoded.value.patch');
    expect(source).not.toContain('lastActivity:');
    expect(source).not.toContain('messageCount:');
    expect(source).not.toContain('rawRequest as');
  });
});
