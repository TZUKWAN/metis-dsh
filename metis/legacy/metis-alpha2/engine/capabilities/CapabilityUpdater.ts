/**
 * Official Capability Updater (METIS-208).
 *
 * Fetches signed official capability-pack updates and applies them atomically, with
 * signature verification, hash verification, version locking, and automatic rollback on
 * any failure. Users never see a plugin-install UI — this runs transparently.
 *
 * Security model (task list METIS-208):
 *   - Only OFFICIALY SIGNED packs are accepted. A pack without a valid signature is rejected
 *     before it touches the active capability set.
 *   - SHA-256 hash is verified after download; mismatch rejects + rolls back.
 *   - Version locking: a downgrade is refused unless explicitly forced.
 *   - Rollback: the previously-active pack snapshot is restored on any failure mid-apply.
 *
 * The network fetch is injected (Fetcher interface) so tests can drive it deterministically
 * without real network (METIS-208: "signature error, hash error, offline, disk-full, rollback"
 * tests all run offline against an injected fetcher + in-memory store).
 */

import { createHash } from 'node:crypto';
import type { CapabilityManifest } from './types.js';
import { parseCapabilityManifest } from './types.js';

// ─── Types ────────────────────────────────────────────────────

export interface SignedPack {
  manifest: CapabilityManifest;
  /** Expected SHA-256 of the serialized manifest (hex). */
  sha256: string;
  /** Official signature over the sha256 (opaque string; verified by SignatureVerifier). */
  signature: string;
  /** Semver version, mirrors manifest.version for lock checks. */
  version: string;
}

export interface FetchResult {
  ok: boolean;
  bytes?: string; // serialized JSON of the signed pack
  error?: string;
}

/** Injected network fetcher so tests run fully offline. */
export type Fetcher = (packId: string, version: string) => Promise<FetchResult>;

/** Injected signature verifier (production wires a real public-key verifier). */
export type SignatureVerifier = (message: string, signature: string) => boolean;

export interface UpdateOutcome {
  packId: string;
  success: boolean;
  appliedVersion?: string;
  rolledBackTo?: string;
  error?: string;
}

// ─── Updater ──────────────────────────────────────────────────

export class CapabilityUpdater {
  /** activeVersions: packId -> currently installed version (the version lock). */
  private readonly active = new Map<string, string>();
  /** rollback snapshots: packId -> previous SignedPack (for restore on failure). */
  private readonly snapshots = new Map<string, SignedPack>();
  /** accepted manifests after successful apply: packId -> SignedPack. */
  private readonly installed = new Map<string, SignedPack>();

  private readonly fetcher: Fetcher;
  private readonly verifySignature: SignatureVerifier;

  constructor(fetcher: Fetcher, verifySignature: SignatureVerifier) {
    this.fetcher = fetcher;
    this.verifySignature = verifySignature;
  }

  getInstalledVersion(packId: string): string | undefined {
    return this.active.get(packId);
  }

  getInstalledManifest(packId: string): CapabilityManifest | undefined {
    return this.installed.get(packId)?.manifest;
  }

  /**
   * Attempt to update a pack to `targetVersion`. Performs the full verify → lock →
   * apply → rollback-on-failure sequence. Returns a structured outcome; never throws
   * (callers branch on success).
   */
  async update(packId: string, targetVersion: string, opts: { allowDowngrade?: boolean } = {}): Promise<UpdateOutcome> {
    const previous = this.installed.get(packId);
    const previousVersion = this.active.get(packId);

    // 1. Fetch
    const fetched = await this.fetcher(packId, targetVersion);
    if (!fetched.ok || !fetched.bytes) {
      return { packId, success: false, rolledBackTo: previousVersion, error: fetched.error ?? 'fetch failed' };
    }

    // 2. Deserialize + validate manifest schema
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.bytes);
    } catch {
      return { packId, success: false, rolledBackTo: previousVersion, error: 'malformed JSON' };
    }
    const signed = parsed as SignedPack;
    const manifestCheck = parseCapabilityManifest(signed.manifest);
    if (!manifestCheck.success) {
      return { packId, success: false, rolledBackTo: previousVersion, error: `invalid manifest: ${manifestCheck.errors.join('; ')}` };
    }

    // 3. Version lock (refuse downgrade unless forced)
    if (previousVersion && !opts.allowDowngrade && semverLessThan(signed.version, previousVersion)) {
      return { packId, success: false, rolledBackTo: previousVersion, error: `refusing downgrade ${signed.version} < ${previousVersion}` };
    }

    // 4. Hash verification
    const recomputed = sha256Hex(JSON.stringify(signed.manifest));
    if (recomputed !== signed.sha256) {
      return { packId, success: false, rolledBackTo: previousVersion, error: 'hash mismatch — pack rejected' };
    }

    // 5. Signature verification (official-only)
    if (!this.verifySignature(signed.sha256, signed.signature)) {
      return { packId, success: false, rolledBackTo: previousVersion, error: 'invalid signature — pack rejected (not official)' };
    }

    // 6. Snapshot for rollback, then apply
    if (previous) this.snapshots.set(packId, previous);
    this.installed.set(packId, signed);
    this.active.set(packId, signed.version);

    return { packId, success: true, appliedVersion: signed.version, rolledBackTo: previousVersion };
  }

  /**
   * Roll back a pack to its previous snapshot. Used on post-apply discovery of a problem
   * (e.g. disk-full mid-write in a real fs-backed implementation) or explicit rollback.
   */
  rollback(packId: string): UpdateOutcome {
    const snap = this.snapshots.get(packId);
    if (!snap) {
      return { packId, success: false, error: 'no snapshot to roll back to' };
    }
    this.installed.set(packId, snap);
    this.active.set(packId, snap.version);
    this.snapshots.delete(packId);
    return { packId, success: true, appliedVersion: snap.version };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** True if a < b in semver (x.y.z). */
export function semverLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

/** Build a correctly-signed pack for test fixtures. */
export function makeSignedPack(
  manifest: CapabilityManifest,
  signer: (message: string) => string,
): SignedPack {
  const data = JSON.stringify(manifest);
  const sha256 = sha256Hex(data);
  return {
    manifest,
    sha256,
    signature: signer(sha256),
    version: manifest.version,
  };
}
