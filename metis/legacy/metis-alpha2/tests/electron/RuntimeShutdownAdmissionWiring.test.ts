import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');

function sectionBetween(startNeedle: string, endNeedle: string): string {
  const start = mainSource.indexOf(startNeedle);
  const end = mainSource.indexOf(endNeedle, start + startNeedle.length);
  expect(start, `missing section start: ${startNeedle}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing section end: ${endNeedle}`).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

describe('runtime shutdown admission wiring', () => {
  it('normal chat rolls active state back when registration is rejected', () => {
    const section = sectionBetween(
      "activeChatRuns.set(sessionId, activeRun);",
      "activeFundingToolScopes.set(sessionId, fundingToolScope);",
    );
    expect(section).toContain('registerChatRunForShutdown');
    expect(section).toContain('if (!unregisterChatRun)');
    expect(section).toContain("'application_shutting_down'");
  });

  it('compare rolls active state back when registration is rejected', () => {
    const section = sectionBetween(
      'activeCompareRuns.set(runKey, compareRun);',
      'try {\n      const compareProvider',
    );
    expect(section).toContain('registerRuntimeRunOrRollback');
    expect(section).toContain('if (!unregisterCompareRun)');
    expect(section).toContain("'application_shutting_down'");
  });

  it('autonomous runs admit before starting the executor and clear the session on rejection', () => {
    const spawn = sectionBetween(
      'function spawnAutonomousRun(',
      "  ipcMain.handle(AUTONOMOUS_CHANNELS.start",
    );
    expect(spawn).toContain('): boolean');
    expect(spawn).toContain('registerRuntimeRunOrRollback');
    expect(spawn).toContain('if (!unregisterAutonomousRun) return false;');
    expect(spawn.indexOf('if (!unregisterAutonomousRun) return false;')).toBeLessThan(
      spawn.indexOf('void (async () => {'),
    );

    const start = sectionBetween(
      'activeAutonomousSessionId = sessionId;\n    if (!spawnAutonomousRun',
      'return { ok: true, sessionId, projectId: resolvedProjectId };',
    );
    expect(start).toContain("'application_shutting_down'");
  });

  it('admits every requested ephemeral handler, forwards the abort signal, and cleans up', () => {
    const cases: Array<[string, string]> = [
      ["ipcMain.handle('autonomous:generateBatch'", "ipcMain.handle('autonomous:createProjectFor'"],
      ["ipcMain.handle('papers:aiExplain'", "ipcMain.handle('papers:aiSynthesis'"],
      ["ipcMain.handle('papers:aiSynthesis'", "ipcMain.handle('latex:aiPolish'"],
      ["ipcMain.handle('latex:aiPolish'", "ipcMain.handle('memory:getProject'"],
      ["ipcMain.handle('personalization:aiGenerateScenario'", 'function parseAiAgentGeneration('],
      ["ipcMain.handle('personalization:aiGenerateAgent'", "ipcMain.handle('market:search'"],
      ["ipcMain.handle('scenario:analyzeMaterials'", "ipcMain.handle('scenario:compileHarness'"],
      ["ipcMain.handle('scenario:compileHarness'", "ipcMain.handle('scenario:aiRefine'"],
      ["ipcMain.handle('scenario:aiRefine'", "ipcMain.handle('personalization:parsePaperTemplate'"],
      ["ipcMain.handle('personalization:parsePaperTemplate'", "ipcMain.handle('personalization:extension:apply'"],
    ];
    for (const [start, end] of cases) {
      const section = sectionBetween(start, end);
      expect(section, `${start} missing trackEphemeralOperation`).toContain('trackEphemeralOperation');
      expect(section, `${start} missing shutdown rejection`).toContain("'application_shutting_down'");
      expect(section, `${start} missing signal propagation`).toContain('signal: tracked.signal');
      expect(section, `${start} missing cleanup`).toContain('tracked.cleanup()');
      expect(section, `${start} missing finally`).toContain('finally');
    }
  });

  it('wires goal planning admission and signal propagation for both plan operations', () => {
    const generate = sectionBetween("ipcMain.handle('goal:generatePlan'", "ipcMain.handle('goal:refinePlan'");
    const refine = sectionBetween("ipcMain.handle('goal:refinePlan'", "ipcMain.handle('goal:updatePlan'");
    for (const section of [generate, refine]) {
      expect(section).toContain('trackEphemeralOperation');
      expect(section).toContain("code: 'application_shutting_down'");
      expect(section).toContain('signal: tracked.signal');
      expect(section).toContain('tracked.cleanup()');
      expect(section).toContain('finally');
    }
    expect(generate).toContain('goalEngine.generatePlan(goalId, { signal: tracked.signal })');
    expect(refine).toContain('goalEngine.refinePlan(request.goalId, request.feedback, { signal: tracked.signal })');
  });

  it('does not leave ignored coordinator registration results in main', () => {
    expect(mainSource).not.toMatch(/runtimeShutdown\.register\([\s\S]*?\);/);
    expect(mainSource).toContain('registerRuntimeRunOrRollback');
  });
});
