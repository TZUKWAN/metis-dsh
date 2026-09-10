import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');

function handlerSource(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = mainSource.indexOf("ipcMain.handle('", start + 1);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe('formal export production trust wiring', () => {
  it('revalidates on preview and again on execute, then writes only the rebuilt current plan', () => {
    const preview = handlerSource('export:preview');
    const execute = handlerSource('export:execute');
    expect(preview).toContain('verifyArtifactForExport(');
    expect(preview).toContain('buildExportSnapshot(snapshot, binding, artifactImages, releaseTrust)');
    expect(execute).toContain('verifyArtifactForExport(');
    expect(execute).toContain('buildExportSnapshot(currentSnapshot, currentBinding, currentImages, currentTrust)');
    expect(execute).toContain('secureExports.write(currentBuild.plan');
    expect(execute).not.toContain('secureExports.write(preview.plan');
  });

  it('loads a durable safeStorage key and installs repository transaction verification', () => {
    expect(mainSource).toContain('loadOrCreateCitationTruthSecret(DATA_DIR, safeStorage)');
    expect(mainSource).toContain('verifyArtifactForPersistence(');
    expect(mainSource).toContain('new ResearchRuntimeService(');
    expect(mainSource).toContain('citationTruthReceipts ?? undefined');
  });
});
