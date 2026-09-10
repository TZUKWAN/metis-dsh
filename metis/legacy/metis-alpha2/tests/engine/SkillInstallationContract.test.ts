import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SkillPackageManifestSchema,
  SkillUrlInstallRequestSchema,
  decodeSkillInstallationResult,
} from '../../engine/runtime/SkillInstallationContract.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validManifest() {
  return {
    schemaVersion: 1,
    id: 'user:skills/contract-test',
    name: 'Contract test',
    description: 'Strict test package',
    version: '1.0.0',
    author: 'Metis',
    license: null,
    entry: 'SKILL.md',
    systemPromptFile: null,
    files: [{
      path: 'SKILL.md',
      size: 7,
      sha256: hash('# Test\n'),
      role: 'documentation',
      executable: false,
    }],
  };
}

describe('SkillInstallationContract', () => {
  it('accepts a strict, versioned package manifest', () => {
    expect(SkillPackageManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it.each([
    ['absolute path', '/SKILL.md'],
    ['parent traversal', '../SKILL.md'],
    ['nested traversal', 'docs/../SKILL.md'],
    ['Windows separator', 'docs\\SKILL.md'],
    ['control character', 'docs/\u0000.md'],
    ['Windows reserved device name', 'docs/CON.txt'],
    ['Windows-ambiguous trailing dot', 'docs/name.'],
  ])('rejects %s', (_label, entry) => {
    expect(SkillPackageManifestSchema.safeParse({ ...validManifest(), entry, files: [{ ...validManifest().files[0], path: entry }] }).success).toBe(false);
  });

  it('rejects undeclared entry files and non-document entry roles', () => {
    expect(SkillPackageManifestSchema.safeParse({ ...validManifest(), entry: 'README.md' }).success).toBe(false);
    expect(SkillPackageManifestSchema.safeParse({
      ...validManifest(),
      files: [{ ...validManifest().files[0], role: 'script' }],
    }).success).toBe(false);
  });

  it('rejects case-folded duplicate file paths and extra manifest properties', () => {
    expect(SkillPackageManifestSchema.safeParse({
      ...validManifest(),
      files: [validManifest().files[0], { ...validManifest().files[0], path: 'skill.md' }],
    }).success).toBe(false);
    expect(SkillPackageManifestSchema.safeParse({ ...validManifest(), trusted: true }).success).toBe(false);
  });

  it('does not accept built-in IDs from downloaded packages', () => {
    expect(SkillPackageManifestSchema.safeParse({ ...validManifest(), id: 'builtin:skills/overwrite' }).success).toBe(false);
  });

  it('rejects control characters in user-visible manifest text', () => {
    expect(SkillPackageManifestSchema.safeParse({ ...validManifest(), name: 'Unsafe\u0000name' }).success).toBe(false);
    expect(SkillPackageManifestSchema.safeParse({ ...validManifest(), author: 'Unsafe\u0085author' }).success).toBe(false);
  });

  it('rejects credential-bearing and fragment-bearing URL install requests', () => {
    const base = { contractVersion: 1, expectedArchiveSha256: null, expectedId: null, expectedVersion: null };
    expect(SkillUrlInstallRequestSchema.safeParse({ ...base, url: 'https://user:secret@example.com/skill.zip' }).success).toBe(false);
    expect(SkillUrlInstallRequestSchema.safeParse({ ...base, url: 'https://example.com/skill.zip#token' }).success).toBe(false);
    expect(SkillUrlInstallRequestSchema.safeParse({ ...base, url: 'https://example.com/skill.zip?access_token=secret' }).success).toBe(false);
  });

  it('decodes malformed service output to an explicit failure', () => {
    expect(decodeSkillInstallationResult({ ok: true, installed: { id: 'forged' } })).toEqual({
      ok: false,
      code: 'invalid_request',
      message: 'Invalid skill installation response',
    });
  });
});
