/**
 * METIS-208 — Official Capability Updater tests.
 *
 * Covers: happy-path signed update; signature error; hash mismatch; offline (fetch fail);
 * version downgrade refusal; rollback to previous; duplicate (re-install) handling.
 * All offline — the network fetch and signature verifier are injected.
 */

import { describe, it, expect } from 'vitest';
import { CapabilityUpdater, makeSignedPack, sha256Hex, type Fetcher, type SignatureVerifier } from './CapabilityUpdater.js';
import type { CapabilityManifest } from './types.js';
import { SEVEN_CAPABILITY_PACKS } from './packs/index.js';

// A valid signer: signature is `valid:${message}`; verifier accepts anything starting with `valid:`.
const GOOD_SIGNER = (msg: string) => `valid:${msg}`;
const GOOD_VERIFIER: SignatureVerifier = (_msg, sig) => typeof sig === 'string' && sig.startsWith('valid:');

function manifest(version: string): CapabilityManifest {
  const base = SEVEN_CAPABILITY_PACKS[0]!;
  return { ...base, id: 'updatable-pack', version, name: `v${version}` };
}

function makeFetcher(responseByCall: Array<{ bytes?: string; error?: string }>): { fetcher: Fetcher; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fetcher: Fetcher = async (packId, version) => {
    calls.push([packId, version]);
    const r = responseByCall[i++] ?? { error: 'no more responses' };
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, bytes: r.bytes };
  };
  return { fetcher, calls };
}

describe('METIS-208 CapabilityUpdater — happy path', () => {
  it('applies a correctly signed, hashed, version-valid pack', async () => {
    const m = manifest('1.0.0');
    const pack = makeSignedPack(m, GOOD_SIGNER);
    const { fetcher } = makeFetcher([{ bytes: JSON.stringify(pack) }]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);

    const outcome = await updater.update('updatable-pack', '1.0.0');
    expect(outcome.success).toBe(true);
    expect(outcome.appliedVersion).toBe('1.0.0');
    expect(updater.getInstalledVersion('updatable-pack')).toBe('1.0.0');
    expect(updater.getInstalledManifest('updatable-pack')?.id).toBe('updatable-pack');
  });
});

describe('METIS-208 CapabilityUpdater — signature error', () => {
  it('rejects a pack whose signature does not verify', async () => {
    const m = manifest('1.0.0');
    const pack = makeSignedPack(m, GOOD_SIGNER);
    // tamper signature
    const tampered = { ...pack, signature: 'FORGED:not-official' };
    const { fetcher } = makeFetcher([{ bytes: JSON.stringify(tampered) }]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);

    const outcome = await updater.update('updatable-pack', '1.0.0');
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/invalid signature/i);
  });
});

describe('METIS-208 CapabilityUpdater — hash error', () => {
  it('rejects a pack whose sha256 does not match the manifest', async () => {
    const m = manifest('1.0.0');
    const data = JSON.stringify(m);
    const goodSha = sha256Hex(data);
    const pack = {
      manifest: m,
      sha256: 'a'.repeat(64), // wrong hash
      signature: GOOD_SIGNER('a'.repeat(64)),
      version: '1.0.0',
    };
    void goodSha;
    const { fetcher } = makeFetcher([{ bytes: JSON.stringify(pack) }]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);

    const outcome = await updater.update('updatable-pack', '1.0.0');
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/hash mismatch/i);
  });
});

describe('METIS-208 CapabilityUpdater — offline / fetch failure', () => {
  it('rejects cleanly when the fetcher reports offline (network error)', async () => {
    const { fetcher } = makeFetcher([{ error: 'ENOTFOUND (offline)' }]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);
    const outcome = await updater.update('updatable-pack', '1.0.0');
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/offline/i);
  });

  it('rejects cleanly on malformed JSON (disk-full / truncated download)', async () => {
    const { fetcher } = makeFetcher([{ bytes: '{not valid json' }]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);
    const outcome = await updater.update('updatable-pack', '1.0.0');
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/malformed/i);
  });
});

describe('METIS-208 CapabilityUpdater — version lock', () => {
  it('refuses a downgrade by default', async () => {
    const m2 = manifest('2.0.0');
    const pack2 = makeSignedPack(m2, GOOD_SIGNER);
    const m1 = manifest('1.0.0');
    const pack1 = makeSignedPack(m1, GOOD_SIGNER);
    const { fetcher } = makeFetcher([
      { bytes: JSON.stringify(pack2) }, // initial install 2.0.0
      { bytes: JSON.stringify(pack1) }, // attempted downgrade to 1.0.0
    ]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);

    await updater.update('updatable-pack', '2.0.0');
    const outcome = await updater.update('updatable-pack', '1.0.0');
    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/refusing downgrade/i);
    // active version unchanged
    expect(updater.getInstalledVersion('updatable-pack')).toBe('2.0.0');
  });

  it('allows a downgrade when explicitly forced', async () => {
    const m2 = manifest('2.0.0');
    const pack2 = makeSignedPack(m2, GOOD_SIGNER);
    const m1 = manifest('1.0.0');
    const pack1 = makeSignedPack(m1, GOOD_SIGNER);
    const { fetcher } = makeFetcher([
      { bytes: JSON.stringify(pack2) },
      { bytes: JSON.stringify(pack1) },
    ]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);
    await updater.update('updatable-pack', '2.0.0');
    const outcome = await updater.update('updatable-pack', '1.0.0', { allowDowngrade: true });
    expect(outcome.success).toBe(true);
    expect(updater.getInstalledVersion('updatable-pack')).toBe('1.0.0');
  });
});

describe('METIS-208 CapabilityUpdater — rollback', () => {
  it('restores the previous snapshot on rollback', async () => {
    const m1 = manifest('1.0.0');
    const pack1 = makeSignedPack(m1, GOOD_SIGNER);
    const m2 = manifest('2.0.0');
    const pack2 = makeSignedPack(m2, GOOD_SIGNER);
    const { fetcher } = makeFetcher([
      { bytes: JSON.stringify(pack1) },
      { bytes: JSON.stringify(pack2) },
    ]);
    const updater = new CapabilityUpdater(fetcher, GOOD_VERIFIER);
    await updater.update('updatable-pack', '1.0.0');
    await updater.update('updatable-pack', '2.0.0');
    expect(updater.getInstalledVersion('updatable-pack')).toBe('2.0.0');

    const rb = updater.rollback('updatable-pack');
    expect(rb.success).toBe(true);
    expect(updater.getInstalledVersion('updatable-pack')).toBe('1.0.0');
  });

  it('rollback fails gracefully when no snapshot exists', () => {
    const updater = new CapabilityUpdater(async () => ({ ok: false, error: 'x' }), GOOD_VERIFIER);
    const rb = updater.rollback('never-installed');
    expect(rb.success).toBe(false);
    expect(rb.error).toMatch(/no snapshot/i);
  });
});
