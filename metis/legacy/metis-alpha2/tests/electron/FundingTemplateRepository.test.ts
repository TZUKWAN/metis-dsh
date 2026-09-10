import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeFundingTemplate,
  canonicalizeFundingTemplateValue,
  computeFundingTemplatePackageDigest,
} from '../../engine/personalization/FundingTemplateAnalyzer.js';
import type { FundingTemplatePackage } from '../../engine/runtime/FundingTemplateContract.js';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';

let tempRoot = '';
let clock = 1_900_000_100_000;

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'metis-funding-repository-'));
  clock = 1_900_000_100_000;
});

afterEach(async () => {
  if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
});

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function makePackage(version: number, sourceRevision: string, templateId = 'user:funding-repository-template'): FundingTemplatePackage {
  const result = analyzeFundingTemplate({
    templateId,
    templateVersion: version,
    createdAt: 1_900_000_000_000 + version,
    document: {
      contractVersion: 1,
      documentId: 'repository-observation',
      sourceFormat: 'pdf',
      sourceDigest: digest(`source:${sourceRevision}`),
      extractedAt: 1_900_000_000_000 + version,
      extractor: { name: 'repository-test-extractor', version: '1.0.0' },
      pageCount: 1,
      pages: [{
        pageNumber: 1, widthPt: 595, heightPt: 842,
        observedMarginsPt: { top: 72, right: 72, bottom: 72, left: 72 },
      }],
      styles: [
        {
          styleId: 'heading', fontFamily: 'Source Han Serif SC', fontSizePt: 18,
          fontWeight: 'bold', italic: false, alignment: 'center', lineSpacingPt: 24,
          paragraphBeforePt: 0, paragraphAfterPt: 12,
        },
        {
          styleId: 'body', fontFamily: 'Source Han Serif SC', fontSizePt: 10.5,
          fontWeight: 'normal', italic: false, alignment: 'left', lineSpacingPt: 18,
          paragraphBeforePt: 0, paragraphAfterPt: 6,
        },
      ],
      blocks: [
        {
          kind: 'paragraph', blockId: 'title', pageNumber: 1, ordinal: 0,
          bounds: { x: 72, y: 50, width: 451, height: 30 },
          text: `Funding Application Form ${sourceRevision}`, contentRole: 'template_label', styleId: 'heading',
        },
        {
          kind: 'paragraph', blockId: 'project-title', pageNumber: 1, ordinal: 1,
          bounds: { x: 72, y: 100, width: 180, height: 20 },
          text: 'Project Title', contentRole: 'template_label', styleId: 'body',
        },
        {
          kind: 'paragraph', blockId: 'instruction', pageNumber: 1, ordinal: 2,
          bounds: { x: 72, y: 130, width: 300, height: 20 },
          text: 'Required. Maximum 5000 words.', contentRole: 'instruction', styleId: 'body',
        },
      ],
    },
  });
  if (!result.ok) throw new Error(`Fixture analysis failed: ${result.code}`);
  return result.template;
}

function repository() {
  return new FundingTemplateRepository(tempRoot, { now: () => clock++ });
}

