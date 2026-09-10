/**
 * CurrentAffairsRuntimeService — DI-injectable CA workflow orchestrator.
 * Pure methods; testable without main side effects.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { CurrentAffairsManifestSchema, type CurrentAffairsManifest } from '../engine/writing/CurrentAffairsProfile.js';
import { CurrentAffairsService } from '../engine/writing/CurrentAffairsService.js';
import { buildExportPreview } from '../engine/writing/CurrentAffairsPreview.js';
import { CurrentAffairsSessionState } from '../engine/writing/CurrentAffairsSessionState.js';
import type { AdaptedSource } from '../engine/writing/CurrentAffairsSourceAdapter.js';
import type { CurrentAffairsRepositoryService } from '../engine/writing/CurrentAffairsRepositoryService.js';
import type { CurrentAffairsApprovalStore } from '../engine/writing/CurrentAffairsApprovalStore.js';
import type { CurrentAffairsArtifactService } from '../engine/writing/CurrentAffairsArtifactService.js';
import type { PublicApprovalReceipt } from '../engine/runtime/CurrentAffairsRuntimeContract.js';

export interface CARuntimeDeps {
  repository: CurrentAffairsRepositoryService;
  approvalStore: CurrentAffairsApprovalStore;
  artifactService: CurrentAffairsArtifactService;
  sessionState: CurrentAffairsSessionState;
  receiptSecret: Buffer | null;
  now: () => number;
  getSource: (id: string) => AdaptedSource | undefined;
  /** REQUIRED: Native confirmation dialog. */
  confirmApproval: (ctx: { ownerSessionId: string; projectId: string; workflowId: string; title: string; sourceCount: number; factCount: number; contentDigest: string }) => Promise<boolean>;
}

export class CurrentAffairsRuntimeService {
  readonly #deps: CARuntimeDeps;

  constructor(deps: CARuntimeDeps) {
    this.#deps = deps;
  }

  // ── Research ──────────────────────────────────────────────────

