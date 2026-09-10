import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { ArtifactManifest } from '../engine/artifacts/ArtifactManifest.js';
import type { ReferenceValidationResult } from '../engine/evidence/ReferenceValidator.js';
import { getReferenceValidator } from '../engine/evidence/ReferenceValidator.js';
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type { Source } from '../engine/persistence/researchModel.js';
import {
  citationAttestationMatchesSource,
  isTrustedCitationAttestation,
  type CitationTruthAttestation,
} from '../engine/writing/CitationTruth.js';
import {
  canonicalReceiptPayload,
  CitationTruthReceiptSchema,
  type CitationTruthReceipt,
  type CitationTruthRequest,
  type UnsignedCitationTruthReceipt,
} from '../engine/writing/CitationTruthReceipt.js';
import {
  resolveCitationTruthAttestation,
  type CitationTruthResolutionRequest,
} from '../engine/writing/CitationTruthResolver.js';

export interface CitationReferenceValidator {
  validateDoi(
    value: string,
    options: { expectedTitle: string; expectedAuthors: string[]; expectedYear?: number },
  ): Promise<ReferenceValidationResult>;
  validateArxiv(
    value: string,
    options: { expectedTitle: string; expectedAuthors: string[]; expectedYear?: number },
  ): Promise<ReferenceValidationResult>;
}

export interface CitationTruthReceiptIssueRequest {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  content: string;
  citedSourceIds: readonly string[];
  citations: readonly CitationTruthRequest[];
  now?: number;
}

export interface CitationTruthReceiptVerification {
  ok: boolean;
  reason?: string;
  attestations?: CitationTruthAttestation[];
}

