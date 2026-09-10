import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FundingTemplateIpcService } from '../../electron/FundingTemplateIpcService.js';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';
import { FundingTemplateService } from '../../electron/FundingTemplateService.js';

let root = '';
let clock = 1_900_500_000_000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-funding-ipc-'));
  clock = 1_900_500_000_000;
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function operation(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
}

function capability(ordinal: number): string {
  return `fc_${'a'.repeat(31)}${String(ordinal % 10)}`;
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
  for (const offset of offsets) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

function setup(files: Map<string, string> = new Map()) {
  const now = () => clock++;
  const repository = new FundingTemplateRepository(root, { now });
  const service = new FundingTemplateService(repository, { now });
  let consumes = 0;
  const ipc = new FundingTemplateIpcService({
    repository,
    service,
    projectExists: (projectId) => projectId === 'project-a',
    consumeFundingFile: (capabilityId) => {
      const filePath = files.get(capabilityId);
      if (!filePath) return null;
      files.delete(capabilityId);
      consumes += 1;
      return { filePath, trustedRoot: path.dirname(filePath) };
    },
  });
  return { ipc, repository, consumes: () => consumes };
}

function importRequest(capabilityId: string, ordinal: number) {
  return {
    contractVersion: 1 as const,
    operationId: operation(ordinal),
    action: 'import' as const,
    projectId: 'project-a',
    templateId: 'user:funding-template-a',
    fileCapabilityId: capabilityId,
    capabilityUse: 'consume_once' as const,
    expectedTemplateRevision: 0,
    expectedActiveVersion: null,
    expectedActiveDigest: null,
  };
}

describe('FundingTemplateIpcService renderer boundary', () => {
  it('rejects malformed requests before consuming a file capability', async () => {
    const id = capability(1);
    const { ipc, consumes } = setup(new Map([[id, path.join(root, 'input.pdf')]]));
    const response = await ipc.handle('local-user', { ...importRequest(id, 1), injectedPath: 'C:\\secret' });
    expect(response).toMatchObject({ ok: false, action: 'list', code: 'invalid_request' });
    expect(consumes()).toBe(0);
  });

  it('rejects a missing project before consuming a capability', async () => {
    const filePath = path.join(root, 'input.pdf');
    fs.writeFileSync(filePath, makePdf('missing-project'));
    const id = capability(2);
    const { ipc, consumes } = setup(new Map([[id, filePath]]));
    const response = await ipc.handle('local-user', {
      ...importRequest(id, 2), projectId: 'other-project',
    });
    expect(response).toMatchObject({ ok: false, action: 'import', code: 'not_found' });
    expect(consumes()).toBe(0);
  });

  it('imports a real PDF once and returns only strict aggregate evidence', async () => {
    const filePath = path.join(root, 'funding-v1.pdf');
    fs.writeFileSync(filePath, makePdf('v1'));
    const id = capability(3);
    const { ipc, consumes } = setup(new Map([[id, filePath]]));
    const response = await ipc.handle('local-user', importRequest(id, 3));
    expect(response).toMatchObject({
      ok: true,
      action: 'import',
      ownerId: 'local-user',
      projectId: 'project-a',
      template: { templateRevision: 1, activeVersion: 1, latestVersion: 1 },
      version: { templateVersion: 1, sourceFormat: 'pdf', structure: { layoutEvidence: 'partial' } },
      diff: null,
    });
    expect(consumes()).toBe(1);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('Project Title');
    expect(serialized).not.toContain('Maximum 5000');
  });

  it('lists, retrieves, reanalyzes, and returns a reverified adjacent diff', async () => {
    const firstPath = path.join(root, 'funding-v1.pdf');
    const secondPath = path.join(root, 'funding-v2.pdf');
    fs.writeFileSync(firstPath, makePdf('v1'));
    fs.writeFileSync(secondPath, makePdf('v2'));
    const firstId = capability(4);
    const secondId = capability(5);
    const files = new Map([[firstId, firstPath], [secondId, secondPath]]);
    const { ipc } = setup(files);
    const first = await ipc.handle('local-user', importRequest(firstId, 4));
    if (!first.ok || first.action !== 'import') throw new Error('Initial import failed');
    const second = await ipc.handle('local-user', {
      ...importRequest(secondId, 5),
      expectedTemplateRevision: first.template.templateRevision,
      expectedActiveVersion: first.template.activeVersion,
      expectedActiveDigest: first.template.activeDigest,
    });
    expect(second).toMatchObject({ ok: true, action: 'import', template: { latestVersion: 2 }, diff: { fromVersion: 1, toVersion: 2 } });
    if (!second.ok || second.action !== 'import' || !second.diff) throw new Error('Second import failed');

    const listed = await ipc.handle('local-user', {
      contractVersion: 1, operationId: operation(6), action: 'list', projectId: 'project-a', includeArchived: false,
    });
    expect(listed).toMatchObject({ ok: true, action: 'list', templates: [{ latestVersion: 2 }] });
    const diff = await ipc.handle('local-user', {
      contractVersion: 1,
      operationId: operation(7),
      action: 'diff',
      projectId: 'project-a',
      templateId: first.template.templateId,
      expectedTemplateRevision: second.template.templateRevision,
      fromVersion: 1,
      toVersion: 2,
      fromDigest: second.diff.fromDigest,
      toDigest: second.diff.toDigest,
    });
    expect(diff).toMatchObject({ ok: true, action: 'diff', diff: { diffDigest: second.diff.diffDigest } });
  });

  it('fails closed on a forged package digest and preserves the stored record', async () => {
    const filePath = path.join(root, 'funding.pdf');
    fs.writeFileSync(filePath, makePdf('v1'));
    const id = capability(8);
    const { ipc, repository } = setup(new Map([[id, filePath]]));
    const imported = await ipc.handle('local-user', importRequest(id, 8));
    if (!imported.ok || imported.action !== 'import') throw new Error('Import failed');
    const response = await ipc.handle('local-user', {
      contractVersion: 1,
      operationId: operation(9),
      action: 'get',
      projectId: 'project-a',
      templateId: imported.template.templateId,
      templateVersion: 1,
      packageDigest: 'f'.repeat(64),
    });
    expect(response).toMatchObject({ ok: false, action: 'get', code: 'cas_conflict' });
    expect(repository.getTemplate('local-user', 'project-a', imported.template.templateId)).toMatchObject({ ok: true });
  });
});