  async research(owner: string, params: {
    projectId: string; workflowId: string; profileId: string; manifestVersion: number;
    title: string; selectedSourceIds: string[];
    facts?: Array<{ claimId: string; statement: string; evidenceSourceIds: string[] }>;
    stances?: Array<{ claimId: string; stance: 'supports' | 'contradicts' | 'neutral' | 'mixed'; rationale: string; sourceId: string }>;
    interpretations?: Array<{ claimId: string; interpretation: string; synthesizesClaimIds: string[] }>;
  }): Promise<{
    ok: boolean; code?: string; draft?: boolean; approved?: boolean; readyForApproval?: boolean;
    phase?: string; exportReady?: boolean;
    temporalCheckPassed?: boolean; correctionReviewComplete?: boolean;
    verifiedSourceCount?: number; rejectedSourceCount?: number;
    sourceCount?: number; factCount?: number;
    errors?: string[];
    preview?: { title: string; summary: string; sections: Array<{ heading: string; content: string }>; sourceCount: number; factCount: number };
    contentDigest?: string; sourceSnapshotDigest?: string;
  }> {
    const now = this.#deps.now();
    const errors: string[] = [];
    const verifiedSources: AdaptedSource[] = [];
    const rejectedSourceIds: string[] = [];
    const maxSourceAgeDays = 365; // Main-owned freshness policy

    // Deduplicate
    const seen = new Set<string>();
    const uniqueIds = params.selectedSourceIds.filter(id => { if (seen.has(id)) { errors.push(`Duplicate source: ${id}`); return false; } seen.add(id); return true; });

    // Build canonical source list from repository via SourceAdapter
    for (const sourceId of uniqueIds) {
      const adapted = this.#deps.getSource(sourceId);
      if (!adapted) { rejectedSourceIds.push(sourceId); errors.push(`Source ${sourceId}: not found`); continue; }
      if (adapted.deleted) { rejectedSourceIds.push(sourceId); errors.push(`Source ${sourceId}: deleted`); continue; }
      if (adapted.projectId !== params.projectId) { rejectedSourceIds.push(sourceId); errors.push(`Source ${sourceId}: cross-project`); continue; }
      if (!adapted.contentDigest) { rejectedSourceIds.push(sourceId); errors.push(`Source ${sourceId}: missing digest`); continue; }
      // Freshness: check fetchedAt age
      const ageDays = adapted.fetchedAt ? (now - adapted.fetchedAt) / 86400000 : 0;
      if (ageDays > maxSourceAgeDays) { rejectedSourceIds.push(sourceId); errors.push(`Source ${sourceId}: stale (${Math.round(ageDays)}d > ${maxSourceAgeDays}d)`); continue; }
      // Future source check
      if (adapted.publishedAt && adapted.publishedAt > now) { rejectedSourceIds.push(sourceId); errors.push(`Source ${sourceId}: future published date`); continue; }
      verifiedSources.push(adapted);
    }

    if (verifiedSources.length === 0) {
      return { ok: false as const, code: 'no_valid_sources' as const, errors: [...errors, 'No valid sources selected'] };
    }

    this.#deps.sessionState.clearContext(owner, params.projectId, params.workflowId);

    // Build canonical manifest from adapted sources (renderer fields ignored)
    const manifest: CurrentAffairsManifest = {
      schemaVersion: 1,
      projectId: params.projectId,
      workflowId: params.workflowId,
      profileId: params.profileId,
      manifestVersion: params.manifestVersion,
      title: params.title,
      timeWindow: { fetchedAt: now, timeSensitive: true, maxSourceAgeDays: 180 },
      sources: verifiedSources.map(s => ({
        sourceId: s.id,
        kind: s.kind as CurrentAffairsManifest['sources'][0]['kind'],
        title: s.title,
        authors: s.authors,
        publishedAt: s.publishedAt ?? undefined,
        fetchedAt: s.fetchedAt ?? now,
        url: s.url ?? undefined,
        correctionState: s.correctionState as CurrentAffairsManifest['sources'][0]['correctionState'],
        contentDigest: s.contentDigest ?? undefined,
      })),
      facts: (params.facts ?? []).map(f => ({ claimId: f.claimId, statement: f.statement, evidenceSourceIds: f.evidenceSourceIds, verifiedAt: now })),
      stances: (params.stances ?? []).map(s => ({ claimId: s.claimId, stance: s.stance, rationale: s.rationale, sourceId: s.sourceId, annotatedAt: now })),
      interpretations: (params.interpretations ?? []).map(i => ({ claimId: i.claimId, interpretation: i.interpretation, synthesizesClaimIds: i.synthesizesClaimIds, authorId: owner, authoredAt: now })),
      createdAt: now,
      updatedAt: now,
    };

    const parsed = CurrentAffairsManifestSchema.safeParse(manifest);
    if (!parsed.success) return { ok: false, code: 'manifest_invalid' as const, errors: ['Invalid canonical manifest'] };

    const service = new CurrentAffairsService({ now: this.#deps.now });
    const { state, errors: workflowErrors } = service.executeWorkflow(manifest);
    const allErrors = [...errors, ...workflowErrors];

    this.#deps.sessionState.clearContext(owner, params.projectId, params.workflowId);
    if (allErrors.length > 0 || !state.temporalCheckPassed || !state.correctionReviewComplete) {
      return { ok: false, code: 'workflow_validation_failed' as const, errors: allErrors };
    }

    const contentDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const sourceSnapshotDigest = this.#deps.repository.computeSourceSnapshotDigest(manifest);
    // Sanitize: strip self-approved flags, enforce phase='approval'
    const sanitizedState = { ...state, phase: 'approval' as const, approved: false, exportReady: false };
    const fullPreview = buildExportPreview(manifest, sanitizedState);
    // Public schema: only 5 fields (strictObject rejects timestamp/exportReady)
    const publicPreview = { title: fullPreview.title, summary: fullPreview.summary, sections: fullPreview.sections, sourceCount: fullPreview.sourceCount, factCount: fullPreview.factCount };

    const saved = this.#deps.sessionState.saveContext({
      ownerSessionId: owner, projectId: params.projectId, workflowId: params.workflowId,
      profileId: params.profileId, manifestVersion: params.manifestVersion,
      manifest, state: sanitizedState, sourceSnapshotDigest, preview: fullPreview,
    });
    if (!saved.ok) return { ok: false, code: 'context_save_failed' as const, errors: [saved.error ?? 'context save failed'] };

    return {
      ok: true, draft: true as const, approved: false as const, readyForApproval: true as const,
      phase: 'approval' as const, exportReady: false as const,
      temporalCheckPassed: state.temporalCheckPassed,
      correctionReviewComplete: state.correctionReviewComplete,
      verifiedSourceCount: verifiedSources.length, rejectedSourceCount: rejectedSourceIds.length,
      sourceCount: manifest.sources.length, factCount: manifest.facts?.length ?? 0,
      errors: [], preview: publicPreview, contentDigest, sourceSnapshotDigest,
    };
  }

