import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeMediaService } from '../../electron/OutcomeMediaService.js';
import { OutcomePptxService, extractSlideImages } from '../../electron/OutcomePptxService.js';
import { ZipWriter } from '../../engine/export/renderers/ZipWriter.js';

// A real PNG (valid signature) plus a slide that references it as a <p:pic><a:blip>.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
const SLIDE = '<p:sld><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>';
const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="../media/image1.png"/></Relationships>';
// The verified-safe static SVG sample shape from OutcomeSvgSecurity.test.ts, plus a script-bearing variant that must never survive extraction.
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="#123456"/></svg>');
const UNSAFE_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>');
const SVG_RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="../media/image1.svg"/></Relationships>';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
function zipEntries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_558); index -= 1) if (archive.readUInt32LE(index) === EOCD) { eocd = index; break; }
  if (eocd < 0) throw new Error('PPTX EOCD missing');
  const count = archive.readUInt16LE(eocd + 10); let offset = archive.readUInt32LE(eocd + 16); const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL) throw new Error('PPTX central directory invalid');
    const method = archive.readUInt16LE(offset + 10); const compressedSize = archive.readUInt32LE(offset + 20); const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32); const header = archive.readUInt32LE(offset + 42); const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (archive.readUInt32LE(header) !== LOCAL) throw new Error('PPTX local header invalid');
    const dataOffset = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28); const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    result.set(name, method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP method ${method}`); })());
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

describe('PPTX reverse-image import -> OutcomeMedia write-back loop', () => {
  let db: Database.Database; let root: string; let repository: OutcomeRepository; let media: OutcomeMediaService; let outcomeId: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-pptx-media-'));
    db = new Database(':memory:'); db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('project-a','p','','','active','','','{}',1,1,1,'user');
    repository = new OutcomeRepository(db);
    outcomeId = repository.create({ projectId:'project-a', categoryId:null, title:'演示', kind:'ppt', content:{ type:'ppt', ratio:'16:9', theme:{}, templateId:null, generationSkillId:null, pages:[] }, note:'' }).outcome.id;
    media = new OutcomeMediaService(db, path.join(root, 'managed'));
  });
  afterEach(async () => { db?.close(); if (root) await fs.rm(root, { recursive:true, force:true }); });

  it('extracts a picture, persists it into project media, and reads it back for export', async () => {
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(SLIDE)],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS)],
      ['ppt/media/image1.png', PNG],
    ]);
    const extracted = extractSlideImages(entries, 'ppt/slides/slide1.xml', SLIDE);
    expect(extracted).toHaveLength(1);
    const { mediaType, displayName, bytes } = extracted[0]!;
    const persisted = await media.persistGenerated('project-a', outcomeId, bytes, mediaType, displayName);
    expect(persisted).toMatchObject({ mediaType: 'image/png', displayName: 'image1.png' });
    const reference = { mediaId: persisted!.id, mediaType: mediaType as 'image/png', displayName };
    const readBack = await media.readImageForPptxExport('project-a', outcomeId, reference);
    expect(readBack?.bytes).toEqual(PNG);
  });

  it('keeps the extracted media out of a different project (isolation)', async () => {
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(SLIDE)],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS)],
      ['ppt/media/image1.png', PNG],
    ]);
    const extracted = extractSlideImages(entries, 'ppt/slides/slide1.xml', SLIDE);
    const persisted = await media.persistGenerated('project-a', outcomeId, extracted[0]!.bytes, extracted[0]!.mediaType, extracted[0]!.displayName);
    const reference = { mediaId: persisted!.id, mediaType: extracted[0]!.mediaType, displayName: extracted[0]!.displayName };
    expect(await media.readImageForPptxExport('project-b', outcomeId, reference)).toBeUndefined();
  });

  it('commits extracted image markers into managed media and records an import version', async () => {
    const archive = new ZipWriter();
    archive.addFile('ppt/slides/slide1.xml', Buffer.from(SLIDE));
    archive.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS));
    archive.addFile('ppt/media/image1.png', PNG);
    const source = path.join(root, 'import.pptx');
    await fs.writeFile(source, archive.toBuffer());
    const document = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '图片', pageType: 'content', humanModified: false, status: 'complete' as const, elements: [{ id: 'image-1', type: 'image' as const, x: 1, y: 1, width: 4, height: 4, locked: false, props: { extractedImage: true, extractedImageOrder: 1, importedImage: true, mediaType: 'image/png', mediaName: 'image1.png', text: '图片占位' } }] }] };
    repository.reserve({ projectId: 'project-a', outcomeId: 'out-import', categoryId: null, title: '导入', kind: 'ppt' });
    const committed = await new OutcomePptxService().commitImportedMedia(source, document, async (image) => {
      const saved = await media.persistGenerated('project-a', 'out-import', image.bytes, image.mediaType, image.displayName);
      return saved ? { id: saved.id, mediaType: image.mediaType, displayName: saved.displayName } : undefined;
    });
    const imageProps = committed.pages[0]!.elements[0]!.props as Record<string, unknown>;
    expect(imageProps.mediaId).toEqual(expect.any(String));
    expect(imageProps.extractedImage).toBeUndefined();
    const created = repository.create({ projectId: 'project-a', outcomeId: 'out-import', categoryId: null, title: '导入', kind: 'ppt', content: committed, note: '导入 import.pptx', actor: 'import' });
    expect(created.version.createdBy).toBe('import');
    expect((db.prepare("SELECT operation FROM outcome_changes WHERE outcome_id = 'out-import'").get() as { operation: string }).operation).toBe('import');
    const readBack = await media.readImageForPptxExport('project-a', 'out-import', { mediaId: String(imageProps.mediaId), mediaType: 'image/png', displayName: 'image1.png' });
    expect(readBack?.bytes).toEqual(PNG);
  });

  it('round-trips the imported picture binary back into an exported PPTX media part unchanged', async () => {
    const archive = new ZipWriter();
    archive.addFile('ppt/slides/slide1.xml', Buffer.from(SLIDE));
    archive.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS));
    archive.addFile('ppt/media/image1.png', PNG);
    const source = path.join(root, 'roundtrip.pptx');
    await fs.writeFile(source, archive.toBuffer());
    const document = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '图片', pageType: 'content', humanModified: false, status: 'complete' as const, elements: [{ id: 'image-1', type: 'image' as const, x: 1, y: 1, width: 4, height: 4, locked: false, props: { extractedImage: true, extractedImageOrder: 1 } }] }] };
    repository.reserve({ projectId: 'project-a', outcomeId: 'out-roundtrip', categoryId: null, title: '回环', kind: 'ppt' });
    const committed = await new OutcomePptxService().commitImportedMedia(source, document, async (image) => {
      const saved = await media.persistGenerated('project-a', 'out-roundtrip', image.bytes, image.mediaType, image.displayName);
      return saved ? { id: saved.id, mediaType: image.mediaType, displayName: saved.displayName } : undefined;
    });
    repository.create({ projectId: 'project-a', outcomeId: 'out-roundtrip', categoryId: null, title: '回环', kind: 'ppt', content: committed, note: '导入 roundtrip.pptx', actor: 'import' });
    const exported = await new OutcomePptxService({ resolveManagedImage: (reference) => media.readImageForPptxExport('project-a', 'out-roundtrip', reference) }).exportManagedDocument(committed);
    expect(exported.warnings.filter((warning) => warning.code === 'unsupported_image')).toEqual([]);
    const entries = zipEntries(exported.bytes);
    expect(entries.get('ppt/media/image1.png')).toEqual(PNG);
    expect(entries.get('ppt/slides/slide1.xml')?.toString('utf8')).toContain('<p:pic>');
    expect(entries.get('ppt/slides/_rels/slide1.xml.rels')?.toString('utf8')).toContain('Target="../media/image1.png"');
  });

  it('does not write media during preview parsing and keeps invalid pictures as placeholders', async () => {
    const before = (db.prepare('SELECT count(*) AS n FROM outcome_media').get() as { n: number }).n;
    const invalidSlide = SLIDE.replace('rId2', 'missing');
    expect((db.prepare('SELECT count(*) AS n FROM outcome_media').get() as { n: number }).n).toBe(before);
    expect(extractSlideImages(new Map([['ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS)]]), 'ppt/slides/slide1.xml', invalidSlide)).toHaveLength(0);
  });

  it('fails closed when media persistence rejects a valid extracted picture', async () => {
    const archive = new ZipWriter();
    archive.addFile('ppt/slides/slide1.xml', Buffer.from(SLIDE));
    archive.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS));
    archive.addFile('ppt/media/image1.png', PNG);
    const source = path.join(root, 'failed-import.pptx');
    await fs.writeFile(source, archive.toBuffer());
    const document = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '图片', pageType: 'content', humanModified: false, status: 'complete' as const, elements: [{ id: 'image-1', type: 'image' as const, x: 1, y: 1, width: 4, height: 4, locked: false, props: { extractedImage: true, extractedImageOrder: 1 } }] }] };
    await expect(new OutcomePptxService().commitImportedMedia(source, document, async () => undefined)).rejects.toThrow('pptx_media_persist_failed');
    expect((db.prepare('SELECT count(*) AS n FROM outcome_media').get() as { n: number }).n).toBe(0);
  });

  it('extracts a safe SVG, persists it as image/svg+xml, reads back identical bytes, and exports a real ppt/media/*.svg part with an svg content-type default', async () => {
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(SLIDE)],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(SVG_RELS)],
      ['ppt/media/image1.svg', SVG],
    ]);
    const extracted = extractSlideImages(entries, 'ppt/slides/slide1.xml', SLIDE);
    expect(extracted).toHaveLength(1);
    const { mediaType, displayName, bytes } = extracted[0]!;
    expect(mediaType).toBe('image/svg+xml');
    expect(displayName).toBe('image1.svg');
    const persisted = await media.persistGenerated('project-a', outcomeId, bytes, mediaType, displayName);
    expect(persisted).toMatchObject({ mediaType: 'image/svg+xml', displayName: 'image1.svg' });
    const reference = { mediaId: persisted!.id, mediaType: mediaType as 'image/svg+xml', displayName };
    const readBack = await media.readImageForPptxExport('project-a', outcomeId, reference);
    expect(readBack?.bytes).toEqual(SVG);
    const document = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '矢量图', pageType: 'content', humanModified: false, status: 'complete' as const, elements: [{ id: 'image-svg', type: 'image' as const, x: 1, y: 1, width: 5, height: 5, locked: false, props: { mediaId: persisted!.id, mediaType: 'image/svg+xml', displayName: 'image1.svg' } }] }] };
    const exported = await new OutcomePptxService({ resolveManagedImage: (managed) => media.readImageForPptxExport('project-a', outcomeId, managed) }).exportManagedDocument(document);
    expect(exported.warnings).toEqual([]);
    const exportedEntries = zipEntries(exported.bytes);
    expect(exportedEntries.get('ppt/media/image1.svg')).toEqual(SVG);
    expect(exportedEntries.get('[Content_Types].xml')?.toString('utf8')).toContain('Extension="svg" ContentType="image/svg+xml"');
    expect(exportedEntries.get('ppt/slides/_rels/slide1.xml.rels')?.toString('utf8')).toContain('Target="../media/image1.svg"');
    expect(exportedEntries.get('ppt/slides/slide1.xml')?.toString('utf8')).toContain('<a:blip r:embed="rId2"/>');
  });

  it('rejects an unsafe script-bearing SVG at extraction and never persists it through commit or direct write-back', async () => {
    const unsafeEntries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(SLIDE)],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(SVG_RELS)],
      ['ppt/media/image1.svg', UNSAFE_SVG],
    ]);
    // Extraction-stage rejection: the slide picture is dropped instead of being surfaced for persistence.
    expect(extractSlideImages(unsafeEntries, 'ppt/slides/slide1.xml', SLIDE)).toHaveLength(0);
    // Defense in depth: even a direct persist attempt fails closed on the same bytes.
    expect(await media.persistGenerated('project-a', outcomeId, UNSAFE_SVG, 'image/svg+xml', 'image1.svg')).toBeUndefined();
    const archive = new ZipWriter();
    archive.addFile('ppt/slides/slide1.xml', Buffer.from(SLIDE));
    archive.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(SVG_RELS));
    archive.addFile('ppt/media/image1.svg', UNSAFE_SVG);
    const source = path.join(root, 'unsafe-svg.pptx');
    await fs.writeFile(source, archive.toBuffer());
    const document = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '图片', pageType: 'content', humanModified: false, status: 'complete' as const, elements: [{ id: 'image-1', type: 'image' as const, x: 1, y: 1, width: 4, height: 4, locked: false, props: { extractedImage: true, extractedImageOrder: 1 } }] }] };
    let persistAttempts = 0;
    const committed = await new OutcomePptxService().commitImportedMedia(source, document, async (image) => {
      persistAttempts += 1;
      const saved = await media.persistGenerated('project-a', outcomeId, image.bytes, image.mediaType, image.displayName);
      return saved ? { id: saved.id, mediaType: image.mediaType, displayName: saved.displayName } : undefined;
    });
    expect(persistAttempts).toBe(0);
    const imageProps = committed.pages[0]!.elements[0]!.props as Record<string, unknown>;
    expect(imageProps.extractedImage).toBe(true);
    expect(imageProps.mediaId).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM outcome_media').get() as { n: number }).n).toBe(0);
  });
});