export interface CitationTruthReceiptServiceOptions {
  validator?: CitationReferenceValidator;
  resolver?: (request: CitationTruthResolutionRequest) => Promise<CitationTruthAttestation>;
  now?: () => number;
  ttlMs?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function citationSourceSnapshotDigest(source: Source): string {
  return sha256(JSON.stringify(stableValue({
    id: source.id,
    projectId: source.projectId,
    kind: source.kind,
    title: source.title,
    authors: source.authors,
    year: source.year,
    venue: source.venue,
    identifier: source.identifier,
    identifierType: source.identifierType,
    externalUrl: source.externalUrl,
    tags: source.tags,
    sourceVersionHash: source.sourceVersionHash,
    metadata: source.metadata,
    provenance: source.provenance,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    deletedAt: source.deletedAt,
  })));
}

function canonicalCitationKeys(source: Source): string[] {
  const keys = [source.id, source.identifier.trim()];
  const firstFamily = source.authors[0]?.trim().split(/\s+/u).at(-1);
  if (firstFamily && source.year !== null) keys.push(`${firstFamily}, ${source.year}`);
  return [...new Set(keys.filter(Boolean))];
}

function sign(secret: Buffer, payload: UnsignedCitationTruthReceipt): string {
  return createHmac('sha256', secret).update(canonicalReceiptPayload(payload), 'utf8').digest('hex');
}

function sameSignature(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    return leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

export class CitationTruthReceiptService {
  private readonly validator: CitationReferenceValidator;
  private readonly resolver: (request: CitationTruthResolutionRequest) => Promise<CitationTruthAttestation>;
  private readonly clock: () => number;
  private readonly ttlMs: number;

  constructor(
    secret: Buffer,
    options: CitationTruthReceiptServiceOptions = {},
  ) {
    if (secret.length < 32) throw new Error('Citation receipt secret must contain at least 256 bits');
    this.secret = Buffer.from(secret);
    this.validator = options.validator ?? getReferenceValidator();
    this.resolver = options.resolver ?? resolveCitationTruthAttestation;
    this.clock = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000 || this.ttlMs > 90 * 24 * 60 * 60_000) {
      throw new Error('Citation receipt TTL is outside the permitted range');
    }
  }

  private readonly secret: Buffer;

  private currentSource(repository: ResearchRepository, projectId: string, sourceId: string): Source | undefined {
    const source = repository.getSource(sourceId);
    return source?.projectId === projectId && source.deletedAt === null ? source : undefined;
  }

  private async validateReference(source: Source): Promise<ReferenceValidationResult | undefined> {
    const options = {
      expectedTitle: source.title,
      expectedAuthors: [...source.authors],
      ...(source.year === null ? {} : { expectedYear: source.year }),
    };
    if (source.identifierType === 'doi') return this.validator.validateDoi(source.identifier, options);
    if (source.identifierType === 'arxiv') return this.validator.validateArxiv(source.identifier, options);
    return undefined;
  }

  private async resolveCurrentTruth(
    source: Source,
    locator: string,
    now: number,
  ): Promise<{ attestation: CitationTruthAttestation; validatedAt: number } | undefined> {
    const validation = await this.validateReference(source);
    if (
      !validation
      || !validation.exists
      || validation.retracted
      || validation.consistency?.overallMatch !== true
      || validation.validatedAt > now + 60_000
      || now - validation.validatedAt > 5 * 60_000
    ) return undefined;
    const issn = typeof source.metadata.issn === 'string' ? source.metadata.issn : undefined;
    const attestation = await this.resolver({
      sourceId: source.id,
      citationKeys: canonicalCitationKeys(source),
      identifierType: source.identifierType,
      identifier: source.identifier,
      locator,
      venue: source.venue || undefined,
      issn,
      now,
    });
    if (!citationAttestationMatchesSource(attestation, source)) return undefined;
    if (!isTrustedCitationAttestation(attestation, { now }).ok) return undefined;
    return { attestation, validatedAt: validation.validatedAt };
  }

  async issueReceipts(
    repository: ResearchRepository,
    request: CitationTruthReceiptIssueRequest,
  ): Promise<CitationTruthReceipt[] | null> {
    const project = repository.getProject(request.projectId);
    if (!project || project.deletedAt !== null || request.artifactVersion < 1) return null;
    if (request.citedSourceIds.length === 0 || request.citations.length !== request.citedSourceIds.length) return null;
    const requestedBySource = new Map(request.citations.map((citation) => [citation.sourceId, citation]));
    if (requestedBySource.size !== request.citations.length) return null;
    const contentDigest = sha256(request.content);
    const now = request.now ?? this.clock();
    const receipts: CitationTruthReceipt[] = [];
    for (const sourceId of request.citedSourceIds) {
      const citation = requestedBySource.get(sourceId);
      const source = this.currentSource(repository, request.projectId, sourceId);
      if (!citation || !citation.locator.trim() || !source) return null;
      const truth = await this.resolveCurrentTruth(source, citation.locator, now);
      if (!truth) return null;
      const unsigned: UnsignedCitationTruthReceipt = {
        schemaVersion: 1,
        issuer: 'metis-main',
        receiptId: `ctr_${randomUUID().replaceAll('-', '')}`,
        nonce: randomBytes(24).toString('base64url'),
        projectId: request.projectId,
        artifactId: request.artifactId,
        artifactVersion: request.artifactVersion,
        contentDigest,
        sourceId,
        sourceSnapshotDigest: citationSourceSnapshotDigest(source),
        attestation: truth.attestation,
        referenceValidatedAt: truth.validatedAt,
        issuedAt: now,
        expiresAt: now + this.ttlMs,
      };
      receipts.push(CitationTruthReceiptSchema.parse({ ...unsigned, signature: sign(this.secret, unsigned) }));
    }
    return receipts;
  }

  verifyManifestCurrent(
    repository: ResearchRepository,
    manifest: ArtifactManifest,
    content: string,
    now = this.clock(),
  ): CitationTruthReceiptVerification {
    const receipts = manifest.citationTruthReceipts ?? [];
    if (receipts.length !== manifest.citedSourceIds.length || receipts.length === 0) {
      return { ok: false, reason: 'receipt_count_mismatch' };
    }
    const ids = new Set<string>();
    const nonces = new Set<string>();
    const sources = new Set<string>();
    const attestations: CitationTruthAttestation[] = [];
    const contentDigest = sha256(content);
    for (const rawReceipt of receipts) {
      const parsed = CitationTruthReceiptSchema.safeParse(rawReceipt);
      if (!parsed.success) return { ok: false, reason: 'receipt_invalid' };
      const receipt = parsed.data;
      if (ids.has(receipt.receiptId) || nonces.has(receipt.nonce) || sources.has(receipt.sourceId)) {
        return { ok: false, reason: 'receipt_replayed' };
      }
      ids.add(receipt.receiptId);
      nonces.add(receipt.nonce);
      sources.add(receipt.sourceId);
      const { signature, ...unsigned } = receipt;
      if (!sameSignature(signature, sign(this.secret, unsigned))) return { ok: false, reason: 'receipt_signature_invalid' };
      if (
        receipt.projectId !== manifest.projectId
        || receipt.artifactId !== manifest.id
        || receipt.artifactVersion !== manifest.version
        || receipt.contentDigest !== contentDigest
        || receipt.issuedAt > now + 60_000
        || receipt.expiresAt <= now
      ) return { ok: false, reason: 'receipt_binding_invalid' };
      const source = this.currentSource(repository, manifest.projectId, receipt.sourceId);
      if (
        !source
        || citationSourceSnapshotDigest(source) !== receipt.sourceSnapshotDigest
        || !citationAttestationMatchesSource(receipt.attestation, source)
        || !isTrustedCitationAttestation(receipt.attestation, { now }).ok
      ) return { ok: false, reason: 'receipt_source_not_current' };
      attestations.push(receipt.attestation);
    }
    if (manifest.citedSourceIds.some((sourceId) => !sources.has(sourceId))) {
      return { ok: false, reason: 'receipt_source_mismatch' };
    }
    return { ok: true, attestations };
  }

  async verifyAndRevalidateManifest(
    repository: ResearchRepository,
    manifest: ArtifactManifest,
    content: string,
    now = this.clock(),
  ): Promise<CitationTruthReceiptVerification> {
    const verified = this.verifyManifestCurrent(repository, manifest, content, now);
    if (!verified.ok) return verified;
    const attestations: CitationTruthAttestation[] = [];
    for (const receipt of manifest.citationTruthReceipts ?? []) {
      const source = this.currentSource(repository, manifest.projectId, receipt.sourceId);
      if (!source) return { ok: false, reason: 'receipt_source_not_current' };
      const truth = await this.resolveCurrentTruth(source, receipt.attestation.locator, now);
      if (!truth) return { ok: false, reason: 'reference_revalidation_failed' };
      attestations.push(truth.attestation);
    }
    return { ok: true, attestations };
  }
}