function saveFirst(repo: FundingTemplateRepository, ownerId = 'user-a', projectId = 'project-a') {
  const template = makePackage(1, 'v1');
  const saved = repo.saveVersion({
    ownerId, projectId, template,
    expectedTemplateRevision: 0,
    expectedActiveVersion: null,
    expectedActiveDigest: null,
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(`Fixture save failed: ${saved.code}`);
  return saved.value;
}

describe('FundingTemplateRepository persistence and isolation', () => {
  it('atomically saves, rereads, and restores a verified active package across repository instances', () => {
    const repo = repository();
    const saved = saveFirst(repo);
    expect(saved).toMatchObject({ revision: 1, activeVersion: 1, archivedAt: null });
    const restarted = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const active = restarted.getActivePackage('user-a', 'project-a', saved.templateId);
    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error(active.code);
    expect(active.value.canonicalDigest).toBe(saved.versions[0]?.packageDigest);
  });

  it('isolates the same templateId by owner and project without path-derived storage', () => {
    const repo = repository();
    saveFirst(repo, 'user-a', 'project-a');
    saveFirst(repo, 'user-b', 'project-a');
    saveFirst(repo, 'user-a', 'project-b');
    expect(repo.listTemplates('user-a', 'project-a')).toMatchObject({ ok: true, value: [{ ownerId: 'user-a', projectId: 'project-a' }] });
    expect(repo.listTemplates('user-b', 'project-a')).toMatchObject({ ok: true, value: [{ ownerId: 'user-b', projectId: 'project-a' }] });
    expect(repo.getTemplate('user-b', 'project-b', 'user:funding-repository-template')).toMatchObject({ ok: false, code: 'not_found' });
    expect(fs.readdirSync(path.join(tempRoot, 'funding-templates')).every((name) => !name.includes('user-a') && !name.includes('project-a'))).toBe(true);
  });

  it('rejects stale CAS without changing the active state', () => {
    const repo = repository();
    const first = saveFirst(repo);
    const second = makePackage(2, 'v2');
    expect(repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: second,
      expectedTemplateRevision: 99, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    })).toMatchObject({ ok: false, code: 'cas_conflict' });
    expect(repo.getActivePackage(first.ownerId, first.projectId, first.templateId)).toMatchObject({
      ok: true, value: { templateVersion: 1 },
    });
  });

  it('stores a contiguous hash-aware reanalysis version and integrity-bound diff', () => {
    const repo = repository();
    const first = saveFirst(repo);
    const secondPackage = makePackage(2, 'v2');
    const saved = repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: secondPackage,
      expectedTemplateRevision: 1, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.code);
    expect(saved.value).toMatchObject({ revision: 2, activeVersion: 2 });
    expect(saved.value.versions[1]?.diffFromPrevious).toMatchObject({
      fromVersion: 1, toVersion: 2,
      fromDigest: first.versions[0]!.packageDigest,
      toDigest: secondPackage.canonicalDigest,
    });
  });

  it('rejects unchanged source hashes and version gaps', () => {
    const repo = repository();
    const first = saveFirst(repo);
    const unchanged = makePackage(2, 'v1');
    expect(repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: unchanged,
      expectedTemplateRevision: 1, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    })).toMatchObject({ ok: false, code: 'source_unchanged' });

    const gap = makePackage(3, 'v3');
    expect(repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: gap,
      expectedTemplateRevision: 1, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    })).toMatchObject({ ok: false, code: 'version_conflict' });
  });

  it('activates an older version with CAS, then archives and restores without deleting versions', () => {
    const repo = repository();
    const first = saveFirst(repo);
    const second = repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: makePackage(2, 'v2'),
      expectedTemplateRevision: 1, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    });
    if (!second.ok) throw new Error(second.code);
    const activated = repo.activateVersion({
      ownerId: first.ownerId, projectId: first.projectId, templateId: first.templateId,
      expectedTemplateRevision: 2, expectedActiveVersion: 2,
      expectedActiveDigest: second.value.versions[1]!.packageDigest,
      targetVersion: 1,
    });
    expect(activated).toMatchObject({ ok: true, value: { revision: 3, activeVersion: 1 } });
    if (!activated.ok) throw new Error(activated.code);
    const archived = repo.archive({
      ownerId: first.ownerId, projectId: first.projectId, templateId: first.templateId,
      expectedTemplateRevision: 3, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    });
    expect(archived.ok).toBe(true);
    expect(repo.getTemplate(first.ownerId, first.projectId, first.templateId)).toMatchObject({ ok: false, code: 'not_found' });
    if (!archived.ok) throw new Error(archived.code);
    const restored = repo.restore({
      ownerId: first.ownerId, projectId: first.projectId, templateId: first.templateId,
      expectedTemplateRevision: 4, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    });
    expect(restored).toMatchObject({ ok: true, value: { revision: 5, activeVersion: 1, archivedAt: null } });
    if (restored.ok) expect(restored.value.versions).toHaveLength(2);
  });

  it('rejects PII-bearing package fields even when the package digest is recomputed', () => {
    const repo = repository();
    const template = makePackage(1, 'pii');
    template.contentSlots[0]!.normalizedLabel = 'Contact private.person@example.com';
    template.canonicalDigest = computeFundingTemplatePackageDigest(template);
    expect(repo.saveVersion({
      ownerId: 'user-a', projectId: 'project-a', template,
      expectedTemplateRevision: 0, expectedActiveVersion: null, expectedActiveDigest: null,
    })).toMatchObject({ ok: false, code: 'sensitive_content' });
  });

  it('never persists a source file path or applicant body text', () => {
    const repo = repository();
    saveFirst(repo);
    const raw = fs.readdirSync(repo.repositoryRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(repo.repositoryRoot, name), 'utf8'))
      .join('\n');
    expect(raw).not.toContain('C:\\Users\\applicant\\private.docx');
    expect(raw).not.toContain('/home/applicant/private.pdf');
    expect(raw).not.toContain('private applicant narrative');
  });
});

