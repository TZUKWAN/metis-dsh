import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeMediaService } from '../../electron/OutcomeMediaService.js';
import { OutcomeWordDocxService } from '../../electron/OutcomeWordDocxService.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';

describe('OutcomeMediaService', () => {
  let db: Database.Database; let root: string; let input: string; let outcomes: OutcomeRepository; let media: OutcomeMediaService; let outcomeId: string; let foreignOutcomeId: string;
  const word = { type: 'other' as const, text: '', media: null };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-outcome-media-')); input = path.join(root, 'input'); await fs.mkdir(input);
    db = new Database(':memory:'); db.exec(SCHEMA_SQL);
    for (const id of ['project-a','project-b']) db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,'','','active','','','{}',1,1,1,'user');
    outcomes = new OutcomeRepository(db); outcomeId = outcomes.create({ projectId:'project-a', categoryId:null, title:'附件', kind:'pdf', content:word, note:'' }).outcome.id; foreignOutcomeId = outcomes.create({ projectId:'project-b', categoryId:null, title:'外部附件', kind:'pdf', content:word, note:'' }).outcome.id; media = new OutcomeMediaService(db, path.join(root,'managed'));
  });
  afterEach(async () => { db?.close(); if (root) await fs.rm(root,{recursive:true,force:true}); });
  it('copies a signature-verified PNG into project-private media and reads a data URL', async () => {
    const file = path.join(input,'figure.png'); await fs.writeFile(file,Buffer.from([137,80,78,71,13,10,26,10,0,0]));
    const imported = await media.importFromDialog('project-a',outcomeId,file);
    expect(imported).toMatchObject({ mediaType:'image/png', displayName:'figure.png' });
    const data = await media.readDataUrl('project-a',outcomeId,imported!.id);
    expect(data).toMatch(/^data:image\/png;base64,/u);
  });
  it('rejects a forged extension and never writes an outcome media row', async () => {
    const file = path.join(input,'forged.png'); await fs.writeFile(file,Buffer.from('%PDF-1.7 fake'));
    expect(await media.importFromDialog('project-a',outcomeId,file)).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM outcome_media').get() as {n:number}).n).toBe(0);
  });
  it('does not reveal project-private media through another project or outcome', async () => {
    const file = path.join(input,'paper.pdf'); await fs.writeFile(file,Buffer.from('%PDF-1.7\nbody'));
    const imported = await media.importFromDialog('project-a',outcomeId,file);
    expect(imported).toBeTruthy();
    expect(await media.readDataUrl('project-b',outcomeId,imported!.id)).toBeUndefined();
    expect(await media.importFromDialog('project-b',outcomeId,file)).toBeUndefined();
  });
  it('persists a safe SVG, serves it as an SVG data URL, and resolves it for PPTX export', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>');
    const imported = await media.persistGenerated('project-a', outcomeId, svg, 'image/svg+xml', 'figure.svg');
    expect(imported).toMatchObject({ mediaType:'image/svg+xml', displayName:'figure.svg', byteLength: svg.length });
    expect(await media.readDataUrl('project-a', outcomeId, imported!.id)).toBe(`data:image/svg+xml;base64,${svg.toString('base64')}`);
    const resolved = await media.readImageForPptxExport('project-a', outcomeId, { mediaId: imported!.id, mediaType: 'image/svg+xml', displayName: 'figure.svg' });
    expect(resolved?.bytes).toEqual(svg);
  });
  it('rejects unsafe SVG before writing a project media row', async () => {
    const file = path.join(input,'unsafe.svg'); await fs.writeFile(file,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>'));
    expect(await media.importFromDialog('project-a',outcomeId,file)).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM outcome_media').get() as {n:number}).n).toBe(0);
  });
  it('returns image bytes for PPTX export only when the durable handle belongs to the exact project and outcome', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
    const imported = await media.persistGenerated('project-a', outcomeId, png, 'image/png', 'figure.png');
    expect(imported).toMatchObject({ mediaType: 'image/png', displayName: 'figure.png' });
    const reference = { mediaId: imported!.id, mediaType: 'image/png' as const, displayName: 'figure.png' };
    const resolved = await media.readImageForPptxExport('project-a', outcomeId, reference);
    expect(resolved?.bytes).toEqual(png);
    expect(await media.readImageForPptxExport('project-a', outcomeId, { ...reference, displayName: 'forged.png' })).toBeUndefined();
    expect(await media.readImageForPptxExport('project-b', foreignOutcomeId, reference)).toBeUndefined();
  });
  it('reads one exact project-owned safe SVG for standalone export and rejects foreign or non-SVG handles', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>');
    const persisted = await media.persistGenerated('project-a', outcomeId, svg, 'image/svg+xml', 'figure.svg');
    expect(await media.readStandaloneSvg('project-a', outcomeId, persisted!.id)).toEqual(svg);
    expect(await media.readStandaloneSvg('project-b', foreignOutcomeId, persisted!.id)).toBeUndefined();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
    const persistedPng = await media.persistGenerated('project-a', outcomeId, png, 'image/png', 'figure.png');
    expect(await media.readStandaloneSvg('project-a', outcomeId, persistedPng!.id)).toBeUndefined();
  });
  it('keeps DOCX preview DB-free, then exports exact project-owned bytes after explicit media commit', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
    const source: WordDocument = { type: 'word', page: {}, header: '', footer: '', blocks: [{ id: 'image-1', kind: 'image', imageRef: 'media-source', mediaType: 'image/png', displayName: 'figure.png' }] };
    const service = new OutcomeWordDocxService({ resolveManagedImage: async (mediaId) => {
      const resolved = await media.readImageForWordDocxExport('project-a', outcomeId, mediaId);
      return resolved;
    } });
    const before = (db.prepare('SELECT count(*) AS n FROM outcome_media').get() as { n: number }).n;
    const preview = await new OutcomeWordDocxService({ resolveManagedImage: async (mediaId) => mediaId === 'media-source' ? { mediaId, mediaType: 'image/png', displayName: 'figure.png', bytes: png } : undefined }).exportManagedDocument(source);
    expect((db.prepare('SELECT count(*) AS n FROM outcome_media').get() as { n: number }).n).toBe(before);
    const imported = service.importBuffer(preview.bytes);
    const persisted = await media.persistGenerated('project-a', outcomeId, png, 'image/png', 'figure.png');
    expect(persisted).toBeTruthy();
    const committed: WordDocument = { ...imported.document, blocks: imported.document.blocks.map((block) => block.kind === 'image' ? { ...block, imageRef: persisted!.id } : block) };
    const exported = await service.exportManagedDocument(committed);
    const entries = new Map<string, Buffer>();
    let eocd = -1; for (let index = exported.bytes.length - 22; index >= 0; index -= 1) if (exported.bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
    const count = exported.bytes.readUInt16LE(eocd + 10); let offset = exported.bytes.readUInt32LE(eocd + 16);
    for (let index = 0; index < count; index += 1) { const method = exported.bytes.readUInt16LE(offset + 10); const size = exported.bytes.readUInt32LE(offset + 20); const nameLength = exported.bytes.readUInt16LE(offset + 28); const extra = exported.bytes.readUInt16LE(offset + 30); const comment = exported.bytes.readUInt16LE(offset + 32); const header = exported.bytes.readUInt32LE(offset + 42); const name = exported.bytes.subarray(offset + 46, offset + 46 + nameLength).toString(); const start = header + 30 + exported.bytes.readUInt16LE(header + 26) + exported.bytes.readUInt16LE(header + 28); const compressed = exported.bytes.subarray(start, start + size); entries.set(name, method === 0 ? compressed : inflateRawSync(compressed)); offset += 46 + nameLength + extra + comment; }
    expect(entries.get('word/media/image1.png')).toEqual(png);
    expect(entries.get('word/_rels/document.xml.rels')?.toString()).toContain('/image" Target="media/image1.png"');
  });
  it('purgeFiles unlinks managed files for a permanently deleted outcome and ignores missing ones', async () => {
    const file = path.join(input,'purge-me.png'); await fs.writeFile(file,Buffer.from([137,80,78,71,13,10,26,10,0,0]));
    const imported = await media.importFromDialog('project-a',outcomeId,file);
    expect(imported).toBeTruthy();
    const row = db.prepare('SELECT stored_name FROM outcome_media WHERE id = ?').get(imported!.id) as { stored_name: string };
    const managedFile = path.join(root,'managed','project-a',row.stored_name);
    await expect(fs.access(managedFile)).resolves.toBeUndefined();
    outcomes.archive('project-a', outcomeId);
    const storedNames = outcomes.deletePermanent('project-a', outcomeId);
    expect(storedNames).toEqual([row.stored_name]);
    await media.purgeFiles('project-a', storedNames!);
    await expect(fs.access(managedFile)).rejects.toThrow();
    // 重复清理与不存在的文件名都是安全 no-op
    await media.purgeFiles('project-a', storedNames!);
    await media.purgeFiles('project-a', ['not-there.png']);
  });
});
