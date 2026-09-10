import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');

function compileHarnessSource(): string {
  const start = mainSource.indexOf("ipcMain.handle('scenario:compileHarness'");
  const end = mainSource.indexOf("ipcMain.handle('scenario:aiRefine'", start);
  expect(start, 'scenario compiler IPC handler must exist').toBeGreaterThanOrEqual(0);
  expect(end, 'scenario compiler IPC handler must have a following boundary').toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

describe('scenario compiler concurrent session wiring', () => {
  it('keys draft and installation listeners by compileSessionId and only removes its own callback', () => {
    const source = compileHarnessSource();

    expect(source).toContain('setDraftUpdatedListener(compileSessionId, draftUpdatedListener)');
    expect(source).toContain('removeDraftUpdatedListener(compileSessionId, draftUpdatedListener)');
    expect(source).toContain('scenarioAcquisition.install.notifications.set(compileSessionId, installationNotificationListener)');
    expect(source).toContain('scenarioAcquisition.install.notifications.get(compileSessionId) === installationNotificationListener');
    expect(source).toContain('scenarioAcquisition.install.notifications.delete(compileSessionId)');
    expect(source).not.toContain('scenarioPatchRouterSingleton.onDraftUpdated =');
    expect(source).not.toContain('scenarioAcquisition.install.notify =');
  });

  it('uses a compile-session-unique stream hook, filters foreign chunks, and unregisters that same hook', () => {
    const source = compileHarnessSource();

    expect(source).toContain('const scenarioStreamHookName = `scenario-stream-forward:${compileSessionId}`');
    expect(source).toContain('if (payload.sessionId !== compileSessionId) return ctx;');
    expect(source).toContain("registerHook('model.stream_chunk', forwardScenarioStream, { name: scenarioStreamHookName })");
    expect(source).toContain("unregisterHook('model.stream_chunk', scenarioStreamHookName)");
    expect(source).not.toContain("unregisterHook('model.stream_chunk', 'scenario-stream-forward')");
  });
});
