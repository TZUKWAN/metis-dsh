import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../../engine/export/renderers/ZipWriter.js';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomePptxService } from '../../electron/OutcomePptxService.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');

function entries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_558); index -= 1) {
    if (archive.readUInt32LE(index) === EOCD) { eocd = index; break; }
  }
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

function importedFixture(): Buffer {
  const zip = new ZipWriter();
  zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>'));
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
  zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="image"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"><a:alphaModFix amt="62500"/></a:blip><a:srcRect l="10000" t="20000" r="30000" b="10000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm rot="5400000" flipH="1" flipV="0"><a:off x="0" y="0"/><a:ext cx="3000000" cy="2000000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld></p:sld>'));
  zip.addFile('ppt/media/image1.png', PNG);
  return zip.toBuffer();
}

const transformedDocument: PptDocument = {
  type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null,
  pages: [{ id: 'slide-1', title: '图片变换', pageType: 'content', humanModified: false, status: 'complete', elements: [{
    id: 'image-1', type: 'image', x: 2, y: 2, width: 12, height: 8, locked: false,
    props: { mediaId: 'media-1', mediaType: 'image/png', displayName: 'image1.png', rotationDeg: 450, flipH: true, flipV: false, crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 }, opacity: 0.625, mask: 'ellipse' },
  }] }],
};

describe('OutcomePptxService image transforms', () => {
  it('imports rotation, flips, crop, opacity, and a supported mask without losing media extraction', () => {
    const imported = new OutcomePptxService().importBuffer(importedFixture());
    const element = imported.document.pages[0]?.elements[0];
    expect(imported.warnings).toEqual([]);
    expect(element?.props).toMatchObject({ extractedImage: true, extractedImageOrder: 1, mediaType: 'image/png', rotationDeg: 90, flipH: true, flipV: false, crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 }, opacity: 0.625, mask: 'ellipse' });
  });

  it('writes transforms into OOXML and preserves managed media bytes', async () => {
    const service = new OutcomePptxService({ resolveManagedImage: async (reference) => ({ ...reference, bytes: PNG }) });
    const exported = await service.exportManagedDocument(transformedDocument);
    const xml = entries(exported.bytes).get('ppt/slides/slide1.xml')?.toString('utf8') ?? '';
    expect(exported.warnings).toEqual([]);
    expect(entries(exported.bytes).get('ppt/media/image1.png')).toEqual(PNG);
    expect(xml).toContain('<a:blip r:embed="rId2"><a:alphaModFix amt="62500"/></a:blip>');
    expect(xml).toContain('<a:srcRect l="10000" t="20000" r="30000" b="10000"/>');
    expect(xml).toContain('<a:xfrm rot="5400000" flipH="1" flipV="0">');
    expect(xml).toContain('<a:prstGeom prst="ellipse">');
  });

  it('round-trips transform values through OOXML unit quantization', async () => {
    const service = new OutcomePptxService({ resolveManagedImage: async (reference) => ({ ...reference, bytes: PNG }) });
    const exported = await service.exportManagedDocument(transformedDocument);
    const imported = service.importBuffer(exported.bytes);
    const props = imported.document.pages[0]?.elements[0]?.props as Record<string, unknown>;
    expect(props.rotationDeg).toBe(90);
    expect(props.flipH).toBe(true);
    expect(props.flipV).toBe(false);
    expect(props.crop).toEqual({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.1 });
    expect(props.opacity).toBe(0.625);
    expect(props.mask).toBe('ellipse');
  });

  it('rejects invalid transform values and emits an honest downgrade warning', async () => {
    const source: PptDocument = { ...transformedDocument, pages: [{ ...transformedDocument.pages[0]!, elements: [{ ...transformedDocument.pages[0]!.elements[0]!, props: { mediaId: 'media-1', mediaType: 'image/png', displayName: 'image1.png', rotationDeg: Number.NaN, crop: { left: 0.8, top: 0, right: 0.3, bottom: 0 }, opacity: 2, mask: 'freeform' } }] }] };
    const exported = await new OutcomePptxService({ resolveManagedImage: async (reference) => ({ ...reference, bytes: PNG }) }).exportManagedDocument(source);
    const xml = entries(exported.bytes).get('ppt/slides/slide1.xml')?.toString('utf8') ?? '';
    expect(exported.warnings.map((item) => item.code)).toContain('unsupported_image');
    expect(xml).not.toContain('rot="');
    expect(xml).not.toContain('<a:srcRect');
    expect(xml).not.toContain('alphaModFix');
    expect(xml).toContain('<a:prstGeom prst="rect">');
  });
});
