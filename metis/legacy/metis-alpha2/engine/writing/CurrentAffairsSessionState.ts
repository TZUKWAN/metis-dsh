/**
 * CurrentAffairsSessionState — main-process bounded pending context.
 *
 * Lifecycle:
 *   research → saveContext (keyed by owner+project+workflow)
 *   approve  → validateAgainstContext (reject if no context or mismatch)
 *   export   → re-verify repo + re-compute → reserve
 *   cancel   → revoke + clearContext (same owner exact tuple)
 *   navigate/destroy → clearOwner (removes all contexts + receipts for owner)
 *
 * TTL + per-owner limits prevent memory DoS.
 */
import { createHash } from 'node:crypto';
import type { CurrentAffairsManifest } from './CurrentAffairsProfile.js';
import type { CurrentAffairsWorkflowState } from './CurrentAffairsWorkflow.js';

export interface PendingContext {
  ownerSessionId: string;
  projectId: string;
  workflowId: string;
  profileId: string;
  manifestVersion: number;
  manifest: CurrentAffairsManifest;
  state: CurrentAffairsWorkflowState;
  approved: boolean;
  exportReady: boolean;
  contentDigest: string;
  sourceSnapshotDigest: string;
  preview: {
    title: string;
    summary: string;
    sections: Array<{ heading: string; content: string }>;
    sourceCount: number;
    factCount: number;
  };
  createdAt: number;
  expiresAt: number;
}

export interface SessionStateConfig {
  /** Context TTL in ms (default 5 min). */
  contextTtlMs?: number;
  /** Max pending contexts per owner (default 10). */
  maxContextsPerOwner?: number;
  now: () => number;
}

export class CurrentAffairsSessionState {
  readonly #config: Required<SessionStateConfig>;
  readonly #contexts = new Map<string, PendingContext>();

  constructor(config: SessionStateConfig) {
    this.#config = {
      contextTtlMs: 300_000,
      maxContextsPerOwner: 10,
      ...config,
    };
  }

  private key(owner: string, project: string, workflow: string): string {
    return `${owner}:${project}:${workflow}`;
  }

  /** Save pending context after successful research. */
  saveContext(params: {
    ownerSessionId: string;
    projectId: string;
    workflowId: string;
    profileId: string;
    manifestVersion: number;
    manifest: CurrentAffairsManifest;
    state: CurrentAffairsWorkflowState;
    sourceSnapshotDigest: string;
    preview: PendingContext['preview'];
  }): { ok: boolean; error?: string } {
    const k = this.key(params.ownerSessionId, params.projectId, params.workflowId);
    this.#purgeExpired();

    // Check per-owner limits
    const ownerContexts = [...this.#contexts.values()].filter(
      (c) => c.ownerSessionId === params.ownerSessionId,
    );
    if (ownerContexts.length >= this.#config.maxContextsPerOwner) {
      return { ok: false, error: 'Too many pending contexts for this owner' };
    }

    const now = this.#config.now();
    const contentDigest = createHash('sha256').update(JSON.stringify(params.manifest)).digest('hex');

    this.#contexts.set(k, {
      ownerSessionId: params.ownerSessionId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      profileId: params.profileId,
      manifestVersion: params.manifestVersion,
      manifest: params.manifest,
      state: params.state,
      approved: false,
      exportReady: false,
      contentDigest,
      sourceSnapshotDigest: params.sourceSnapshotDigest,
      preview: params.preview,
      createdAt: now,
      expiresAt: now + this.#config.contextTtlMs,
    });

    return { ok: true };
  }

  /** Get pending context for approval validation. Returns null if not found or expired. */
  getContext(owner: string, project: string, workflow: string): PendingContext | null {
    const ctx = this.#contexts.get(this.key(owner, project, workflow));
    if (!ctx) return null;
    if (this.#config.now() > ctx.expiresAt) {
      this.#contexts.delete(this.key(owner, project, workflow));
      return null;
    }
    return ctx;
  }

  /**
   * Validate approval request against pending context.
   * Rejects if: no prior research, digest mismatch, version mismatch, or cross-owner.
   */
  validateForApproval(params: {
    ownerSessionId: string;
    projectId: string;
    workflowId: string;
    profileId: string;
    manifestVersion: number;
    contentDigest: string;
    sourceSnapshotDigest: string;
  }): { ok: true; context: PendingContext } | { ok: false; code: string } {
    const ctx = this.getContext(params.ownerSessionId, params.projectId, params.workflowId);
    if (!ctx) return { ok: false, code: 'no_pending_research' };
    if (ctx.ownerSessionId !== params.ownerSessionId) return { ok: false, code: 'cross_owner' };
    if (ctx.contentDigest !== params.contentDigest) return { ok: false, code: 'content_changed' };
    if (ctx.sourceSnapshotDigest !== params.sourceSnapshotDigest) return { ok: false, code: 'snapshot_changed' };
    if (ctx.manifestVersion !== params.manifestVersion) return { ok: false, code: 'version_mismatch' };
    if (ctx.profileId !== params.profileId) return { ok: false, code: 'profile_mismatch' };
    return { ok: true, context: ctx };
  }

  /** Atomically mark context as approved after receipt issued. Fails if context missing or digest mismatch. */
  markApproved(owner: string, project: string, workflow: string, contentDigest: string, sourceSnapshotDigest: string): { ok: boolean } {
    const ctx = this.#contexts.get(this.key(owner, project, workflow));
    if (!ctx) return { ok: false };
    if (ctx.contentDigest !== contentDigest || ctx.sourceSnapshotDigest !== sourceSnapshotDigest) return { ok: false };
    this.#contexts.set(this.key(owner, project, workflow), {
      ...ctx, approved: true, exportReady: true,
      state: { ...ctx.state, approved: true, exportReady: true, phase: 'preview' as const },
    });
    return { ok: true };
  }

  /** Clear context after successful export. */
  clearContext(owner: string, project: string, workflow: string): void {
    this.#contexts.delete(this.key(owner, project, workflow));
  }

  /** Clear all contexts for an owner (navigation/destroy). */
  clearOwner(owner: string): void {
    for (const [k, ctx] of this.#contexts) {
      if (ctx.ownerSessionId === owner) this.#contexts.delete(k);
    }
  }

  /** Purge expired contexts. Called before save. */
  #purgeExpired(): void {
    const now = this.#config.now();
    for (const [k, ctx] of this.#contexts) {
      if (now > ctx.expiresAt) this.#contexts.delete(k);
    }
  }
}
