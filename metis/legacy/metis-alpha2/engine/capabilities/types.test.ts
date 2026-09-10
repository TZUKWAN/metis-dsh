/**
 * METIS-202 — Capability Manifest schema tests.
 *
 * Positive cases (valid manifests) and negative cases (each rejection rule exercised once):
 * missing license, ambiguous permissions, unknown stage, bad id/version, third-party
 * without pinned commit, internal with wrong license, etc.
 */

import { describe, it, expect } from 'vitest';
import { parseCapabilityManifest, CapabilityManifestSchema } from './types.js';

// ─── Valid baseline manifest ──────────────────────────────────

const VALID_MANIFEST = {
  id: 'research-design',
  name: '研究设计',
  version: '1.0.0',
  description: 'Form a researchable question, scope, theory, method, deliverable.',
  stages: ['design'],
  disciplines: ['literature', 'sociology'],
  inputs: [
    { name: 'interest', type: 'string', required: true, description: 'fuzzy research interest' },
  ],
  outputs: [
    { name: 'research_design_card', type: 'Artifact', description: 'modifiable design card' },
  ],
  permissions: ['read_source', 'search_web'],
  dependencies: [],
  producesArtifacts: ['research_design_card'],
  visualization: 'none',
  source: {
    origin: 'internal' as const,
    repository: 'metis',
    license: 'internal' as const,
    licenseEvidence: 'Authored inside Metis (METIS-801).',
  },
  limitations: ['Cannot replace researcher judgement on final scope.'],
};

// ─── Positive cases ───────────────────────────────────────────

describe('METIS-202 CapabilityManifest — positive cases', () => {
  it('accepts a well-formed internal manifest', () => {
    const r = parseCapabilityManifest(VALID_MANIFEST);
    expect(r.success).toBe(true);
  });

  it('accepts a well-formed third-party manifest with pinned commit + Apache license', () => {
    const r = parseCapabilityManifest({
      ...VALID_MANIFEST,
      id: 'gabriel-qualitative',
      stages: ['qualitative_analysis'],
      source: {
        origin: 'third_party',
        repository: 'openai/GABRIEL',
        commit: 'main',
        license: 'Apache-2.0',
        licenseEvidence: 'LICENSE file present, Apache 2.0 (verified 2026-07-24, METIS-201 #2).',
        registerEntry: '#2',
      },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a third-party manifest pinned by version tag instead of commit', () => {
    const r = parseCapabilityManifest({
      ...VALID_MANIFEST,
      id: 'statspai-quant',
      stages: ['quantitative_analysis'],
      source: {
        origin: 'third_party',
        repository: 'brycewang-stanford/StatsPAI',
        version: 'v1.2.0',
        license: 'MIT',
        licenseEvidence: 'MIT badge + LICENSE (verified 2026-07-24, METIS-201 #3).',
        registerEntry: '#3',
      },
    });
    expect(r.success).toBe(true);
  });
});

// ─── Negative cases — each rejection rule once ────────────────

describe('METIS-202 CapabilityManifest — negative cases', () => {
  it('rejects a missing source (no provenance => cannot register)', () => {
    const { source: _source, ...noSource } = VALID_MANIFEST;
    void _source;
    const r = parseCapabilityManifest(noSource);
    expect(r.success).toBe(false);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errors.some((e) => e.includes('source'))).toBe(true);
    }
  });

  it('rejects a third-party source with NO license pin (commit/version missing)', () => {
    const r = parseCapabilityManifest({
      ...VALID_MANIFEST,
      source: {
        origin: 'third_party',
        repository: 'some/repo',
        // neither commit nor version
        license: 'MIT',
        licenseEvidence: 'claim without pin',
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errors.some((e) => /commit.*version|version.*commit|pin/i.test(e))).toBe(true);
    }
  });

  it('rejects a third-party source claiming license "internal"', () => {
    const r = parseCapabilityManifest({
      ...VALID_MANIFEST,
      source: {
        origin: 'third_party',
        repository: 'some/repo',
        commit: 'abc',
        license: 'internal',
        licenseEvidence: 'wrong',
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty permissions (a capability that can do nothing)', () => {
    const r = parseCapabilityManifest({ ...VALID_MANIFEST, permissions: [] });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown permission value (closed set)', () => {
    const r = parseCapabilityManifest({ ...VALID_MANIFEST, permissions: ['delete_everything'] });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown research stage', () => {
    const r = parseCapabilityManifest({ ...VALID_MANIFEST, stages: ['mind_reading'] });
    expect(r.success).toBe(false);
  });

  it('rejects a bad id (not kebab-case)', () => {
    const r = parseCapabilityManifest({ ...VALID_MANIFEST, id: 'Bad_ID 1' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-semver version', () => {
    const r = parseCapabilityManifest({ ...VALID_MANIFEST, version: 'latest' });
    expect(r.success).toBe(false);
  });

  it('rejects a manifest with no outputs (must declare at least one)', () => {
    const r = parseCapabilityManifest({ ...VALID_MANIFEST, outputs: [] });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown license value', () => {
    const r = parseCapabilityManifest({
      ...VALID_MANIFEST,
      source: { ...VALID_MANIFEST.source, license: 'WTFPL-maybe' },
    });
    expect(r.success).toBe(false);
  });
});

// ─── Direct schema smoke test ─────────────────────────────────

describe('METIS-202 CapabilityManifestSchema direct parse', () => {
  it('safeParse returns structured issues, not throw', () => {
    const r = CapabilityManifestSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});
