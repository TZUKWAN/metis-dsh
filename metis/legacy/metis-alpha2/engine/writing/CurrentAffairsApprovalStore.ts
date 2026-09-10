/**
 * CurrentAffairsApprovalStore — 时政审批 receipt 存储与验证。
 *
 * 安全不变形：
 *  - Receipt 绑定 owner session + contentDigest + sourceSnapshotDigest
 *  - Nonce 保证唯一性，防止重放
 *  - Expiry 自动失效
 *  - 单次使用后标记为 consumed（防止 replay）
 *  - Content change → receipt 自动失效（digest mismatch）
 *
 * 不依赖 main/preload，纯 engine 层独立可用。
 */
import { randomUUID } from 'node:crypto';
import {
  isReceiptExpired,
  signReceipt,
  verifyReceiptSignature,
  generateReceiptSecret,
  type ApprovalReceipt,
} from '../runtime/CurrentAffairsRuntimeContract.js';

export interface ApprovalStoreDeps {
  now: () => number;
  /** TTL for receipts in milliseconds. Default 300s (5 min). */
  receiptTtlMs?: number;
  /**
   * HMAC signing secret. Must survive restarts (caller persists).
   * If not provided, a new one is generated (receipts won't survive restart).
   */
  signingSecret?: Buffer;
}

export class CurrentAffairsApprovalStore {
  readonly #deps: Required<Omit<ApprovalStoreDeps, 'signingSecret'>> & { signingSecret: Buffer };
  readonly #receipts = new Map<string, ApprovalReceipt>();
  readonly #consumed = new Set<string>();
  readonly #reserved = new Set<string>();
  readonly #reservationTokens = new Map<string, string>();
  readonly #fingerprints = new Set<string>();
  /** receiptId → ownerSessionId for exact owner cleanup */
  readonly #receiptOwners = new Map<string, string>();
  readonly #signingSecret: Buffer;

  constructor(deps: ApprovalStoreDeps) {
    this.#signingSecret = deps.signingSecret ?? generateReceiptSecret();
    this.#deps = { receiptTtlMs: 300_000, now: deps.now, signingSecret: this.#signingSecret };
  }