  // ── Approve ───────────────────────────────────────────────────

  async approve(owner: string, params: {
    projectId: string; workflowId: string; profileId: string;
    manifestVersion: number; contentDigest: string; sourceSnapshotDigest: string;
  }): Promise<{ ok: boolean; receipt?: PublicApprovalReceipt; code?: string }> {
    if (!this.#deps.receiptSecret) return { ok: false, code: 'signing_key_unavailable' };

    const validation = this.#deps.sessionState.validateForApproval({ ownerSessionId: owner, ...params });
    if (!validation.ok) return { ok: false, code: validation.code };

    // P0: Re-verify repository before issuing receipt.
    // Source may have been retracted/corrupted/stale between research and approval.
    const staleCheck = this.#deps.repository.verifyManifest(validation.context.manifest);
    if (staleCheck.some(r => !r.verified)) return { ok: false, code: 'source_stale' };

    // Native confirmation gate — uses canonical context from SessionState
    const confirmed = await this.#deps.confirmApproval({
      ownerSessionId: owner,
      projectId: params.projectId,
      workflowId: params.workflowId,
      title: validation.context.manifest.title,
      sourceCount: validation.context.manifest.sources.length,
      factCount: validation.context.manifest.facts?.length ?? 0,
      contentDigest: params.contentDigest,
    });
    if (!confirmed) return { ok: false, code: 'approval_denied' };

    // TOCTOU re-verify: source may have changed while user viewed the dialog
    const postConfirmCheck = this.#deps.repository.verifyManifest(validation.context.manifest);
    if (postConfirmCheck.some(r => !r.verified)) return { ok: false, code: 'source_stale' };

