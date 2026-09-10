import { describe, expect, it } from 'vitest';
import {
  PersonalizationBundleAssetEntrySchema,
  PersonalizationBundlePayloadPathSchema,
  PersonalizationBundleSecretRefSchema,
  PersonalizationBundleSchema,
} from '../../engine/runtime/PersonalizationBundleContract.js';

const DIGEST = 'a'.repeat(64);

function bundle() {
  return {
    manifest: {
      format: 'metis-personalization-bundle',
      version: 1,
      bundleId: crypto.randomUUID(),
      createdAt: 1,
      createdBy: 'Contract test',
      rootDefinitionIds: ['user:rules/global'],
      definitions: [{
        id: 'user:rules/global',
        kind: 'rules',
        payloadPath: 'definitions/rules.json',
        size: 2,
        sha256: DIGEST,
        secretRefs: [],
      }],
      assets: [],
      bundleDigest: DIGEST,
    },
    payloads: [{
      path: 'definitions/rules.json',
      encoding: 'base64',
      size: 2,
      sha256: DIGEST,
      content: 'e30=',
    }],
  };
}

describe('PersonalizationBundleContract', () => {
  it('accepts a strict versioned package envelope', () => {
    expect(PersonalizationBundleSchema.parse(bundle()).manifest.version).toBe(1);
  });

  it.each([
    '../escape.json',
    'definitions/../escape.json',
    'definitions/./escape.json',
    'definitions\\escape.json',
    '/definitions/escape.json',
  ])('rejects traversal path %s', (value) => {
    expect(PersonalizationBundlePayloadPathSchema.safeParse(value).success).toBe(false);
  });

  it('rejects duplicate IDs and duplicate payload paths', () => {
    const value = bundle();
    value.manifest.definitions.push({ ...value.manifest.definitions[0]! });
    expect(PersonalizationBundleSchema.safeParse(value).success).toBe(false);
  });

  it('rejects extra envelope, manifest, and payload fields', () => {
    expect(PersonalizationBundleSchema.safeParse({ ...bundle(), verified: true }).success).toBe(false);
    const manifestExtra = bundle();
    expect(PersonalizationBundleSchema.safeParse({
      ...manifestExtra,
      manifest: { ...manifestExtra.manifest, truthPolicy: 'trust_me' },
    }).success).toBe(false);
    const payloadExtra = bundle();
    payloadExtra.payloads[0] = { ...payloadExtra.payloads[0]!, executable: true } as typeof payloadExtra.payloads[number];
    expect(PersonalizationBundleSchema.safeParse(payloadExtra).success).toBe(false);
  });

  it('requires payloads to exactly match all included manifest entries', () => {
    const missing = bundle();
    missing.payloads = [];
    expect(PersonalizationBundleSchema.safeParse(missing).success).toBe(false);

    const extra = bundle();
    extra.payloads.push({ ...extra.payloads[0]!, path: 'assets/extra.bin' });
    expect(PersonalizationBundleSchema.safeParse(extra).success).toBe(false);
  });

  it('requires opaque assets to be non-executable and inclusion-consistent', () => {
    expect(PersonalizationBundleAssetEntrySchema.safeParse({
      ownerId: 'user:skills/review',
      assetPath: 'scripts/helper.mjs',
      payloadPath: 'assets/review/helper.mjs',
      included: true,
      executable: false,
      size: 10,
      sha256: DIGEST,
    }).success).toBe(true);
    expect(PersonalizationBundleAssetEntrySchema.safeParse({
      ownerId: 'user:skills/review',
      assetPath: 'scripts/helper.mjs',
      payloadPath: null,
      included: true,
      executable: false,
      size: 10,
      sha256: DIGEST,
    }).success).toBe(false);
    expect(PersonalizationBundleAssetEntrySchema.safeParse({
      ownerId: 'user:skills/review',
      assetPath: 'scripts/helper.mjs',
      payloadPath: 'assets/review/helper.mjs',
      included: true,
      executable: true,
      size: 10,
      sha256: DIGEST,
    }).success).toBe(false);
  });

  it.each(['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'])(
    'rejects runtime-control secret reference %s', (name) => {
      expect(PersonalizationBundleSecretRefSchema.safeParse(`\${secret:${name}}`).success).toBe(false);
    },
  );
});
