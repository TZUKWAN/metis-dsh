import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../../engine/export/renderers/ZipWriter.js';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomePptxService } from '../../electron/OutcomePptxService.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function zipNames(archive: Buffer): string[] {
  let eocd = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_558); index -= 1) if (archive.readUInt32LE(index) === EOCD) { eocd = index; break; }
  if (eocd < 0) throw new Error('ZIP EOCD missing');
  const count = archive.readUInt16LE(eocd + 10); let offset = archive.readUInt32LE(eocd + 16); const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL) throw new Error('ZIP central directory invalid');
    const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')); offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
function zipEntries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_558); index -= 1) if (archive.readUInt32LE(index) === EOCD) { eocd = index; break; }
  if (eocd < 0) throw new Error('ZIP EOCD missing');
  const count = archive.readUInt16LE(eocd + 10); let offset = archive.readUInt32LE(eocd + 16); const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL) throw new Error('ZIP central directory invalid');
    const method = archive.readUInt16LE(offset + 10); const compressedSize = archive.readUInt32LE(offset + 20); const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32); const header = archive.readUInt32LE(offset + 42); const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (archive.readUInt32LE(header) !== LOCAL) throw new Error('ZIP local header invalid');
    const dataStart = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28); const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    result.set(name, method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP method ${method}`); })());
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

const roundTripDocument: PptDocument = {
  type: 'ppt', ratio: '4:3', theme: { primary: '#124D72', accent: '#F28E2B' }, templateId: null, generationSkillId: null,
  pages: [
    { id: 'slide-1', title: '研究问题', pageType: 'cover', humanModified: false, status: 'complete', elements: [
      { id: 'text-1', type: 'text', x: 2, y: 4, width: 18, height: 2, locked: false, props: { text: '问题、证据与结论' } },
      { id: 'rect-1', type: 'rect', x: 3, y: 8, width: 8, height: 3, locked: false, props: { text: '证据' } },
      { id: 'arrow-1', type: 'arrow', x: 12, y: 9, width: 6, height: 1, locked: false, props: {} },
    ] },
    { id: 'slide-2', title: '研究方法', pageType: 'method', humanModified: false, status: 'complete', elements: [
      { id: 'ellipse-1', type: 'ellipse', x: 4, y: 4, width: 5, height: 4, locked: false, props: { text: '样本' } },
      { id: 'line-1', type: 'line', x: 10, y: 6, width: 8, height: 1, locked: false, props: {} },
    ] },
  ],
};

describe('OutcomePptxService', () => {
  it('writes a real PresentationML package and maps its basic PPT Grid data back', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'metis-outcome-pptx-'));
    try {
      const target = path.join(temporary, 'research-deck.pptx'); const service = new OutcomePptxService(); const exported = await service.exportFile(target, roundTripDocument); const archive = await readFile(target);
      expect(exported.warnings).toEqual([]);
      expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(archive.readUInt32LE(archive.length - 22)).toBe(EOCD);
      expect(zipNames(archive)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']));
      const imported = await service.importFile(target);
      expect(imported.warnings).toEqual([]);
      expect(imported.document).toMatchObject({ type: 'ppt', ratio: '4:3', theme: { primary: '#124D72', accent: '#F28E2B' }, pages: [
        { title: '研究问题', pageType: 'cover', elements: [expect.objectContaining({ type: 'text', props: { text: '问题、证据与结论' } }), expect.objectContaining({ type: 'rect', props: { text: '证据' } }), expect.objectContaining({ type: 'arrow' })] },
        { title: '研究方法', pageType: 'content', elements: [expect.objectContaining({ type: 'ellipse', props: { text: '样本' } }), expect.objectContaining({ type: 'line' })] },
      ] });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it('returns downgrade warnings for image/chart-like grid elements rather than pretending binary fidelity', () => {
    const source: PptDocument = { ...roundTripDocument, pages: [{ ...roundTripDocument.pages[0]!, elements: [{ id: 'image-1', type: 'image', x: 1, y: 1, width: 4, height: 4, locked: false, props: { text: '图像' } }, { id: 'chart-1', type: 'chart', x: 8, y: 1, width: 8, height: 4, locked: false, props: {} }] }] };
    const exported = new OutcomePptxService().exportDocument(source);
    expect(exported.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['unsupported_image', 'unsupported_chart']));
  });

  it('embeds a resolver-verified managed PNG as a real PPTX media part and picture relationship', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
    const source: PptDocument = { ...roundTripDocument, ratio: '4:3', pages: [{ ...roundTripDocument.pages[0]!, elements: [{ id: 'managed-image', type: 'image', x: 20, y: 12, width: 4, height: 5, locked: false, props: { mediaId: 'om-managed-png', mediaType: 'image/png', displayName: 'figure.png' } }] }] };
    const service = new OutcomePptxService({ resolveManagedImage: async (reference) => reference.mediaId === 'om-managed-png' ? { ...reference, bytes: png } : undefined });
    const exported = await service.exportManagedDocument(source); const entries = zipEntries(exported.bytes);
    expect(exported.warnings).toEqual([]);
    expect(entries.get('ppt/media/image1.png')).toEqual(png);
    expect(entries.get('[Content_Types].xml')?.toString('utf8')).toContain('Extension="png" ContentType="image/png"');
    expect(entries.get('ppt/slides/_rels/slide1.xml.rels')?.toString('utf8')).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"');
    const slide = entries.get('ppt/slides/slide1.xml')?.toString('utf8') ?? '';
    expect(slide).toContain('<p:pic>');
    expect(slide).toContain('<a:blip r:embed="rId2"/>');
    expect(slide).toContain('<a:off x="7620000" y="4572000"/><a:ext cx="1524000" cy="1905000"/>');
    expect(exported.bytes.toString('utf8')).not.toContain(path.resolve(os.tmpdir()));
  });

  it('embeds a resolver-verified safe SVG with SVG content type and relationship', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>');
    const source: PptDocument = { ...roundTripDocument, pages: [{ ...roundTripDocument.pages[0]!, elements: [{ id: 'managed-svg', type: 'image', x: 1, y: 1, width: 5, height: 5, locked: false, props: { mediaId: 'om-managed-svg', mediaType: 'image/svg+xml', displayName: 'figure.svg' } }] }] };
    const exported = await new OutcomePptxService({ resolveManagedImage: async (reference) => reference.mediaId === 'om-managed-svg' ? { ...reference, bytes: svg } : undefined }).exportManagedDocument(source);
    const entries = zipEntries(exported.bytes);
    expect(exported.warnings).toEqual([]);
    expect(entries.get('ppt/media/image1.svg')).toEqual(svg);
    expect(entries.get('[Content_Types].xml')?.toString('utf8')).toContain('Extension="svg" ContentType="image/svg+xml"');
    expect(entries.get('ppt/slides/_rels/slide1.xml.rels')?.toString('utf8')).toContain('Target="../media/image1.svg"');
    expect(entries.get('ppt/slides/slide1.xml')?.toString('utf8')).toContain('<a:blip r:embed="rId2"/>');
  });

  it('keeps a visible image placeholder when the scoped resolver rejects a media reference', async () => {
    const source: PptDocument = { ...roundTripDocument, pages: [{ ...roundTripDocument.pages[0]!, elements: [{ id: 'foreign-image', type: 'image', x: 1, y: 1, width: 4, height: 4, locked: false, props: { mediaId: 'om-foreign', mediaType: 'image/jpeg', displayName: 'foreign.jpg' } }] }] };
    const exported = await new OutcomePptxService({ resolveManagedImage: async () => undefined }).exportManagedDocument(source);
    expect(exported.warnings.map((item) => item.code)).toContain('unsupported_image');
    expect(zipNames(exported.bytes)).not.toContain('ppt/media/image1.jpg');
    expect(zipEntries(exported.bytes).get('ppt/slides/slide1.xml')?.toString('utf8')).not.toContain('<p:pic>');
  });

  it('warns when an imported deck contains a real image and animation that the grid cannot faithfully preserve', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'metis-outcome-pptx-warning-'));
    try {
      const target = path.join(temporary, 'rich.pptx'); const zip = new ZipWriter();
      zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>'));
      zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
      zip.addFile('ppt/slides/slide1.xml', Buffer.from('<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="图片"/></p:nvPicPr><p:blipFill/><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld><p:timing/></p:sld>'));
      await writeFile(target, zip.toBuffer());
      const imported = await new OutcomePptxService().importFile(target);
      expect(imported.document.pages[0]?.elements).toContainEqual(expect.objectContaining({ type: 'image', props: expect.objectContaining({ importedImage: true }) }));
      expect(imported.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['unsupported_image', 'unsupported_animation']));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it('rejects buffers that are not PPTX ZIP archives', () => {
    expect(() => new OutcomePptxService().importBuffer(Buffer.from('not a pptx'))).toThrow('pptx_zip_invalid');
  });
});
