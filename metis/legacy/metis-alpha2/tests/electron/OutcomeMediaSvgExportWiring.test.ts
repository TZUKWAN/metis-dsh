/** Wiring evidence for the standalone SVG media export boundary. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
const preloadSource = [
  'electron/preload.ts',
  ...readdirSync(path.resolve(process.cwd(), 'electron/preload')).filter((f) => f.endsWith('.ts')).map((f) => 'electron/preload/' + f),
].map((f) => readFileSync(path.resolve(process.cwd(), f), 'utf8')).join('\n');
const contractSource = readFileSync(path.resolve(process.cwd(), 'engine/runtime/OutcomeRuntimeContract.ts'), 'utf8');
const mediaSource = readFileSync(path.resolve(process.cwd(), 'electron/OutcomeMediaService.ts'), 'utf8');

describe('outcomes:media:export-svg wiring', () => {
  it('keeps ownership and safe-svg validation on every boundary before writing', () => {
    expect(mainSource).toContain("ipcMain.handle('outcomes:media:export-svg'");
    const handlerStart = mainSource.indexOf("ipcMain.handle('outcomes:media:export-svg'");
    const handler = mainSource.slice(handlerStart, mainSource.indexOf('ipcMain.handle(', handlerStart + 1));
    expect(handler).toContain('requireRendererMainFrame(event)');
    expect(handler).toContain('outcomeRepository.has(parsed.data.projectId, parsed.data.outcomeId)');
    expect(handler).toContain('readStandaloneSvg');
    expect(handler).toContain('exportStandaloneSvg(bytes)');
    expect(handler).toContain('roundTripStandaloneSvg(exported)');
    expect(handler).not.toContain('apiKey');
  });

  it('exposes a strict preload bridge over the dedicated channel', () => {
    expect(preloadSource).toContain('exportOutcomeMediaSvg');
    expect(preloadSource).toContain("'outcomes:media:export-svg'");
    expect(preloadSource).toContain('OutcomeMediaSvgExportResultSchema.safeParse');
  });

  it('declares the export result contract and the service-level svg reader', () => {
    expect(contractSource).toContain('OutcomeMediaSvgExportResultSchema');
    expect(mediaSource).toContain("async readStandaloneSvg(projectId:string,outcomeId:string, mediaId:string)");
    expect(mediaSource).toContain("row.media_type!=='image/svg+xml'");
  });
});
