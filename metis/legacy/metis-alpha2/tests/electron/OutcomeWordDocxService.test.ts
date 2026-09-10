import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../../engine/export/renderers/ZipWriter.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomeWordDocxService } from '../../electron/OutcomeWordDocxService.js';
import { applyWordFormatting } from '../../engine/outcomes/WordDocumentFormatting.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function zipEntries(archive: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_558); offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('ZIP EOCD missing');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('ZIP central directory invalid');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const header = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (archive.readUInt32LE(header) !== 0x04034b50) throw new Error('ZIP local header invalid');
    const start = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28);
    const compressed = archive.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP method ${method}`); })());
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
function zipNames(archive: Buffer): string[] { return [...zipEntries(archive).keys()]; }

const roundTripDocument: WordDocument = {
  type: 'word',
  page: { paper: 'A4', marginTop: 54, marginRight: 72, marginBottom: 90, marginLeft: 63, lineSpacing: 1.5, pageNumber: true },
  header: '研究报告',
  footer: 'METIS · 内部工作稿',
  blocks: [
    { id: 'heading-1', kind: 'heading', level: 1, text: '研究设计', style: { fontFamily: 'Aptos', fontSize: 18, bold: true, color: '#203864', align: 'center', spaceBefore: 12, spaceAfter: 6 } },
    { id: 'paragraph-1', kind: 'paragraph', text: '这是可往返的正文段落。', style: { fontFamily: 'SimSun', fontSize: 12, bold: true, italic: true, underline: true, color: '#663399', align: 'justify', indentLeft: 18, indentRight: 9, firstLineIndent: 24, lineSpacing: 1.25, spaceBefore: 6, spaceAfter: 8 } },
    { id: 'bullet-1', kind: 'paragraph', text: '项目符号', style: { list: 'bullet', listLevel: 0 } },
    { id: 'number-1', kind: 'paragraph', text: '编号项目', style: { list: 'numbered', listLevel: 0 } },
    { id: 'table-1', kind: 'table', rows: [['指标', '数值'], ['样本量', '120']] },
  ],
};

describe('OutcomeWordDocxService', () => {
  it('writes a real DOCX package and reads its common WordDocument subset back', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'metis-outcome-docx-'));
    try {
      const target = path.join(temporary, 'research-design.docx');
      const service = new OutcomeWordDocxService();
      const exported = await service.exportFile(target, roundTripDocument);
      const archive = await readFile(target);

      expect(exported.warnings).toEqual([]);
      expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(archive.readUInt32LE(archive.length - 22)).toBe(EOCD_SIGNATURE);
      expect(zipNames(archive)).toEqual(expect.arrayContaining([
        '[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml',
        'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels',
      ]));

      const imported = await service.importFile(target);
      expect(imported.warnings).toEqual([]);
      expect(imported.document.header).toBe('研究报告');
      expect(imported.document.footer).toBe('METIS · 内部工作稿');
      expect(imported.document.page).toMatchObject({ paper: 'A4', marginTop: 54, marginRight: 72, marginBottom: 90, marginLeft: 63, pageNumber: true });
      expect(imported.document.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'heading', level: 1, text: '研究设计', style: expect.objectContaining({ fontFamily: 'Aptos', fontSize: 18, bold: true, color: '#203864', align: 'center', spaceBefore: 12, spaceAfter: 6 }) }),
        expect.objectContaining({ kind: 'paragraph', text: '这是可往返的正文段落。', style: expect.objectContaining({ fontFamily: 'SimSun', fontSize: 12, bold: true, italic: true, underline: true, color: '#663399', align: 'justify', indentLeft: 18, indentRight: 9, firstLineIndent: 24, lineSpacing: 1.25, spaceBefore: 6, spaceAfter: 8 }) }),
        expect.objectContaining({ kind: 'paragraph', text: '项目符号', style: expect.objectContaining({ list: 'bullet' }) }),
        expect.objectContaining({ kind: 'paragraph', text: '编号项目', style: expect.objectContaining({ list: 'numbered' }) }),
        expect.objectContaining({ kind: 'table', rows: [['指标', '数值'], ['样本量', '120']] }),
      ]));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it('reports non-representable OOXML instead of claiming a lossless import', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'metis-outcome-docx-warning-'));
    try {
      const target = path.join(temporary, 'rich.docx');
      const zip = new ZipWriter();
      zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
      zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
      zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>粗体</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r><w:hyperlink w:anchor="target"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p><w:p><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>外部项目符号</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>'));
      zip.addFile('word/numbering.xml', Buffer.from('<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>'));
      await writeFile(target, zip.toBuffer());

      const imported = await new OutcomeWordDocxService().importFile(target);
      expect(imported.document.blocks.map((block) => block.text ?? '')).toContain('粗体斜体链接文字');
      expect(imported.document.blocks).toContainEqual(expect.objectContaining({ text: '外部项目符号', style: expect.objectContaining({ list: 'bullet' }) }));
      expect(imported.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['unsupported_inline_style', 'unsupported_hyperlink', 'unsupported_table_layout']));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  it('writes the METIS layout panel aliases into real OOXML rather than silently ignoring them', () => {
    const formatted = applyWordFormatting({
      type: 'word', page: {}, header: '', footer: '',
      blocks: [{ id: 'p-1', kind: 'paragraph', text: '结构化排版正文' }],
    }, { page: { paper: 'A4', marginTopCm: 2.54, marginLeftCm: 3.17 }, body: { fontFamily: '宋体', fontSizePt: 12, firstLineIndentChars: 2, lineSpacing: 1.5, spaceAfterPt: 6 } });
    const exported = new OutcomeWordDocxService().exportDocument(formatted.document);
    const xml = exported.bytes.toString('latin1');
    expect(xml).toContain('word/document.xml');
    const imported = new OutcomeWordDocxService().importBuffer(exported.bytes);
    expect(imported.document.blocks[0]?.style).toMatchObject({ fontFamily: '宋体', fontSize: 12, firstLineIndent: 24, lineSpacing: 1.5, spaceAfter: 6 });
    expect(imported.document.page).toMatchObject({ marginTop: 72 });
    expect(Number(imported.document.page.marginLeft)).toBeCloseTo(89.85, 2);
  });

  it('exports managed PNG bytes through a real inline drawing relationship and imports then commits it', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
    const source: WordDocument = { type: 'word', page: {}, header: '', footer: '', blocks: [{ id: 'image-1', kind: 'image', imageRef: 'media-1', mediaType: 'image/png', displayName: 'figure.png' }] };
    const service = new OutcomeWordDocxService({ resolveManagedImage: async (mediaId) => mediaId === 'media-1' ? { mediaId, mediaType: 'image/png', displayName: 'figure.png', bytes: png } : undefined });
    const exported = await service.exportManagedDocument(source);
    expect(exported.warnings).toEqual([]);
    const entries = zipEntries(exported.bytes);
    expect(entries.get('word/media/image1.png')).toEqual(png);
    expect(entries.get('[Content_Types].xml')?.toString()).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(entries.get('word/_rels/document.xml.rels')?.toString()).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"');
    expect(entries.get('word/document.xml')?.toString()).toContain('<wp:inline');
    expect(entries.get('word/document.xml')?.toString()).toContain('r:embed="rId5"');
    const imported = service.importBuffer(exported.bytes);
    expect(imported.warnings).toEqual([]);
    expect(imported.document.blocks).toContainEqual(expect.objectContaining({ kind: 'image', imageRef: 'docx-import-image-1', mediaType: 'image/png', displayName: 'figure.png' }));
    const persisted: string[] = [];
    const committed = await service.commitImportedMedia(exported.bytes, imported.document, async (image) => { persisted.push(image.imageRef); return { id: 'media-committed', mediaType: image.mediaType, displayName: image.displayName }; }, async () => undefined);
    expect(persisted).toEqual(['docx-import-image-1']);
    expect(committed.blocks).toContainEqual(expect.objectContaining({ kind: 'image', imageRef: 'media-committed', mediaType: 'image/png' }));
  });

  it('round-trips managed JPEG bytes with a jpg content type and relationship', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
    const source: WordDocument = { type: 'word', page: {}, header: '', footer: '', blocks: [{ id: 'image-jpeg', kind: 'image', imageRef: 'media-jpeg', mediaType: 'image/jpeg', displayName: 'figure.jpg' }] };
    const service = new OutcomeWordDocxService({ resolveManagedImage: async (mediaId) => mediaId === 'media-jpeg' ? { mediaId, mediaType: 'image/jpeg', displayName: 'figure.jpg', bytes: jpeg } : undefined });
    const exported = await service.exportManagedDocument(source);
    const entries = zipEntries(exported.bytes);
    expect(entries.get('word/media/image1.jpg')).toEqual(jpeg);
    expect(entries.get('[Content_Types].xml')?.toString()).toContain('<Default Extension="jpg" ContentType="image/jpeg"/>');
    expect(entries.get('word/_rels/document.xml.rels')?.toString()).toContain('Target="media/image1.jpg"');
    expect(service.importBuffer(exported.bytes).document.blocks).toContainEqual(expect.objectContaining({ kind: 'image', mediaType: 'image/jpeg', displayName: 'figure.jpg' }));
  });

  it('fails closed and rolls back media already persisted during a later image failure', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const source: WordDocument = { type: 'word', page: {}, header: '', footer: '', blocks: [
      { id: 'image-1', kind: 'image', imageRef: 'media-1', mediaType: 'image/jpeg', displayName: 'one.jpg' },
      { id: 'image-2', kind: 'image', imageRef: 'media-2', mediaType: 'image/jpeg', displayName: 'two.jpg' },
    ] };
    const service = new OutcomeWordDocxService({ resolveManagedImage: async (mediaId) => ({ mediaId, mediaType: 'image/jpeg', displayName: `${mediaId}.jpg`, bytes: jpeg }) });
    const exported = await service.exportManagedDocument(source);
    const imported = service.importBuffer(exported.bytes);
    const created: string[] = []; const rolledBack: string[][] = [];
    await expect(service.commitImportedMedia(exported.bytes, imported.document, async (image) => { if (image.imageRef.endsWith('-2')) return undefined; created.push('media-1'); return { id: 'media-1', mediaType: image.mediaType, displayName: image.displayName }; }, async (ids) => { rolledBack.push([...ids]); })).rejects.toThrow('docx_media_persist_failed');
    expect(created).toEqual(['media-1']);
    expect(rolledBack).toEqual([['media-1']]);
  });

  it('fails closed for a mixed text and inline image paragraph instead of dropping the text', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JwU0AAAAASUVORK5CYII=', 'base64');
    const source: WordDocument = { type: 'word', page: {}, header: '', footer: '', blocks: [{ id: 'image-1', kind: 'image', imageRef: 'media-1', mediaType: 'image/png', displayName: 'figure.png' }] };
    const exported = await new OutcomeWordDocxService({ resolveManagedImage: async () => ({ mediaId: 'media-1', mediaType: 'image/png', displayName: 'figure.png', bytes: png }) }).exportManagedDocument(source);
    const entries = zipEntries(exported.bytes); const documentXml = entries.get('word/document.xml')!.toString().replace('<w:r><w:drawing>', '<w:r><w:t>保留文字</w:t></w:r><w:r><w:drawing>');
    const mixed = new ZipWriter(); for (const [name, bytes] of entries) mixed.addFile(name, name === 'word/document.xml' ? Buffer.from(documentXml) : bytes);
    const imported = new OutcomeWordDocxService().importBuffer(mixed.toBuffer());
    expect(imported.document.blocks.some((block) => block.kind === 'image')).toBe(false);
    expect(imported.document.blocks).toContainEqual(expect.objectContaining({ text: '保留文字' }));
    expect(imported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_drawing' })]));
  });

  it('warns rather than silently claiming that an image block is preserved in DOCX', () => {
    const exported = new OutcomeWordDocxService().exportDocument({ type: 'word', page: {}, header: '', footer: '', blocks: [{ id: 'image-1', kind: 'image', imageRef: 'outcome-image-1' }] });
    expect(exported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_drawing' })]));
  });

  it('rejects data that is not a DOCX ZIP package', () => {
    expect(() => new OutcomeWordDocxService().importBuffer(Buffer.from('not a docx'))).toThrow('docx_zip_invalid');
  });
});