  /** Expose signing secret for caller persistence across restarts. */
  get signingSecret(): Buffer { return this.#signingSecret; }

  /** Issue a new approval receipt. Fails if already approved for same content key. */
  issue(params: {
    projectId: string;
    workflowId: string;
    profileId: string;
    manifestVersion: number;
    ownerSessionId: string;
    contentDigest: string;
    sourceSnapshotDigest: string;
  }): { ok: true; receipt: ApprovalReceipt } | { ok: false; code: string } {
    const now = this.#deps.now;
    const receiptId = `rcpt-${randomUUID()}`;
    const nonce = randomUUID();

    const unsigned: Omit<ApprovalReceipt, 'signature'> = {
      receiptId,
      requestId: `req-${randomUUID()}`,
      projectId: params.projectId,
      workflowId: params.workflowId,
      profileId: params.profileId,
      manifestVersion: params.manifestVersion,
      ownerSessionId: params.ownerSessionId,
      contentDigest: params.contentDigest,
      sourceSnapshotDigest: params.sourceSnapshotDigest,
      nonce,
      issuedAt: now(),
      expiresAt: now() + this.#deps.receiptTtlMs,
      approved: true,
    };

    const contentKey = `${params.projectId}:${params.workflowId}:${params.profileId}:${params.manifestVersion}:${params.ownerSessionId}:${params.contentDigest}:${params.sourceSnapshotDigest}`;
    if (this.#fingerprints.has(contentKey)) {
      return { ok: false, code: 'already_approved' };
    }

    const receipt = signReceipt(unsigned, this.#signingSecret);
    this.#receipts.set(receiptId, receipt);
    this.#fingerprints.add(contentKey);
    this.#receiptOwners.set(receiptId, params.ownerSessionId);
    return { ok: true, receipt };
  }

  /**
   * Reserve a receipt for export WITHOUT consuming.
   * Validates EXACT match on ALL bound fields against the receipt.
   * On success, returns an opaque token. Caller must commitExport on artifact
   * success, or releaseReservation on failure (safe retry).
   */
  reserveForExport(params: {
    receiptId: string;
    nonce: string;
    projectId: string;
    workflowId: string;
    profileId: string;
    manifestVersion: number;
    ownerSessionId: string;
    contentDigest: string;
    sourceSnapshotDigest: string;
  }): { ok: true; receipt: ApprovalReceipt; token: string } | { ok: false; code: string } {
    const receipt = this.#receipts.get(params.receiptId);
    if (!receipt) return { ok: false, code: 'receipt_missing' };

    // HMAC signature verification
    if (!verifyReceiptSignature(receipt, this.#signingSecret)) {
      return { ok: false, code: 'receipt_forged' };
    }

    // Exact field-by-field comparison
    if (!receipt.approved) return { ok: false, code: 'receipt_not_approved' };
    if (receipt.nonce !== params.nonce) return { ok: false, code: 'receipt_forged' };
    if (receipt.projectId !== params.projectId) return { ok: false, code: 'project_mismatch' };
    if (receipt.workflowId !== params.workflowId) return { ok: false, code: 'workflow_mismatch' };
    if (receipt.profileId !== params.profileId) return { ok: false, code: 'profile_mismatch' };
    if (receipt.manifestVersion !== params.manifestVersion) return { ok: false, code: 'version_mismatch' };
    if (receipt.ownerSessionId !== params.ownerSessionId) return { ok: false, code: 'owner_mismatch' };
    if (receipt.contentDigest !== params.contentDigest) return { ok: false, code: 'content_changed' };
    if (receipt.sourceSnapshotDigest !== params.sourceSnapshotDigest) return { ok: false, code: 'snapshot_mismatch' };

    if (isReceiptExpired(receipt, this.#deps.now())) return { ok: false, code: 'receipt_expired' };
    if (this.#consumed.has(params.receiptId)) return { ok: false, code: 'receipt_replayed' };
    if (this.#reserved.has(params.receiptId)) return { ok: false, code: 'receipt_already_reserved' };

    this.#reserved.add(params.receiptId);
    const token = randomUUID();
    this.#reservationTokens.set(token, params.receiptId);
    return { ok: true, receipt, token };
  }

  /** Commit a reserved receipt after artifact success. Marks as consumed. */
  commitExport(token: string): { ok: boolean } {
    const receiptId = this.#reservationTokens.get(token);
    if (!receiptId) return { ok: false };
    this.#reserved.delete(receiptId);
    this.#reservationTokens.delete(token);
    this.#consumed.add(receiptId);
    return { ok: true };
  }

  /**
   * Transactional finalize: synchronously execute publishCallback, then atomically
   * mark receipt consumed. Eliminates the window between commit and publish.
   *
   * - Re-validates reservation exists (token valid, not consumed)
   * - Calls publishCallback() in the same synchronous critical section
   * - On callback success: immediately marks consumed (cannot fail — in-memory)
   * - On callback throw: reservation STAYS ACTIVE; caller must releaseReservation
   *
   * No state where: artifact is visible but receipt unconsumed, OR receipt consumed
   * but artifact not published.
   */
  finalizeExport(token: string, publishCallback: () => void): { ok: true } | { ok: false; code: 'token_invalid' | 'receipt_already_consumed' | 'publish_failed' } {
    const receiptId = this.#reservationTokens.get(token);
    if (!receiptId) return { ok: false, code: 'token_invalid' };
    if (this.#consumed.has(receiptId)) return { ok: false, code: 'receipt_already_consumed' };

    try {
      publishCallback();
    } catch {
      // Callback threw — reservation stays active, caller must releaseReservation
      return { ok: false, code: 'publish_failed' };
    }

    // Publish succeeded — atomically mark consumed (in-memory ops, cannot fail)
    this.#reserved.delete(receiptId);
    this.#reservationTokens.delete(token);
    this.#consumed.add(receiptId);
    return { ok: true };
  }

  /** Release a reservation on failure — allows safe retry. */
  releaseReservation(token: string): { ok: boolean } {
    const receiptId = this.#reservationTokens.get(token);
    if (!receiptId) return { ok: false };
    this.#reserved.delete(receiptId);
    this.#reservationTokens.delete(token);
    return { ok: true };
  }

  /** Revoke a receipt (cancel approval). Clears fingerprint so re-issue is possible. */
  revoke(receiptId: string): { ok: boolean } {
    const receipt = this.#receipts.get(receiptId);
    if (!receipt) return { ok: false };
    // Clear fingerprint to allow re-issue
    const contentKey = `${receipt.projectId}:${receipt.workflowId}:${receipt.profileId}:${receipt.manifestVersion}:${receipt.ownerSessionId}:${receipt.contentDigest}:${receipt.sourceSnapshotDigest}`;
    this.#fingerprints.delete(contentKey);
    // Release any reservation
    this.#reserved.delete(receiptId);
    for (const [token, rid] of this.#reservationTokens) {
      if (rid === receiptId) this.#reservationTokens.delete(token);
    }
    // Re-sign with approved=false
    const { signature: _sig, ...unsigned } = receipt;
    void _sig;
    const revoked = signReceipt({ ...unsigned, approved: false }, this.#signingSecret);
    this.#receipts.set(receiptId, revoked);
    return { ok: true };
  }

  /** Get receipt status without consuming. */
  getStatus(receiptId: string): {
    exists: boolean; approved: boolean; expired: boolean; consumed: boolean
  } {
    const receipt = this.#receipts.get(receiptId);
    if (!receipt) return { exists: false, approved: false, expired: false, consumed: false };
    return {
      exists: true,
      approved: receipt.approved,
      expired: isReceiptExpired(receipt, this.#deps.now()),
      consumed: this.#consumed.has(receiptId),
    };
  }

  /** Clear all receipts, reservations, consumed tokens, and fingerprints for an owner. */
  clearOwner(ownerSessionId: string): void {
    // Collect receipt IDs owned by this owner
    const owned: string[] = [];
    for (const [id, owner] of this.#receiptOwners) {
      if (owner === ownerSessionId) owned.push(id);
    }
    // Clear all tracking for owned receipts
    for (const id of owned) {
      // Find and delete associated fingerprint
      const receipt = this.#receipts.get(id);
      if (receipt) {
        const contentKey = `${receipt.projectId}:${receipt.workflowId}:${receipt.profileId}:${receipt.manifestVersion}:${receipt.ownerSessionId}:${receipt.contentDigest}:${receipt.sourceSnapshotDigest}`;
        this.#fingerprints.delete(contentKey);
      }
      this.#receipts.delete(id);
      this.#consumed.delete(id);
      this.#reserved.delete(id);
      this.#receiptOwners.delete(id);
      for (const [token, rid] of this.#reservationTokens) {
        if (rid === id) this.#reservationTokens.delete(token);
      }
    }
  }
}
