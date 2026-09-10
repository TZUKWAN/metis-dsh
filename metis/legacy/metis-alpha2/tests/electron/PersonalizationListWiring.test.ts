import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');

function handlerSource(channel: string, nextChannel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  const end = mainSource.indexOf(`ipcMain.handle('${nextChannel}'`, start);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${channel} handler`);
  return mainSource.slice(start, end);
}

describe('personalization list production wiring', () => {
  it('never converts a missing runtime or handler exception into an authoritative empty catalog', () => {
    const source = handlerSource('personalization:list', 'personalization:get');

    expect(source).toContain("{ ok: false, code: 'unavailable' }");
    expect(source).not.toContain('{ ok: true, definitions: [] }');
    expect(source).toContain('personalizationRuntime?.list(rawRequest)');
  });
});