    const result = this.#deps.approvalStore.issue({
      projectId: params.projectId, workflowId: params.workflowId, profileId: params.profileId,
      manifestVersion: params.manifestVersion, ownerSessionId: owner,
      contentDigest: params.contentDigest, sourceSnapshotDigest: params.sourceSnapshotDigest,
    });
    if (!result.ok) return { ok: false, code: result.code };

    // Atomically mark context approved
    const marked = this.#deps.sessionState.markApproved(owner, params.projectId, params.workflowId, params.contentDigest, params.sourceSnapshotDigest);
    if (!marked.ok) {
      this.#deps.approvalStore.revoke(result.receipt.receiptId);
      return { ok: false, code: 'approve_mark_failed' };
    }

    // Return public receipt (no HMAC/owner in renderer)
    return {
      ok: true,
      receipt: {
        receiptId: result.receipt.receiptId,
        nonce: result.receipt.nonce,
        expiresAt: result.receipt.expiresAt,
        projectId: result.receipt.projectId,
        workflowId: result.receipt.workflowId,
        profileId: result.receipt.profileId,
        manifestVersion: result.receipt.manifestVersion,
        contentDigest: result.receipt.contentDigest,
        sourceSnapshotDigest: result.receipt.sourceSnapshotDigest,
      },
    };
  }

  // ── Export ────────────────────────────────────────────────────

  async export(owner: string, params: {
    projectId: string; workflowId: string;
    receiptId: string; receiptNonce: string;
    contentDigest: string; sourceSnapshotDigest: string;
  }): Promise<{ ok: boolean; artifactId?: string; artifactVersion?: number; contentDigest?: string; gatePassed?: boolean; gateIssues?: Array<{ gate: string; severity: 'warning' | 'error'; message: string }>; recordCount?: number; provenance?: Record<string, unknown>; code?: string }> {
    
    // Use pending ctx canonical manifest, NOT renderer-submitted manifest
    const ctx = this.#deps.sessionState.getContext(owner, params.projectId, params.workflowId);
    if (!ctx) return { ok: false, code: 'no_pending_research' };
    if (!ctx.approved || !ctx.exportReady || !ctx.state.approved || !ctx.state.exportReady) return { ok: false, code: 'not_approved' };

    // Re-verify repository freshness against canonical manifest
    const repoResults = this.#deps.repository.verifyManifest(ctx.manifest);
    const stale = repoResults.some(r => !r.verified);
    if (stale) return { ok: false, code: 'source_stale' };

    // Re-compute digests from canonical manifest, compare with ctx + receipt
    const actualContentDigest = createHash('sha256').update(JSON.stringify(ctx.manifest)).digest('hex');
    const actualSnapshot = this.#deps.repository.computeSourceSnapshotDigest(ctx.manifest);
    if (actualContentDigest !== ctx.contentDigest || actualContentDigest !== params.contentDigest) {
      return { ok: false, code: 'content_changed' };
    }
    if (actualSnapshot !== ctx.sourceSnapshotDigest || actualSnapshot !== params.sourceSnapshotDigest) {
      return { ok: false, code: 'snapshot_changed' };
    }

    // Reserve receipt (validates HMAC + all fields exact match)
    const reserve = this.#deps.approvalStore.reserveForExport({
      receiptId: params.receiptId, nonce: params.receiptNonce,
      projectId: params.projectId, workflowId: params.workflowId,
      profileId: ctx.profileId, manifestVersion: ctx.manifestVersion,
      ownerSessionId: owner, contentDigest: params.contentDigest, sourceSnapshotDigest: params.sourceSnapshotDigest,
    });
    if (!reserve.ok) return { ok: false, code: reserve.code };

    // Build export plan from approved ctx (no auto-approval re-run)
    const plan = this.#deps.artifactService.buildPlan(ctx.manifest, ctx.state);
    if (!plan.ok) {
      this.#deps.approvalStore.releaseReservation(reserve.token);
      return { ok: false, code: 'gate_blocked' };
    }

    // Stage 1: Write artifact to staging directory (NOT visible at final target)
    const writeResult = this.#deps.artifactService.writeArtifact(plan.plan, ctx.manifestVersion, reserve.receipt.receiptId, { stageOnly: true });
    if (!writeResult.ok || !writeResult.stagingDir) {
      this.#deps.approvalStore.releaseReservation(reserve.token);
      return { ok: false, code: 'write_failed' };
    }
    const stagingDir = writeResult.stagingDir;

    try {
      // Stage 2: Strict verify staging via ArtifactService.verifyStaged
      const verifyResult = this.#deps.artifactService.verifyStaged(stagingDir, {
        artifactId: writeResult.artifactId,
        artifactVersion: writeResult.artifactVersion,
        manifestDigest: writeResult.manifestDigest,
        receiptId: reserve.receipt.receiptId,
        files: writeResult.files,
      });
      if (!verifyResult.ok) {
        this.#deps.approvalStore.releaseReservation(reserve.token);
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        return { ok: false, code: 'readback_file_mismatch' };
      }

      // Stage 3+4: Transactional finalize — publish + commit atomically
      let publishStatus: string = 'ok';
      const finalizeResult = this.#deps.approvalStore.finalizeExport(
        reserve.token,
        () => { publishStatus = this.#deps.artifactService.publishStaged(stagingDir, writeResult.targetDir); },
      );
      if (!finalizeResult.ok) {
        // Publish threw (rename never happened or undo succeeded)
        if (fs.existsSync(writeResult.targetDir)) {
          this.#deps.approvalStore.commitExport(reserve.token);
        } else {
          try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
          this.#deps.approvalStore.releaseReservation(reserve.token);
          return { ok: false, code: 'write_failed' };
        }
      }
      if (publishStatus === 'visibility_uncertain') {
        // Artifact MAY be visible, receipt is consumed (no replay).
        // Return failure so caller knows export is not confirmed durable.
        this.#deps.sessionState.clearContext(owner, params.projectId, params.workflowId);
        return { ok: false, code: 'visibility_uncertain', artifactId: writeResult.artifactId, artifactVersion: writeResult.artifactVersion };
      }
      // Success: receipt consumed, artifact published at targetDir
    } catch {
      if (fs.existsSync(writeResult.targetDir)) {
        this.#deps.approvalStore.commitExport(reserve.token);
      } else {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        this.#deps.approvalStore.releaseReservation(reserve.token);
        return { ok: false, code: 'write_failed' };
      }
    }

    this.#deps.sessionState.clearContext(owner, params.projectId, params.workflowId);

    return {
      ok: true, artifactId: writeResult.artifactId, artifactVersion: writeResult.artifactVersion,
      contentDigest: writeResult.manifestDigest,
      gatePassed: true, gateIssues: [], recordCount: writeResult.files.length,
      provenance: { exportedAt: this.#deps.now(), exportedBy: owner, receiptId: reserve.receipt.receiptId, sourceCount: ctx.manifest.sources.length },
    };
  }

  // ── Cancel ────────────────────────────────────────────────────

  cancel(owner: string, params:
    | { action: 'discard_draft'; projectId: string; workflowId: string }
    | { action: 'revoke_approval'; projectId: string; workflowId: string; receiptId: string; receiptNonce: string; contentDigest: string; sourceSnapshotDigest: string; profileId: string; manifestVersion: number }
  ): { ok: true; action: 'discard_draft' | 'revoke_approval' } | { ok: false; code: 'no_pending_context' | 'already_approved_use_revoke' | 'not_approved' | 'receipt_not_found' | 'revoke_failed' | 'receipt_validation_failed' } {
    if (params.action === 'discard_draft') {
      // Discard pre-approval draft — just clear the pending context (no receipt exists)
      const ctx = this.#deps.sessionState.getContext(owner, params.projectId, params.workflowId);
      if (!ctx) return { ok: false, code: 'no_pending_context' };
      // Must not have an active receipt (pre-approval only)
      if (ctx.approved) return { ok: false, code: 'already_approved_use_revoke' };
      this.#deps.sessionState.clearContext(owner, params.projectId, params.workflowId);
      return { ok: true, action: 'discard_draft' };
    }

    // revoke_approval: exact receipt revoke with full tuple validation
    const ctx = this.#deps.sessionState.getContext(owner, params.projectId, params.workflowId);
    if (!ctx) return { ok: false, code: 'no_pending_context' };
    if (!ctx.approved || !ctx.exportReady) return { ok: false, code: 'not_approved' };

    // Verify receipt exists and matches (nonce/content/source all validated by approvalStore)
    const reserve = this.#deps.approvalStore.reserveForExport({
      receiptId: params.receiptId, nonce: params.receiptNonce,
      projectId: params.projectId, workflowId: params.workflowId,
      profileId: params.profileId, manifestVersion: params.manifestVersion,
      ownerSessionId: owner, contentDigest: params.contentDigest, sourceSnapshotDigest: params.sourceSnapshotDigest,
    });
    // If receipt is already reserved/consumed, we can still revoke
    if (!reserve.ok && reserve.code !== 'receipt_already_reserved' && reserve.code !== 'receipt_replayed') {
      return { ok: false, code: 'receipt_validation_failed' };
    }

    // Revoke receipt
    const revoked = this.#deps.approvalStore.revoke(params.receiptId);
    if (!revoked.ok) return { ok: false, code: 'revoke_failed' };

    // Only clear context after successful revoke
    this.#deps.sessionState.clearContext(owner, params.projectId, params.workflowId);
    return { ok: true, action: 'revoke_approval' };
  }

  // ── Clear owner ───────────────────────────────────────────────

  /** Clear all owner state: contexts, receipts, reservations. */
  clearOwner(owner: string): void {
    this.#deps.sessionState.clearOwner(owner);
    this.#deps.approvalStore.clearOwner(owner);
  }

  /** Expose approval receipt status for IPC handler to discriminate discard_draft vs revoke_approval. */
  getApprovalStatus(receiptId: string): { exists: boolean; nonce?: string } {
    return this.#deps.approvalStore.getStatus(receiptId);
  }
}
