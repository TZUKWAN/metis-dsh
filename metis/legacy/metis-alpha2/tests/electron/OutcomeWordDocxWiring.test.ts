/** Boundary evidence for the Outcomes DOCX import/export wiring. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
const preloadSource = [
  'electron/preload.ts',
  ...readdirSync(path.resolve(process.cwd(), 'electron/preload')).filter((f) => f.endsWith('.ts')).map((f) => 'electron/preload/' + f),
].map((f) => readFileSync(path.resolve(process.cwd(), f), 'utf8')).join('\n');
const pageSource = readFileSync(path.resolve(process.cwd(), 'src/pages/OutcomesPage.tsx'), 'utf8');
const contractSource = readFileSync(path.resolve(process.cwd(), 'engine/runtime/OutcomeRuntimeContract.ts'), 'utf8');

function handlerBlock(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) throw new Error(`handler not registered: ${channel}`);
  const end = source.indexOf('ipcMain.handle(', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

function functionBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`function marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('Outcomes DOCX managed-image boundary wiring', () => {
  it('routes DOCX import through a tokenized media commit before persistence', () => {
    const importHandler = handlerBlock(mainSource, 'outcomes:word:docx:import');
    const importPageFlow = functionBlock(pageSource, 'const importWordDocx = useCallback', 'const exportWordDocx = useCallback');

    expect(importHandler).toContain('const bytes = await fs.promises.readFile(filePath)');
    expect(importHandler).toContain('new OutcomeWordDocxService().importBufferV2(bytes)');
    expect(importHandler).toContain('importToken');
    expect(importHandler).toContain('preview');
    expect(importHandler).not.toContain('return OutcomeWordDocxImportResultSchema.parse({ ok: true, filePath');
    expect(importHandler).not.toContain('return OutcomeWordDocxImportResultSchema.parse({ ok: true, bytes');
    expect(importHandler).toContain('wordDocxImportSessions.set');
    const commitHandler = handlerBlock(mainSource, 'outcomes:word:docx:import:commitMedia');
    // The commit must reuse the exact import-time snapshot, never re-read the path.
    expect(commitHandler).toContain('commitImportedMedia(session.bytes');
    expect(commitHandler).not.toContain('readFile(session.filePath)');
    expect(commitHandler).toContain('commitImportedMedia');
    expect(commitHandler).toContain('removeGenerated');

    expect(importPageFlow).toContain('window.metis.importOutcomeWordDocx');
    expect(importPageFlow).toContain('window.metis.commitOutcomeWordDocxImportMedia');
    expect(importPageFlow).toContain('save(committedMedia.document');
    expect(importPageFlow).toContain('window.metis.createOutcome');
    expect(importPageFlow).toContain('importToken: imported.importToken');

    const wordEditor = functionBlock(pageSource, 'function WordEditor(', 'function LocalWordAssistantPopover(');
    expect(wordEditor).toContain('block.kind === \'image\'');
    expect(pageSource).toContain('readOutcomeMedia');
    expect(pageSource).toContain('docx-import-image-');

    expect(contractSource).toContain('OutcomeWordDocxImportCommitRequestSchema');
    expect(contractSource).toContain('OutcomeWordDocxImportPreviewSchema');
    expect(preloadSource).toContain('commitOutcomeWordDocxImportMedia');
    expect(preloadSource).toContain("'outcomes:word:docx:import:commitMedia'");
  });

  it('routes DOCX export through the exact project/outcome-owned managed image resolver', () => {
    const exportHandler = handlerBlock(mainSource, 'outcomes:word:docx:export');

    expect(exportHandler).toContain('new OutcomeWordDocxService({');
    expect(exportHandler).toContain('resolveManagedImage');
    expect(exportHandler).toContain('readImageForWordDocxExport');
    expect(exportHandler).toContain('parsed.data.projectId');
    expect(exportHandler).toContain('parsed.data.outcomeId');
    expect(exportHandler).toContain('exportFile(filePath, detail.version.content)');
    expect(exportHandler).not.toContain('new OutcomeWordDocxService().exportFile');
  });

  it('keeps codec-level media commit and rollback as a lower-layer contract only', () => {
    const codecSource = readFileSync(path.resolve(process.cwd(), 'electron/OutcomeWordDocxService.ts'), 'utf8');
    const mediaSource = readFileSync(path.resolve(process.cwd(), 'electron/OutcomeMediaService.ts'), 'utf8');

    expect(codecSource).toContain('commitImportedMedia');
    expect(codecSource).toContain('OutcomeWordDocxMediaRollback');
    expect(codecSource).toContain('await rollback(created)');
    expect(mediaSource).toContain('readImageForWordDocxExport');
    expect(mediaSource).toContain('project_id = ? AND outcome_id = ?');
  });
});
