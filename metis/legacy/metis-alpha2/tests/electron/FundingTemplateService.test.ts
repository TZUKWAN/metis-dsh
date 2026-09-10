import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';
import { FundingTemplateService } from '../../electron/FundingTemplateService.js';

let tempRoot = '';
let time = 1_900_001_000_000;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-funding-service-'));
  time = 1_900_001_000_000;
});

afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

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

function makeStoredZip(entries: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content, 'utf8');
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, eocd]);
}

function makePdf(revision: string): Buffer {
  const content = [
    `BT /F1 18 Tf 72 740 Td (Funding Application Form ${revision}) Tj ET`,
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
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const objectOffset of offsets) output += `${String(objectOffset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

function makeDocx(): Buffer {
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const relationships = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const document = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>一、课题论证</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return makeStoredZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: relationships },
    { name: 'word/document.xml', content: document },
  ]);
}

async function write(name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function setup() {
  const now = () => time++;
  const repository = new FundingTemplateRepository(tempRoot, { now });
  return { repository, service: new FundingTemplateService(repository, { now }) };
}

function createRequest(filePath: string) {
  return {
    ownerId: 'user-service',
    projectId: 'project-service',
    templateId: 'user:service-template',
    filePath,
    trustedRoot: tempRoot,
    expectedTemplateRevision: 0,
    expectedActiveVersion: null,
    expectedActiveDigest: null,
  };
}

describe('FundingTemplateService real file pipeline', () => {
  it('runs real PDF adapter -> analyzer -> verification -> atomic persistence end to end', async () => {
    const { repository, service } = setup();
    const filePath = await write('funding-v1.pdf', makePdf('v1'));
    const imported = await service.importOrReanalyze(createRequest(filePath));
    expect(imported).toMatchObject({
      ok: true,
      value: {
        templateId: 'user:service-template', templateVersion: 1,
        templateRevision: 1, activeVersion: 1, diffFromPrevious: null,
      },
    });
    if (!imported.ok) throw new Error(imported.code);
    const active = service.getActive('user-service', 'project-service', 'user:service-template');
    expect(active).toMatchObject({ ok: true, value: { canonicalDigest: imported.value.packageDigest } });
    expect(new FundingTemplateRepository(tempRoot).getActivePackage(
      'user-service', 'project-service', 'user:service-template',
    )).toMatchObject({ ok: true, value: { templateVersion: 1 } });
    expect(repository.listTemplates('user-service', 'project-service')).toMatchObject({ ok: true, value: [{ latestVersion: 1 }] });
  });

  it('reanalyzes a changed source into version 2 with a persisted diff', async () => {
    const { service } = setup();
    const firstPath = await write('funding-v1.pdf', makePdf('v1'));
    const first = await service.importOrReanalyze(createRequest(firstPath));
    if (!first.ok) throw new Error(first.code);
    const secondPath = await write('funding-v2.pdf', makePdf('v2'));
    const second = await service.importOrReanalyze({
      ...createRequest(secondPath),
      expectedTemplateRevision: first.value.templateRevision,
      expectedActiveVersion: first.value.activeVersion,
      expectedActiveDigest: first.value.packageDigest,
    });
    expect(second).toMatchObject({
      ok: true,
      value: { templateVersion: 2, templateRevision: 2, activeVersion: 2 },
    });
    if (!second.ok) throw new Error(second.code);
    expect(second.value.diffFromPrevious).toMatchObject({ fromVersion: 1, toVersion: 2 });
  });

  it('rejects unchanged file hashes before creating a duplicate version', async () => {
    const { service } = setup();
    const filePath = await write('funding.pdf', makePdf('same'));
    const first = await service.importOrReanalyze(createRequest(filePath));
    if (!first.ok) throw new Error(first.code);
    expect(await service.importOrReanalyze({
      ...createRequest(filePath),
      expectedTemplateRevision: first.value.templateRevision,
      expectedActiveVersion: first.value.activeVersion,
      expectedActiveDigest: first.value.packageDigest,
    })).toMatchObject({ ok: false, code: 'source_unchanged' });
    expect(service.list('user-service', 'project-service')).toMatchObject({ ok: true, value: [{ latestVersion: 1 }] });
  });

  it('imports a real DOCX template through the full observation and analysis pipeline', async () => {
    const { service } = setup();
    const filePath = await write('funding.docx', makeDocx());
    const imported = await service.importOrReanalyze(createRequest(filePath));
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.code);
    expect(imported.value.templateRevision).toBe(1);
    expect(service.list('user-service', 'project-service')).toMatchObject({ ok: true, value: [{ latestVersion: 1 }] });
  });

  it('checks CAS before reading an attacker-selected replacement file', async () => {
    const { service } = setup();
    const filePath = await write('funding.pdf', makePdf('v1'));
    const first = await service.importOrReanalyze(createRequest(filePath));
    if (!first.ok) throw new Error(first.code);
    expect(await service.importOrReanalyze({
      ...createRequest(path.join(tempRoot, 'does-not-exist.pdf')),
      expectedTemplateRevision: 99,
      expectedActiveVersion: 1,
      expectedActiveDigest: first.value.packageDigest,
    })).toMatchObject({ ok: false, code: 'cas_conflict' });
  });

  it('keeps active packages and listings isolated across owners', async () => {
    const { service } = setup();
    const filePath = await write('funding.pdf', makePdf('v1'));
    const first = await service.importOrReanalyze(createRequest(filePath));
    expect(first.ok).toBe(true);
    expect(service.getActive('other-user', 'project-service', 'user:service-template')).toMatchObject({
      ok: false, code: 'not_found',
    });
    expect(service.list('other-user', 'project-service')).toMatchObject({ ok: true, value: [] });
  });

  it('archives and restores through the service while keeping the package immutable', async () => {
    const { service } = setup();
    const filePath = await write('funding.pdf', makePdf('v1'));
    const first = await service.importOrReanalyze(createRequest(filePath));
    if (!first.ok) throw new Error(first.code);
    const archived = service.archive({
      ownerId: first.value.ownerId, projectId: first.value.projectId, templateId: first.value.templateId,
      expectedTemplateRevision: first.value.templateRevision,
      expectedActiveVersion: first.value.activeVersion,
      expectedActiveDigest: first.value.packageDigest,
    });
    expect(archived.ok).toBe(true);
    expect(service.getActive(first.value.ownerId, first.value.projectId, first.value.templateId)).toMatchObject({
      ok: false, code: 'not_found',
    });
    if (!archived.ok) throw new Error(archived.code);
    const restored = service.restore({
      ownerId: first.value.ownerId, projectId: first.value.projectId, templateId: first.value.templateId,
      expectedTemplateRevision: archived.value.revision,
      expectedActiveVersion: archived.value.activeVersion,
      expectedActiveDigest: first.value.packageDigest,
    });
    expect(restored.ok).toBe(true);
    expect(service.getActive(first.value.ownerId, first.value.projectId, first.value.templateId)).toMatchObject({
      ok: true, value: { canonicalDigest: first.value.packageDigest },
    });
  });

  it('strictly rejects malformed import requests without touching storage', async () => {
    const { service } = setup();
    const filePath = await write('funding.pdf', makePdf('v1'));
    expect(await service.importOrReanalyze({ ...createRequest(filePath), unexpected: true })).toMatchObject({
      ok: false, code: 'invalid_request',
    });
    expect(await service.importOrReanalyze({
      ...createRequest(filePath), expectedTemplateRevision: 1,
      expectedActiveVersion: null, expectedActiveDigest: null,
    })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(service.list('user-service', 'project-service')).toMatchObject({ ok: true, value: [] });
  });
});
