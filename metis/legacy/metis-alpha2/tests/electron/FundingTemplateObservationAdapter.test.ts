import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FundingTemplateObservationDocumentSchema } from '../../engine/runtime/FundingTemplateContract.js';
import { analyzeFundingTemplate } from '../../engine/personalization/FundingTemplateAnalyzer.js';
import {
  FUNDING_TEMPLATE_OBSERVATION_ADAPTER_LIMITS,
  observeFundingTemplateFile,
} from '../../electron/FundingTemplateObservationAdapter.js';

interface ZipFixtureEntry {
  name: string;
  content: string | Buffer;
  flags?: number;
  compressionMethod?: 0 | 8;
  madeBy?: number;
  externalAttributes?: number;
  crcOverride?: number;
}

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-funding-observation-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const compressionMethod = entry.compressionMethod ?? 8;
    const compressed = compressionMethod === 8 ? deflateRawSync(content) : Buffer.from(content);
    const checksum = entry.crcOverride ?? crc32(content);
    const flags = entry.flags ?? 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function makePdf(): Buffer {
  const content = [
    'BT /F1 18 Tf 72 740 Td (Funding Application Form) Tj ET',
    'BT /F1 10 Tf 72 700 Td (Project Title:) Tj ET',
    'BT /F1 10 Tf 72 670 Td (Required. Maximum 5000 words.) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120" w:line="360"/><w:jc w:val="left"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Source Han Serif SC"/><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
</w:styles>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>一、课题论证</w:t></w:r></w:p>
    <w:p><w:r><w:t>本栏限5000字。</w:t></w:r></w:p>
    <w:tbl><w:tr>
      <w:tc><w:p><w:r><w:t>年度</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>研究任务</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

function docxEntries(overrides: Partial<Record<string, string | Buffer>> = {}): ZipFixtureEntry[] {
  const values: Record<string, string | Buffer> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/document.xml': DOCUMENT_XML,
    'word/styles.xml': STYLES_XML,
    'word/_rels/document.xml.rels': DOCUMENT_RELS,
    ...overrides,
  };
  return Object.entries(values).map(([name, content]) => ({ name, content }));
}

async function writeFixture(name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function request(filePath: string, extra: Record<string, unknown> = {}) {
  return {
    filePath,
    trustedRoot: tempRoot,
    documentId: 'funding-upload-observation',
    extractedAt: 1_900_000_000_000,
    ...extra,
  };
}

describe('FundingTemplateObservationAdapter PDF observations', () => {
  it('extracts a real PDF through PDF.js with stable digest, page geometry, text, style, and coordinates', async () => {
    const bytes = makePdf();
    const filePath = await writeFixture('funding.pdf', bytes);
    const result = await observeFundingTemplateFile(request(filePath));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`PDF observation failed: ${result.code}`);
    expect(FundingTemplateObservationDocumentSchema.safeParse(result.document).success).toBe(true);
    expect(result.document).toMatchObject({
      sourceFormat: 'pdf', sourceDigest: sha256(bytes), pageCount: 1,
      pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792, observedMarginsPt: null }],
    });
    expect(result.document.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(result.document.blocks.every((block) => block.bounds.width > 0 && block.bounds.height > 0)).toBe(true);
    expect(result.document.blocks.some((block) => block.kind === 'paragraph' && block.text === 'Funding Application Form')).toBe(true);
    expect(result.document.blocks.some((block) => block.kind === 'paragraph' && block.contentRole === 'instruction')).toBe(true);
    expect(result.document.styles.length).toBeGreaterThanOrEqual(2);
  });

  it('returns deterministic observations for an unchanged real file', async () => {
    const filePath = await writeFixture('stable.pdf', makePdf());
    const first = await observeFundingTemplateFile(request(filePath));
    const second = await observeFundingTemplateFile(request(filePath));
    expect(first).toEqual(second);
  });

  it('feeds the strict real-PDF observation directly into the funding analyzer', async () => {
    const filePath = await writeFixture('integration.pdf', makePdf());
    const observed = await observeFundingTemplateFile(request(filePath));
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error(`PDF observation failed: ${observed.code}`);
    const analyzed = analyzeFundingTemplate({
      templateId: 'user:pdf-adapter-integration',
      templateVersion: 1,
      createdAt: 1_900_000_000_001,
      document: observed.document,
    });
    expect(analyzed.ok).toBe(true);
    if (!analyzed.ok) throw new Error(`Funding analysis failed: ${analyzed.code}`);
    expect(analyzed.template.source.sourceDigest).toBe(observed.document.sourceDigest);
    expect(analyzed.template.contentSlots.some((slot) => slot.normalizedLabel === 'Project Title')).toBe(true);
  });

  it('rejects a fake PDF signature without logging file content or its path', async () => {
    const filePath = await writeFixture('fake.pdf', Buffer.from('not a pdf: private applicant prose', 'utf8'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await observeFundingTemplateFile(request(filePath));
    expect(result).toMatchObject({ ok: false, code: 'invalid_pdf' });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(filePath);
    expect(JSON.stringify(result)).not.toContain('private applicant prose');
  });

  it('rejects files outside the trusted root', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-funding-outside-'));
    try {
      const filePath = path.join(outsideRoot, 'outside.pdf');
      await fs.writeFile(filePath, makePdf());
      expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({
        ok: false, code: 'path_outside_trusted_root',
      });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported extensions and strict-request extra fields', async () => {
    const filePath = await writeFixture('funding.txt', Buffer.from('plain text'));
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'unsupported_format' });
    expect(await observeFundingTemplateFile(request(filePath, { unexpected: true }))).toMatchObject({
      ok: false, code: 'invalid_request',
    });
  });

  it('rejects an oversized file before reading its payload', async () => {
    const filePath = path.join(tempRoot, 'oversized.pdf');
    const handle = await fs.open(filePath, 'w');
    try { await handle.truncate(FUNDING_TEMPLATE_OBSERVATION_ADAPTER_LIMITS.fileBytes + 1); } finally { await handle.close(); }
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'file_too_large' });
  });
});

