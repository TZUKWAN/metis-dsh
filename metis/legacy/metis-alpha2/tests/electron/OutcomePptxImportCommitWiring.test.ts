/**
 * Static wiring evidence for the PPTX reverse-image save-time commit.
 *
 * The runtime loop (extract → persistGenerated → mediaId → import version) is
 * proven by OutcomePptxMediaIntegration; this file pins the main/preload
 * boundary so the DB-free preview and the save-time-only media commit cannot
 * silently regress into renderer-owned binaries or preview writes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
const preloadSource = [
  'electron/preload.ts',
  ...readdirSync(path.resolve(process.cwd(), 'electron/preload')).filter((f) => f.endsWith('.ts')).map((f) => 'electron/preload/' + f),
].map((f) => readFileSync(path.resolve(process.cwd(), f), 'utf8')).join('\n');

function handlerBlock(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) throw new Error(`handler not registered: ${channel}`);
  const end = source.indexOf('ipcMain.handle(', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('outcomes:pptx:import / commitMedia wiring', () => {
  it('keeps the preview import DB-free and returns a main-owned token', () => {
    const importHandler = handlerBlock(mainSource, 'outcomes:pptx:import');
    expect(importHandler).toContain('requireRendererMainFrame');
    expect(importHandler).toContain('importToken');
    expect(importHandler).toContain('pptxImportSessions.set');
    expect(importHandler).not.toContain('persistGenerated');
    expect(importHandler).not.toContain('outcome_media');
  });

  it('commits media only through the strict contract, the session token and the repository boundary', () => {
    const commitHandler = handlerBlock(mainSource, 'outcomes:pptx:import:commitMedia');
    expect(commitHandler).toContain('requireRendererMainFrame');
    expect(commitHandler).toContain('OutcomePptxImportCommitRequestSchema');
    expect(commitHandler).toContain('pptxImportSessions.get');
    expect(commitHandler).toContain('session.projectId !== parsed.data.projectId');
    expect(commitHandler).toContain('commitImportedMedia');
    expect(commitHandler).toContain('persistGenerated');
  });

  it('rolls back freshly created media and reserved outcomes when the commit fails', () => {
    const commitHandler = handlerBlock(mainSource, 'outcomes:pptx:import:commitMedia');
    expect(commitHandler).toContain('removeGenerated');
    expect(commitHandler).toContain('deleteReserved');
  });

  it('exposes a strict preload bridge and consumes the token at the final version write', () => {
    expect(preloadSource).toContain('commitOutcomePptxImportMedia');
    expect(preloadSource).toContain(`'outcomes:pptx:import:commitMedia'`);
    expect(preloadSource).toContain('OutcomePptxImportCommitResultSchema');
    const createHandler = handlerBlock(mainSource, 'outcomes:create');
    const saveHandler = handlerBlock(mainSource, 'outcomes:save');
    expect(createHandler).toContain('pptxImportSessions');
    expect(saveHandler).toContain('discardPptxImportSession');
  });
});
