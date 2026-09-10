import { z } from 'zod';

export const CURRENT_AFFAIRS_PROFILE_VERSION = 1 as const;

export const CurrentAffairsSourceKindSchema = z.enum([
  'policy_document', 'official_statistics', 'authoritative_news',
  'legislative_record', 'regulatory_filing', 'expert_testimony', 'institutional_report',
]);
export type CurrentAffairsSourceKind = z.infer<typeof CurrentAffairsSourceKindSchema>;

export const CurrentAffairsTimeWindowSchema = z.strictObject({
  publishedAt: z.number().int().min(0).optional(),
  fetchedAt: z.number().int().min(0),
  effectiveAt: z.number().int().min(0).optional(),
  applicabilityStart: z.number().int().min(0).optional(),
  applicabilityEnd: z.number().int().min(0).optional(),
  timeSensitive: z.boolean(),
  maxSourceAgeDays: z.number().int().min(1).max(3650).default(90),
});
export type CurrentAffairsTimeWindow = z.infer<typeof CurrentAffairsTimeWindowSchema>;

export const FactLayerSchema = z.strictObject({
  claimId: z.string().min(1),
  statement: z.string().min(1).max(8000),
  evidenceSourceIds: z.array(z.string().min(1)).min(1).max(20),
  verifiedAt: z.number().int().min(0).optional(),
  verificationMethod: z.enum(['primary_source','cross_referenced','expert_review','statistical_consensus']).optional(),
});

export const StanceLayerSchema = z.strictObject({
  claimId: z.string().min(1),
  stance: z.enum(['supports','contradicts','neutral','mixed']),
  rationale: z.string().min(1).max(4000),
  sourceId: z.string().min(1),
  annotatedAt: z.number().int().min(0),
});

export const InterpretationLayerSchema = z.strictObject({
  claimId: z.string().min(1),
  interpretation: z.string().min(1).max(8000),
  synthesizesClaimIds: z.array(z.string().min(1)).min(1).max(20),
  authorId: z.string().min(1),
  authoredAt: z.number().int().min(0),
});

export const CorrectionStateSchema = z.enum(['clean','correction_pending','corrected','retracted']);
export type CorrectionState = z.infer<typeof CorrectionStateSchema>;

export const CurrentAffairsSourceRecordSchema = z.strictObject({
  sourceId: z.string().min(1),
  kind: CurrentAffairsSourceKindSchema,
  title: z.string().min(1).max(1000),
  authors: z.array(z.string().min(1)).max(100),
  publishedAt: z.number().int().min(0).optional(),
  fetchedAt: z.number().int().min(0),
  effectiveAt: z.number().int().min(0).optional(),
  url: z.string().refine((v) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return !v; } }, { message: 'URL must be http/https or absent' }).optional(),
  correctionState: CorrectionStateSchema,
  correctionHistory: z.array(z.strictObject({
    version: z.number().int().positive(),
    correctedAt: z.number().int().min(0),
    reason: z.string().min(1).max(2000),
  })).optional(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
export type CurrentAffairsSourceRecord = z.infer<typeof CurrentAffairsSourceRecordSchema>;

export const CurrentAffairsManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1).max(256),
  workflowId: z.string().min(1).max(256),
  profileId: z.string().min(1),
  manifestVersion: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  timeWindow: CurrentAffairsTimeWindowSchema,
  sources: z.array(CurrentAffairsSourceRecordSchema).min(1).max(500),
  facts: z.array(FactLayerSchema).optional(),
  stances: z.array(StanceLayerSchema).optional(),
  interpretations: z.array(InterpretationLayerSchema).optional(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
}).superRefine((data, ctx) => {
  // Unique source IDs
  const srcIds = new Set<string>();
  for (const s of data.sources) {
    if (srcIds.has(s.sourceId)) ctx.addIssue({ code: 'custom', message: `Duplicate source: ${s.sourceId}`, path: ['sources'] });
    srcIds.add(s.sourceId);
  }
  // Unique claim IDs
  const claimIds = new Set<string>();
  for (const f of data.facts ?? []) {
    if (claimIds.has(f.claimId)) ctx.addIssue({ code: 'custom', message: `Duplicate claim: ${f.claimId}`, path: ['facts'] });
    claimIds.add(f.claimId);
  }
  for (const s of data.stances ?? []) {
    if (claimIds.has(s.claimId)) ctx.addIssue({ code: 'custom', message: `Duplicate claim: ${s.claimId}`, path: ['stances'] });
    claimIds.add(s.claimId);
  }
  // Fact evidence must reference known sources
  for (const f of data.facts ?? []) {
    for (const eid of f.evidenceSourceIds) {
      if (!srcIds.has(eid)) ctx.addIssue({ code: 'custom', message: `Fact ${f.claimId} references unknown source ${eid}`, path: ['facts'] });
    }
  }
  // Stance source must reference known sources
  for (const s of data.stances ?? []) {
    if (!srcIds.has(s.sourceId)) ctx.addIssue({ code: 'custom', message: `Stance ${s.claimId} references unknown source ${s.sourceId}`, path: ['stances'] });
  }
  // Timestamp coherence
  if (data.createdAt > data.updatedAt) {
    ctx.addIssue({ code: 'custom', message: 'createdAt must be <= updatedAt', path: ['createdAt'] });
  }
});
export type CurrentAffairsManifest = z.infer<typeof CurrentAffairsManifestSchema>;

export function isExpired(window: CurrentAffairsTimeWindow, now: number): boolean {
  if (window.timeSensitive && window.applicabilityEnd && now > window.applicabilityEnd) return true;
  if (window.publishedAt) {
    const ageMs = now - window.publishedAt;
    const maxAgeMs = window.maxSourceAgeDays * 86400000;
    if (ageMs > maxAgeMs) return true;
  }
  return false;
}

export function isFutureSource(source: CurrentAffairsSourceRecord, now: number): boolean {
  if (source.publishedAt && source.publishedAt > now) return true;
  if (source.effectiveAt && source.effectiveAt > now) return true;
  return false;
}

export function needsCorrectionReview(source: CurrentAffairsSourceRecord): boolean {
  return source.correctionState === 'correction_pending' || source.correctionState === 'retracted';
}