describe('FundingTemplateRepository corruption and transaction gates', () => {
  it('fails closed when the active slot is corrupted and does not fall back to an inactive slot', () => {
    const repo = repository();
    saveFirst(repo);
    const pointer = JSON.parse(fs.readFileSync(path.join(repo.repositoryRoot, '.repository.ptr.json'), 'utf8')) as { slot: number };
    fs.writeFileSync(path.join(repo.repositoryRoot, `repository.${pointer.slot}.json`), '{"corrupt":true}', 'utf8');
    expect(repo.getTemplate('user-a', 'project-a', 'user:funding-repository-template')).toMatchObject({
      ok: false, code: 'repository_corrupt',
    });
  });

  it('rejects nested package tampering even when an attacker recomputes the outer state digest', () => {
    const repo = repository();
    const first = saveFirst(repo);
    const pointerPath = path.join(repo.repositoryRoot, '.repository.ptr.json');
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as { slot: 0 | 1 };
    const activePath = path.join(repo.repositoryRoot, `repository.${pointer.slot}.json`);
    const state = JSON.parse(fs.readFileSync(activePath, 'utf8')) as {
      stateDigest: string;
      templates: Array<{ versions: Array<{ template: FundingTemplatePackage }> }>;
      [key: string]: unknown;
    };
    state.templates[0]!.versions[0]!.template.contentSlots[0]!.normalizedLabel = 'Attacker-rewritten field';
    const { stateDigest: _stateDigest, ...withoutDigest } = state;
    void _stateDigest;
    state.stateDigest = digest(canonicalizeFundingTemplateValue(withoutDigest));
    fs.writeFileSync(activePath, JSON.stringify(state), 'utf8');

    expect(repo.getActivePackage(first.ownerId, first.projectId, first.templateId)).toMatchObject({
      ok: false, code: 'repository_corrupt',
    });
  });

  it('fails closed when the commit pointer is missing', () => {
    const repo = repository();
    saveFirst(repo);
    fs.unlinkSync(path.join(repo.repositoryRoot, '.repository.ptr.json'));
    expect(repo.listTemplates('user-a', 'project-a')).toMatchObject({ ok: false, code: 'repository_corrupt' });
  });

  it('ignores corruption in the inactive slot because it is not committed', () => {
    const repo = repository();
    const first = saveFirst(repo);
    const second = repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: makePackage(2, 'v2'),
      expectedTemplateRevision: 1, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    });
    if (!second.ok) throw new Error(second.code);
    const pointer = JSON.parse(fs.readFileSync(path.join(repo.repositoryRoot, '.repository.ptr.json'), 'utf8')) as { slot: 0 | 1 };
    fs.writeFileSync(path.join(repo.repositoryRoot, `repository.${pointer.slot === 0 ? 1 : 0}.json`), 'corrupt inactive', 'utf8');
    expect(repo.getActivePackage(first.ownerId, first.projectId, first.templateId)).toMatchObject({
      ok: true, value: { templateVersion: 2 },
    });
  });

  it('returns repository_busy and preserves state when the exclusive lock is held', () => {
    const repo = repository();
    const first = saveFirst(repo);
    fs.writeFileSync(path.join(repo.repositoryRoot, '.repository.lock'), 'other-process', { flag: 'wx' });
    const result = repo.saveVersion({
      ownerId: first.ownerId, projectId: first.projectId, template: makePackage(2, 'v2'),
      expectedTemplateRevision: 1, expectedActiveVersion: 1,
      expectedActiveDigest: first.versions[0]!.packageDigest,
    });
    expect(result).toMatchObject({ ok: false, code: 'repository_busy' });
    fs.unlinkSync(path.join(repo.repositoryRoot, '.repository.lock'));
    expect(repo.getActivePackage(first.ownerId, first.projectId, first.templateId)).toMatchObject({
      ok: true, value: { templateVersion: 1 },
    });
  });
});