describe('FundingTemplateObservationAdapter DOCX observation', () => {
  it('observes a real DOCX into a contract-valid document with synthesized flow layout', async () => {
    const bytes = makeZip(docxEntries());
    const filePath = await writeFixture('funding.docx', bytes);
    const result = await observeFundingTemplateFile(request(filePath));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('DOCX observation failed');
    const document = result.document;
    expect(document.sourceFormat).toBe('docx');
    expect(document.pageCount).toBeGreaterThanOrEqual(1);
    expect(document.pages.length).toBe(document.pageCount);
    expect(document.blocks.length).toBe(3);
    // 段落与表格都进了观察：顶层 2 段正文 + 1 张表格（表格内段落并入表格块）。
    expect(document.blocks.some((block) => block.kind === 'paragraph' && block.text.includes('课题论证'))).toBe(true);
    expect(document.blocks.some((block) => block.kind === 'table')).toBe(true);
    // 合成坐标必须落在所在页内（契约 superRefine 同样校验，这里显式再验一次）。
    for (const block of document.blocks) {
      const page = document.pages[block.pageNumber - 1]!;
      expect(block.bounds.x).toBeGreaterThanOrEqual(0);
      expect(block.bounds.y).toBeGreaterThanOrEqual(0);
      expect(block.bounds.x + block.bounds.width).toBeLessThanOrEqual(page.widthPt + 0.5);
      expect(block.bounds.y + block.bounds.height).toBeLessThanOrEqual(page.heightPt + 0.5);
    }
    expect(document.styles.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain(filePath);
  });

  it('rejects archive path traversal', async () => {
    const bytes = makeZip([...docxEntries(), { name: '../outside.xml', content: '<x/>' }]);
    const filePath = await writeFixture('traversal.docx', bytes);
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });

  it('rejects a Unix symlink entry without extracting it', async () => {
    const symlinkAttributes = (0xa1ff << 16) >>> 0;
    const bytes = makeZip([
      ...docxEntries(),
      { name: 'word/link', content: '../outside', madeBy: (3 << 8) | 20, externalAttributes: symlinkAttributes },
    ]);
    const filePath = await writeFixture('symlink.docx', bytes);
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });

  it('rejects external and traversing relationships', async () => {
    const external = DOCUMENT_RELS.replace(
      '</Relationships>',
      '<Relationship Id="evil" Type="http://example.test/hyperlink" Target="https://example.test/private" TargetMode="External"/></Relationships>',
    );
    const bytes = makeZip(docxEntries({ 'word/_rels/document.xml.rels': external }));
    const filePath = await writeFixture('external.docx', bytes);
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });

  it('rejects a compressed ZIP bomb by ratio before inflation', async () => {
    const bytes = makeZip([...docxEntries(), { name: 'word/media/bomb.bin', content: Buffer.alloc(1_000_000, 0x41) }]);
    const filePath = await writeFixture('bomb.docx', bytes);
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({
      ok: false, code: 'archive_limit_exceeded',
    });
  });

  it('rejects duplicate archive paths', async () => {
    const entries = docxEntries();
    entries.push({ name: 'word/document.xml', content: DOCUMENT_XML });
    const filePath = await writeFixture('duplicate.docx', makeZip(entries));
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });

  it('rejects XML DTD and entity declarations', async () => {
    const hostile = `<!DOCTYPE w:document [<!ENTITY leak SYSTEM "file:///secret">]>${DOCUMENT_XML}`;
    const filePath = await writeFixture('entity.docx', makeZip(docxEntries({ 'word/document.xml': hostile })));
    expect(await observeFundingTemplateFile(request(filePath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });

  it('rejects macro-enabled and embedded active content', async () => {
    const macroTypes = CONTENT_TYPES.replace('document.main+xml', 'document.macroEnabled.main+xml');
    const macroPath = await writeFixture('macro.docx', makeZip(docxEntries({ '[Content_Types].xml': macroTypes })));
    expect(await observeFundingTemplateFile(request(macroPath))).toMatchObject({ ok: false, code: 'unsafe_archive' });

    const embeddedPath = await writeFixture('embedded.docx', makeZip([
      ...docxEntries(), { name: 'word/embeddings/object1.bin', content: Buffer.from('ole') },
    ]));
    expect(await observeFundingTemplateFile(request(embeddedPath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });

  it('rejects CRC tampering and encrypted entries', async () => {
    const corrupted = docxEntries().map((entry) => entry.name === 'word/document.xml'
      ? { ...entry, crcOverride: 0 }
      : entry);
    const corruptedPath = await writeFixture('crc.docx', makeZip(corrupted));
    expect(await observeFundingTemplateFile(request(corruptedPath))).toMatchObject({ ok: false, code: 'invalid_docx' });

    const encrypted = docxEntries().map((entry) => entry.name === 'word/document.xml'
      ? { ...entry, flags: 0x0801 }
      : entry);
    const encryptedPath = await writeFixture('encrypted.docx', makeZip(encrypted));
    expect(await observeFundingTemplateFile(request(encryptedPath))).toMatchObject({ ok: false, code: 'unsafe_archive' });
  });
});
