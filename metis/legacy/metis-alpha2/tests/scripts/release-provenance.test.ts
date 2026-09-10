import { describe, expect, it } from 'vitest';
import { manifestDigest } from '../../scripts/release-lib.mjs';
import {
  assertProvenanceManifest,
  assertReleaseGitState,
  githubRepositorySlug,
} from '../../scripts/release-provenance-lib.mjs';

describe('release provenance helpers', () => {
  it.each([
    ['git@github.com:TZUKWAN/metis-in-social-science.git', 'TZUKWAN/metis-in-social-science'],
    ['https://github.com/TZUKWAN/metis-in-social-science.git', 'TZUKWAN/metis-in-social-science'],
    ['ssh://git@github.com/TZUKWAN/metis-in-social-science.git', 'TZUKWAN/metis-in-social-science'],
    ['git://github.com/TZUKWAN/metis-in-social-science.git', 'TZUKWAN/metis-in-social-science'],
  ])('normalizes a credential-free GitHub remote %s', (remote, expected) => {
    expect(githubRepositorySlug(remote)).toBe(expected);
  });

  it.each([
    '',
    'https://gitlab.com/TZUKWAN/metis-in-social-science.git',
    'file://github.com/TZUKWAN/metis-in-social-science.git',
    'https://token@github.com/TZUKWAN/metis-in-social-science.git',
    'https://git:secret@github.com/TZUKWAN/metis-in-social-science.git',
    'https://github.com/TZUKWAN/metis-in-social-science.git?token=secret',
    'https://github.com/TZUKWAN/metis-in-social-science.git#fragment',
    'https://github.com/TZUKWAN/metis-in-social-science/extra',
    'https://github.com/TZUKWAN/metis-in-social-science.git\nmalicious',
  ])('rejects a noncanonical or credential-bearing remote %s', (remote) => {
    expect(githubRepositorySlug(remote)).toBeNull();
  });

  it('accepts only an intact manifest with the expected schema and stage', () => {
    const body = {
      schemaVersion: 1,
      stage: 'current-source',
      product: { name: 'metis-workbench', version: '0.1.0-alpha.2' },
    };
    const valid = { ...body, manifestSha256: manifestDigest(body) };
    expect(assertProvenanceManifest(valid, 'current-source')).toBe(valid);
    expect(() => assertProvenanceManifest({ ...valid, stage: 'dist' }, 'current-source'))
      .toThrow(/schema or stage/u);
    expect(() => assertProvenanceManifest({ ...valid, product: { ...body.product, version: '9.9.9' } }, 'current-source'))
      .toThrow(/digest mismatch/u);
    expect(() => assertProvenanceManifest({ ...valid, manifestSha256: 'not-a-hash' }, 'current-source'))
      .toThrow(/invalid.*digest/u);
  });

  it('requires a clean GitHub upstream that exactly matches HEAD', () => {
    const valid = {
      clean: true,
      originRepository: 'TZUKWAN/metis-in-social-science',
      upstream: 'origin/main',
      upstreamHead: 'a'.repeat(40),
      headMatchesUpstream: true,
    };
    expect(assertReleaseGitState(valid)).toBe(valid);
    expect(() => assertReleaseGitState({ ...valid, clean: false })).toThrow(/fail-closed/u);
    expect(() => assertReleaseGitState({ ...valid, headMatchesUpstream: false })).toThrow(/exactly matching/u);
    expect(() => assertReleaseGitState({ ...valid, originRepository: null })).toThrow(/GitHub origin/u);
  });
});
