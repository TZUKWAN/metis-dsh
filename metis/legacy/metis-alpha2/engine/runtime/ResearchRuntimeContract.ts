import { z } from 'zod';
import {
  ARTIFACT_TYPES,
  REVIEW_STATUSES,
} from '../artifacts/ArtifactManifest.js';
import type {
  AnchorType,
  ArtifactReviewStatus,
  ArtifactType,
  ClaimEvidenceRelation,
  ClaimStatus,
  ClaimType,
  IdentifierType,
  NoteCodeAcceptance,
  NoteCodeAuthor,
  ResearchDecisionKind,
  ResearchDecisionOrigin,
  ResearchRunStatus,
  SourceKind,
} from '../persistence/researchModel.js';
import type { ResearchLifecycle } from '../core/types.js';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';
import {
  RESEARCH_MEDIA_LIMITS,
  ResearchMediaReferenceSchema,
} from './ResearchMediaRuntimeContract.js';
import {
  DeliverableApprovalStageSchema,
  DeliverableProfileBindingSchema,
} from '../writing/DeliverableProfile.js';
import {
  DeliverableContextSchema,
  DeliverableRuleKindSchema,
  DeliverableSourceKindSchema,
} from '../writing/ProfileEnforcer.js';
import { CitationTruthRequestSchema } from '../writing/CitationTruthReceipt.js';

/**
 * Renderer-facing research contracts.
 *
 * These schemas deliberately expose presentation data rather than persistence
 * records. In particular, normal renderer DTOs never contain local file paths,
 * raw metadata/provenance, provider/model prompts, code references, manifests,
 * checkpoint output, or decision before/after snapshots.
 */

export const RESEARCH_RUNTIME_LIMITS = Object.freeze({
  titleChars: 512,
  labelChars: 512,
  shortTextChars: 2_000,
  longTextChars: 200_000,
  snippetChars: 100_000,
  artifactContentChars: 1_000_000,
  urlChars: 8_192,
  hashChars: 256,
  authors: 128,
  tags: 128,
  tagChars: 128,
  entities: 5_000,
  links: 20_000,
  artifactVersions: 1_000,
  runs: 1_000,
  checkpoints: 10_000,
  decisions: 10_000,
  stepIds: 2_000,
  artifactInputs: 2_000,
  citedSources: 5_000,
  reviewReasonChars: 8_000,
  pageNumber: 10_000_000,
  anchorOffset: Number.MAX_SAFE_INTEGER,
  version: 1_000_000_000,
  listLimit: 500,
  listOffset: 10_000_000,
} as const);

// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const URL_PREFIX = /^https?:\/\//iu;
const LOCAL_PATH_OR_FILE_URL = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|etc|opt|srv|mnt|Volumes)(?:[\\/]|$)|file:)/iu;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const parsed = schema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function boundedSingleLineText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_SINGLE_LINE_CONTROLS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function boundedMultilineText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_MULTILINE_CONTROLS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeLegacyHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > RESEARCH_RUNTIME_LIMITS.urlChars) return null;
  return normalizeHttpUrl(value.trim()) ?? null;
}

function safeLegacyIdentifier(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!URL_PREFIX.test(trimmed)) return trimmed;
  return normalizeHttpUrl(trimmed) ?? '';
}

function isArrayValue(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function nullableLegacyField(record: Record<string, unknown>, key: string): unknown {
  const value = readField(record, key);
  return value === undefined ? null : value;
}

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const NullableTimestampSchema = TimestampSchema.nullable();
const VersionSchema = z.number().int().min(1).max(RESEARCH_RUNTIME_LIMITS.version);
const NullableVersionSchema = VersionSchema.nullable();
const ConfidenceSchema = z.number().finite().min(0).max(1);
const AnchorOffsetSchema = z.number().int().min(0).max(RESEARCH_RUNTIME_LIMITS.anchorOffset);
const NullableAnchorOffsetSchema = AnchorOffsetSchema.nullable();
const PageNumberSchema = z.number().int().min(1).max(RESEARCH_RUNTIME_LIMITS.pageNumber);
const NullablePageNumberSchema = PageNumberSchema.nullable();

export const ResearchLifecycleSchema = z.enum([
  'draft',
  'clarified',
  'planned',
  'approved',
  'running',
  'reviewing',
  'completed',
  'archived',
] satisfies readonly ResearchLifecycle[]);

export const ResearchSourceKindSchema = z.enum([
  'paper',
  'book',
  'pdf',
  'web',
  'archive',
  'image',
  'audio',
  'data',
  'other',
] satisfies readonly SourceKind[]);

export const ResearchIdentifierTypeSchema = z.enum([
  'doi',
  'arxiv',
  'isbn',
  'url',
  'other',
] satisfies readonly IdentifierType[]);

export const ResearchAnchorTypeSchema = z.enum([
  'page',
  'char_range',
  'timestamp',
  'region',
  'row',
  'none',
] satisfies readonly AnchorType[]);

export const ResearchNoteCodeAuthorSchema = z.enum([
  'human',
  'ai',
] satisfies readonly NoteCodeAuthor[]);

export const ResearchNoteCodeAcceptanceSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
] satisfies readonly NoteCodeAcceptance[]);

export const ResearchClaimTypeSchema = z.enum([
  'assertion',
  'hypothesis',
  'finding',
  'limitation',
] satisfies readonly ClaimType[]);

export const ResearchClaimStatusSchema = z.enum([
  'unsupported',
  'supported',
  'contested',
  'refuted',
] satisfies readonly ClaimStatus[]);

export const ResearchClaimEvidenceRelationSchema = z.enum([
  'supports',
  'contradicts',
  'qualifies',
] satisfies readonly ClaimEvidenceRelation[]);

export const ResearchArtifactTypeSchema = z.enum(
  ARTIFACT_TYPES as unknown as [ArtifactType, ...ArtifactType[]],
);

export const ResearchArtifactReviewStatusSchema = z.enum(
  REVIEW_STATUSES as unknown as [ArtifactReviewStatus, ...ArtifactReviewStatus[]],
);

export const ResearchRunStatusSchema = z.enum([
  'draft',
  'awaiting_approval',
  'running',
  'paused',
  'failed',
  'cancelled',
  'reviewing',
  'completed',
] satisfies readonly ResearchRunStatus[]);

export const ResearchDecisionKindSchema = z.enum([
  'accept',
  'edit',
  'reject',
  'undo',
] satisfies readonly ResearchDecisionKind[]);

export const ResearchDecisionOriginSchema = z.enum([
  'human',
  'ai',
  'system',
] satisfies readonly ResearchDecisionOrigin[]);

export const ResearchArtifactVersionAuthorSchema = z.enum([
  'user',
  'ai',
  'system',
]);

export const ResearchDecisionTargetKindSchema = z.enum([
  'project',
  'source',
  'evidence',
  'note_code',
  'claim',
  'artifact',
  'plan',
]);

export const ResearchEntityKindSchema = z.enum([
  'project',
  'source',
  'evidence',
  'note_code',
  'claim',
  'artifact',
]);

export const ResearchDisplayTitleSchema = boundedSingleLineText(
  RESEARCH_RUNTIME_LIMITS.titleChars,
)
  .trim()
  .min(1)
  .refine((value) => !LOCAL_PATH_OR_FILE_URL.test(value), {
    message: 'Display title cannot be a local path',
  });

export const ResearchLabelSchema = boundedSingleLineText(
  RESEARCH_RUNTIME_LIMITS.labelChars,
).trim();

export const ResearchShortTextSchema = boundedSingleLineText(
  RESEARCH_RUNTIME_LIMITS.shortTextChars,
);

export const ResearchLongTextSchema = boundedMultilineText(
  RESEARCH_RUNTIME_LIMITS.longTextChars,
);

export const ResearchHashSchema = boundedSingleLineText(
  RESEARCH_RUNTIME_LIMITS.hashChars,
)
  .regex(/^[A-Za-z0-9._:-]*$/u);

export const ResearchRequiredHashSchema = ResearchHashSchema.refine(
  (value) => value.length > 0,
  { message: 'Hash cannot be empty' },
);

export const ResearchExternalUrlSchema = boundedSingleLineText(
  RESEARCH_RUNTIME_LIMITS.urlChars,
)
  .trim()
  .transform((value, context) => {
    const normalized = normalizeHttpUrl(value);
    if (normalized === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'External URL is unavailable',
      });
      return '';
    }
    return normalized;
  });

export const ResearchIdentifierSchema = boundedSingleLineText(
  RESEARCH_RUNTIME_LIMITS.urlChars,
)
  .trim()
  .transform((value, context) => {
    if (!URL_PREFIX.test(value)) return value;
    const normalized = normalizeHttpUrl(value);
    if (normalized === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'URL identifier is unavailable',
      });
      return '';
    }
    return normalized;
  });

/** Opaque renderer reference. Local paths and file/http URLs are rejected. */
export const ResearchContentRefSchema = RuntimeIdSchema.refine(
  (value) => !LOCAL_PATH_OR_FILE_URL.test(value)
    && !/^(?:file|https?):/iu.test(value)
    && !/^[A-Za-z]:/u.test(value),
  { message: 'Content reference cannot be a path or URL' },
);

const AuthorSchema = boundedSingleLineText(RESEARCH_RUNTIME_LIMITS.labelChars)
  .trim()
  .min(1);
const TagSchema = boundedSingleLineText(RESEARCH_RUNTIME_LIMITS.tagChars)
  .trim()
  .min(1);

function uniqueStringArray(item: z.ZodType<string>, maximum: number) {
  return z.array(item).max(maximum).superRefine((items, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const normalized = items[index]?.toLocaleLowerCase();
      if (normalized !== undefined && seen.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: 'Values must be unique',
          path: [index],
        });
      }
      if (normalized !== undefined) seen.add(normalized);
    }
  });
}

const AuthorsSchema = uniqueStringArray(AuthorSchema, RESEARCH_RUNTIME_LIMITS.authors);
const TagsSchema = uniqueStringArray(TagSchema, RESEARCH_RUNTIME_LIMITS.tags);

function addTemporalIssues(
  value: {
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
  },
  context: z.RefinementCtx,
): void {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Update time cannot predate creation',
      path: ['updatedAt'],
    });
  }
  if (value.deletedAt !== null && value.deletedAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Deletion time cannot predate creation',
      path: ['deletedAt'],
    });
  }
}

export const ResearchProjectDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  title: ResearchDisplayTitleSchema,
  originalIntent: ResearchLongTextSchema,
  researchQuestion: ResearchLongTextSchema,
  lifecycle: ResearchLifecycleSchema,
  methodology: ResearchLongTextSchema,
  discipline: ResearchLabelSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: NullableTimestampSchema,
  version: VersionSchema,
  deletedAt: NullableTimestampSchema,
}).superRefine((value, context) => {
  addTemporalIssues(value, context);
  if (value.archivedAt !== null && value.archivedAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Archive time cannot predate creation',
      path: ['archivedAt'],
    });
  }
});

const ResearchSourceDtoBaseSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  libraryPaperId: RuntimeIdSchema.nullable().optional(),
  kind: ResearchSourceKindSchema,
  title: ResearchDisplayTitleSchema,
  authors: AuthorsSchema,
  year: z.number().int().min(-10_000).max(3_000).nullable(),
  venue: ResearchLabelSchema,
  identifier: ResearchIdentifierSchema,
  identifierType: ResearchIdentifierTypeSchema,
  externalUrl: ResearchExternalUrlSchema.nullable(),
  tags: TagsSchema,
  deliverableSourceKind: DeliverableSourceKindSchema.nullable(),
  deliverableRuleKind: DeliverableRuleKindSchema.nullable(),
  sourceVersionHash: ResearchHashSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: NullableTimestampSchema,
});

export const ResearchSourceDtoSchema = ResearchSourceDtoBaseSchema.superRefine(
  (value, context) => {
    addTemporalIssues(value, context);
    if (
      value.identifierType === 'url'
      && value.identifier.length > 0
      && normalizeHttpUrl(value.identifier) === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'URL identifiers must be credential-free HTTP(S) URLs',
        path: ['identifier'],
      });
    }
  },
);

export const ResearchEvidenceDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  sourceId: RuntimeIdSchema,
  anchorType: ResearchAnchorTypeSchema,
  anchorStart: NullableAnchorOffsetSchema,
  anchorEnd: NullableAnchorOffsetSchema,
  pageNumber: NullablePageNumberSchema,
  snippet: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.snippetChars),
  snippetHash: ResearchHashSchema,
  sourceVersionHash: ResearchHashSchema.nullable(),
  confidence: ConfidenceSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: NullableTimestampSchema,
}).superRefine((value, context) => {
  addTemporalIssues(value, context);
  if (
    value.anchorStart !== null
    && value.anchorEnd !== null
    && value.anchorEnd < value.anchorStart
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Anchor end cannot predate anchor start',
      path: ['anchorEnd'],
    });
  }
});

export const ResearchNoteCodeDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  evidenceId: RuntimeIdSchema.nullable(),
  code: ResearchLabelSchema,
  content: ResearchLongTextSchema,
  author: ResearchNoteCodeAuthorSchema,
  confidence: ConfidenceSchema,
  accepted: ResearchNoteCodeAcceptanceSchema,
  tags: TagsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: NullableTimestampSchema,
}).superRefine((value, context) => addTemporalIssues(value, context));

export const ResearchClaimDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  statement: ResearchLongTextSchema,
  claimType: ResearchClaimTypeSchema,
  confidence: ConfidenceSchema,
  status: ResearchClaimStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: NullableTimestampSchema,
}).superRefine((value, context) => addTemporalIssues(value, context));

export const ResearchArtifactDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  title: ResearchDisplayTitleSchema,
  artifactType: ResearchArtifactTypeSchema,
  reviewStatus: ResearchArtifactReviewStatusSchema,
  contentRef: ResearchContentRefSchema.nullable(),
  inputHash: ResearchHashSchema.nullable(),
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: NullableTimestampSchema,
}).superRefine((value, context) => addTemporalIssues(value, context));

export type ResearchProjectDto = z.infer<typeof ResearchProjectDtoSchema>;
export type ResearchSourceDto = z.infer<typeof ResearchSourceDtoSchema>;
export type ResearchEvidenceDto = z.infer<typeof ResearchEvidenceDtoSchema>;
export type ResearchNoteCodeDto = z.infer<typeof ResearchNoteCodeDtoSchema>;
export type ResearchClaimDto = z.infer<typeof ResearchClaimDtoSchema>;
export type ResearchArtifactDto = z.infer<typeof ResearchArtifactDtoSchema>;

export const ResearchClaimEvidenceLinkDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  claimId: RuntimeIdSchema,
  evidenceId: RuntimeIdSchema,
  relation: ResearchClaimEvidenceRelationSchema,
  weight: ConfidenceSchema,
  note: ResearchLongTextSchema,
  createdAt: TimestampSchema,
});

export const ResearchArtifactVersionDtoSchema = z.strictObject({
  artifactId: RuntimeIdSchema,
  version: VersionSchema,
  contentHash: ResearchHashSchema,
  createdAt: TimestampSchema,
  createdBy: ResearchArtifactVersionAuthorSchema,
  branchFromVersion: NullableVersionSchema,
});

export const ResearchRunDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  status: ResearchRunStatusSchema,
  currentStepId: RuntimeIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: NullableTimestampSchema,
  deletedAt: NullableTimestampSchema,
}).superRefine((value, context) => {
  addTemporalIssues(value, context);
  if (value.completedAt !== null && value.completedAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Completion time cannot predate creation',
      path: ['completedAt'],
    });
  }
});

const StepIdListSchema = uniqueStringArray(
  RuntimeIdSchema,
  RESEARCH_RUNTIME_LIMITS.stepIds,
);

export const ResearchCheckpointDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
  stepId: RuntimeIdSchema,
  lifecycle: ResearchLifecycleSchema,
  inputHash: ResearchHashSchema,
  outputHash: ResearchHashSchema.nullable(),
  completedSteps: StepIdListSchema,
  decisions: StepIdListSchema,
  pendingSteps: StepIdListSchema,
  runtimeProfileVersion: ResearchHashSchema,
  errorCategory: ResearchLabelSchema.nullable(),
  recoveryStrategy: ResearchLabelSchema.nullable(),
  createdAt: TimestampSchema,
});

export const ResearchDecisionDtoSchema = z.strictObject({
  id: RuntimeIdSchema,
  projectId: RuntimeIdSchema,
  runId: RuntimeIdSchema.nullable(),
  targetKind: ResearchDecisionTargetKindSchema,
  targetId: RuntimeIdSchema,
  decision: ResearchDecisionKindSchema,
  origin: ResearchDecisionOriginSchema,
  note: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.reviewReasonChars),
  createdAt: TimestampSchema,
  undoneAt: NullableTimestampSchema,
}).superRefine((value, context) => {
  if (value.undoneAt !== null && value.undoneAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Undo time cannot predate decision creation',
      path: ['undoneAt'],
    });
  }
});

export type ResearchClaimEvidenceLinkDto = z.infer<typeof ResearchClaimEvidenceLinkDtoSchema>;
export type ResearchArtifactVersionDto = z.infer<typeof ResearchArtifactVersionDtoSchema>;
export type ResearchRunDto = z.infer<typeof ResearchRunDtoSchema>;
export type ResearchCheckpointDto = z.infer<typeof ResearchCheckpointDtoSchema>;
export type ResearchDecisionDto = z.infer<typeof ResearchDecisionDtoSchema>;

export const ResearchEntityEnvelopeSchema = z.discriminatedUnion('entityKind', [
  z.strictObject({ entityKind: z.literal('project'), value: ResearchProjectDtoSchema }),
  z.strictObject({ entityKind: z.literal('source'), value: ResearchSourceDtoSchema }),
  z.strictObject({ entityKind: z.literal('evidence'), value: ResearchEvidenceDtoSchema }),
  z.strictObject({ entityKind: z.literal('note_code'), value: ResearchNoteCodeDtoSchema }),
  z.strictObject({ entityKind: z.literal('claim'), value: ResearchClaimDtoSchema }),
  z.strictObject({ entityKind: z.literal('artifact'), value: ResearchArtifactDtoSchema }),
]);

export type ResearchEntityEnvelope = z.infer<typeof ResearchEntityEnvelopeSchema>;

export const ProjectSnapshotRuntimeSchema = z.strictObject({
  project: ResearchProjectDtoSchema,
  sources: z.array(ResearchSourceDtoSchema).max(RESEARCH_RUNTIME_LIMITS.entities),
  evidence: z.array(ResearchEvidenceDtoSchema).max(RESEARCH_RUNTIME_LIMITS.entities),
  noteCodes: z.array(ResearchNoteCodeDtoSchema).max(RESEARCH_RUNTIME_LIMITS.entities),
  claims: z.array(ResearchClaimDtoSchema).max(RESEARCH_RUNTIME_LIMITS.entities),
  claimEvidenceLinks: z.array(ResearchClaimEvidenceLinkDtoSchema)
    .max(RESEARCH_RUNTIME_LIMITS.links),
  artifacts: z.array(ResearchArtifactDtoSchema).max(RESEARCH_RUNTIME_LIMITS.entities),
  artifactVersions: z.array(ResearchArtifactVersionDtoSchema)
    .max(RESEARCH_RUNTIME_LIMITS.artifactVersions),
  runs: z.array(ResearchRunDtoSchema).max(RESEARCH_RUNTIME_LIMITS.runs),
  checkpoints: z.array(ResearchCheckpointDtoSchema)
    .max(RESEARCH_RUNTIME_LIMITS.checkpoints),
  decisions: z.array(ResearchDecisionDtoSchema).max(RESEARCH_RUNTIME_LIMITS.decisions),
  capturedAt: TimestampSchema,
}).superRefine((snapshot, context) => {
  const projectId = snapshot.project.id;
  const sourceIds = new Set(snapshot.sources.map((item) => item.id));
  const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
  const noteCodeIds = new Set(snapshot.noteCodes.map((item) => item.id));
  const claimIds = new Set(snapshot.claims.map((item) => item.id));
  const artifactIds = new Set(snapshot.artifacts.map((item) => item.id));
  const runIds = new Set(snapshot.runs.map((item) => item.id));

  const scopedCollections: Array<{
    path: string;
    items: Array<{ projectId: string }>;
  }> = [
    { path: 'sources', items: snapshot.sources },
    { path: 'evidence', items: snapshot.evidence },
    { path: 'noteCodes', items: snapshot.noteCodes },
    { path: 'claims', items: snapshot.claims },
    { path: 'artifacts', items: snapshot.artifacts },
    { path: 'runs', items: snapshot.runs },
    { path: 'checkpoints', items: snapshot.checkpoints },
    { path: 'decisions', items: snapshot.decisions },
  ];
  for (const collection of scopedCollections) {
    collection.items.forEach((item, index) => {
      if (item.projectId !== projectId) {
        context.addIssue({
          code: 'custom',
          message: 'Snapshot item belongs to another project',
          path: [collection.path, index, 'projectId'],
        });
      }
    });
  }

  snapshot.evidence.forEach((item, index) => {
    if (!sourceIds.has(item.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence source is unavailable in the snapshot',
        path: ['evidence', index, 'sourceId'],
      });
    }
  });
  snapshot.noteCodes.forEach((item, index) => {
    if (item.evidenceId !== null && !evidenceIds.has(item.evidenceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Note-code evidence is unavailable in the snapshot',
        path: ['noteCodes', index, 'evidenceId'],
      });
    }
  });
  snapshot.claimEvidenceLinks.forEach((item, index) => {
    if (!claimIds.has(item.claimId)) {
      context.addIssue({
        code: 'custom',
        message: 'Link claim is unavailable in the snapshot',
        path: ['claimEvidenceLinks', index, 'claimId'],
      });
    }
    if (!evidenceIds.has(item.evidenceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Link evidence is unavailable in the snapshot',
        path: ['claimEvidenceLinks', index, 'evidenceId'],
      });
    }
  });
  snapshot.artifactVersions.forEach((item, index) => {
    if (!artifactIds.has(item.artifactId)) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact version parent is unavailable in the snapshot',
        path: ['artifactVersions', index, 'artifactId'],
      });
    }
  });
  snapshot.checkpoints.forEach((item, index) => {
    if (!runIds.has(item.runId)) {
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint run is unavailable in the snapshot',
        path: ['checkpoints', index, 'runId'],
      });
    }
  });
  snapshot.decisions.forEach((item, index) => {
    if (item.runId !== null && !runIds.has(item.runId)) {
      context.addIssue({
        code: 'custom',
        message: 'Decision run is unavailable in the snapshot',
        path: ['decisions', index, 'runId'],
      });
    }
    const targetExists = item.targetKind === 'project'
      ? item.targetId === projectId
      : item.targetKind === 'source'
        ? sourceIds.has(item.targetId)
        : item.targetKind === 'evidence'
          ? evidenceIds.has(item.targetId)
          : item.targetKind === 'note_code'
            ? noteCodeIds.has(item.targetId)
            : item.targetKind === 'claim'
              ? claimIds.has(item.targetId)
              : item.targetKind === 'artifact'
                ? artifactIds.has(item.targetId)
                : true;
    if (!targetExists) {
      context.addIssue({
        code: 'custom',
        message: 'Decision target is unavailable in the snapshot',
        path: ['decisions', index, 'targetId'],
      });
    }
  });
  if (snapshot.capturedAt < snapshot.project.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'Snapshot capture time cannot predate project creation',
      path: ['capturedAt'],
    });
  }
});

export type ProjectSnapshotRuntime = z.infer<typeof ProjectSnapshotRuntimeSchema>;
export const ResearchProjectSnapshotSchema = ProjectSnapshotRuntimeSchema;
export type ResearchProjectSnapshot = ProjectSnapshotRuntime;

// ─── Renderer-safe writable fields ───────────────────────────

function nonEmptyPatch(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

const ResearchProjectCreateValueSchema = z.strictObject({
  title: ResearchDisplayTitleSchema,
  originalIntent: ResearchLongTextSchema.default(''),
  researchQuestion: ResearchLongTextSchema.default(''),
  lifecycle: ResearchLifecycleSchema.default('draft'),
  methodology: ResearchLongTextSchema.default(''),
  discipline: ResearchLabelSchema.default(''),
});

const ResearchProjectPatchSchema = z.strictObject({
  title: ResearchDisplayTitleSchema.optional(),
  originalIntent: ResearchLongTextSchema.optional(),
  researchQuestion: ResearchLongTextSchema.optional(),
  lifecycle: ResearchLifecycleSchema.optional(),
  methodology: ResearchLongTextSchema.optional(),
  discipline: ResearchLabelSchema.optional(),
}).refine(nonEmptyPatch, { message: 'Project patch cannot be empty' });

const ResearchSourceCreateValueSchema = z.strictObject({
  id: RuntimeIdSchema,
  kind: ResearchSourceKindSchema,
  title: ResearchDisplayTitleSchema,
  authors: AuthorsSchema.default([]),
  year: z.number().int().min(-10_000).max(3_000).nullable().default(null),
  venue: ResearchLabelSchema.default(''),
  identifier: ResearchIdentifierSchema.default(''),
  identifierType: ResearchIdentifierTypeSchema.default('other'),
  externalUrl: ResearchExternalUrlSchema.nullable().default(null),
  tags: TagsSchema.default([]),
  deliverableSourceKind: DeliverableSourceKindSchema.nullable().default(null),
  deliverableRuleKind: DeliverableRuleKindSchema.nullable().default(null),
  sourceVersionHash: ResearchHashSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (
    value.identifierType === 'url'
    && value.identifier.length > 0
    && normalizeHttpUrl(value.identifier) === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'URL identifiers must be credential-free HTTP(S) URLs',
      path: ['identifier'],
    });
  }
});

const ResearchSourcePatchSchema = z.strictObject({
  kind: ResearchSourceKindSchema.optional(),
  title: ResearchDisplayTitleSchema.optional(),
  authors: AuthorsSchema.optional(),
  year: z.number().int().min(-10_000).max(3_000).nullable().optional(),
  venue: ResearchLabelSchema.optional(),
  identifier: ResearchIdentifierSchema.optional(),
  identifierType: ResearchIdentifierTypeSchema.optional(),
  externalUrl: ResearchExternalUrlSchema.nullable().optional(),
  tags: TagsSchema.optional(),
  deliverableSourceKind: DeliverableSourceKindSchema.nullable().optional(),
  deliverableRuleKind: DeliverableRuleKindSchema.nullable().optional(),
  sourceVersionHash: ResearchHashSchema.nullable().optional(),
}).refine(nonEmptyPatch, { message: 'Source patch cannot be empty' });

const ResearchEvidenceCreateValueSchema = z.strictObject({
  id: RuntimeIdSchema,
  sourceId: RuntimeIdSchema,
  anchorType: ResearchAnchorTypeSchema,
  anchorStart: NullableAnchorOffsetSchema.default(null),
  anchorEnd: NullableAnchorOffsetSchema.default(null),
  pageNumber: NullablePageNumberSchema.default(null),
  snippet: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.snippetChars),
  snippetHash: ResearchRequiredHashSchema,
  sourceVersionHash: ResearchHashSchema.nullable().default(null),
  confidence: ConfidenceSchema,
}).superRefine((value, context) => {
  if (
    value.anchorStart !== null
    && value.anchorEnd !== null
    && value.anchorEnd < value.anchorStart
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Anchor end cannot predate anchor start',
      path: ['anchorEnd'],
    });
  }
});

const ResearchEvidencePatchSchema = z.strictObject({
  sourceId: RuntimeIdSchema.optional(),
  anchorType: ResearchAnchorTypeSchema.optional(),
  anchorStart: NullableAnchorOffsetSchema.optional(),
  anchorEnd: NullableAnchorOffsetSchema.optional(),
  pageNumber: NullablePageNumberSchema.optional(),
  snippet: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.snippetChars).optional(),
  snippetHash: ResearchRequiredHashSchema.optional(),
  sourceVersionHash: ResearchHashSchema.nullable().optional(),
  confidence: ConfidenceSchema.optional(),
}).refine(nonEmptyPatch, { message: 'Evidence patch cannot be empty' })
  .superRefine((value, context) => {
    if (
      value.anchorStart !== undefined
      && value.anchorStart !== null
      && value.anchorEnd !== undefined
      && value.anchorEnd !== null
      && value.anchorEnd < value.anchorStart
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Anchor end cannot predate anchor start',
        path: ['anchorEnd'],
      });
    }
  });

const ResearchNoteCodeCreateValueSchema = z.strictObject({
  id: RuntimeIdSchema,
  evidenceId: RuntimeIdSchema.nullable().default(null),
  code: ResearchLabelSchema,
  content: ResearchLongTextSchema,
  author: ResearchNoteCodeAuthorSchema,
  confidence: ConfidenceSchema,
  accepted: ResearchNoteCodeAcceptanceSchema.default('pending'),
  tags: TagsSchema.default([]),
});

const ResearchNoteCodePatchSchema = z.strictObject({
  evidenceId: RuntimeIdSchema.nullable().optional(),
  code: ResearchLabelSchema.optional(),
  content: ResearchLongTextSchema.optional(),
  author: ResearchNoteCodeAuthorSchema.optional(),
  confidence: ConfidenceSchema.optional(),
  accepted: ResearchNoteCodeAcceptanceSchema.optional(),
  tags: TagsSchema.optional(),
}).refine(nonEmptyPatch, { message: 'Note-code patch cannot be empty' });

const ResearchClaimCreateValueSchema = z.strictObject({
  id: RuntimeIdSchema,
  statement: ResearchLongTextSchema,
  claimType: ResearchClaimTypeSchema,
  confidence: ConfidenceSchema,
  status: ResearchClaimStatusSchema.default('unsupported'),
});

const ResearchClaimPatchSchema = z.strictObject({
  statement: ResearchLongTextSchema.optional(),
  claimType: ResearchClaimTypeSchema.optional(),
  confidence: ConfidenceSchema.optional(),
  status: ResearchClaimStatusSchema.optional(),
}).refine(nonEmptyPatch, { message: 'Claim patch cannot be empty' });

const ResearchArtifactCreateValueSchema = z.strictObject({
  id: RuntimeIdSchema,
  title: ResearchDisplayTitleSchema,
  artifactType: ResearchArtifactTypeSchema,
  reviewStatus: ResearchArtifactReviewStatusSchema.default('draft'),
  contentRef: ResearchContentRefSchema.nullable().default(null),
  inputHash: ResearchRequiredHashSchema.nullable().default(null),
});

const ResearchArtifactPatchSchema = z.strictObject({
  title: ResearchDisplayTitleSchema.optional(),
  artifactType: ResearchArtifactTypeSchema.optional(),
  contentRef: ResearchContentRefSchema.nullable().optional(),
  inputHash: ResearchRequiredHashSchema.nullable().optional(),
}).refine(nonEmptyPatch, { message: 'Artifact patch cannot be empty' });

const CreateProjectRequestSchema = z.strictObject({
  operation: z.literal('create'),
  entityKind: z.literal('project'),
  projectId: RuntimeIdSchema,
  value: ResearchProjectCreateValueSchema,
});

const CreateSourceRequestSchema = z.strictObject({
  operation: z.literal('create'),
  entityKind: z.literal('source'),
  projectId: RuntimeIdSchema,
  value: ResearchSourceCreateValueSchema,
});

const CreateEvidenceRequestSchema = z.strictObject({
  operation: z.literal('create'),
  entityKind: z.literal('evidence'),
  projectId: RuntimeIdSchema,
  value: ResearchEvidenceCreateValueSchema,
});

const CreateNoteCodeRequestSchema = z.strictObject({
  operation: z.literal('create'),
  entityKind: z.literal('note_code'),
  projectId: RuntimeIdSchema,
  value: ResearchNoteCodeCreateValueSchema,
});

const CreateClaimRequestSchema = z.strictObject({
  operation: z.literal('create'),
  entityKind: z.literal('claim'),
  projectId: RuntimeIdSchema,
  value: ResearchClaimCreateValueSchema,
});

const CreateArtifactRequestSchema = z.strictObject({
  operation: z.literal('create'),
  entityKind: z.literal('artifact'),
  projectId: RuntimeIdSchema,
  value: ResearchArtifactCreateValueSchema,
});

export const ResearchCreateRequestSchema = z.discriminatedUnion('entityKind', [
  CreateProjectRequestSchema,
  CreateSourceRequestSchema,
  CreateEvidenceRequestSchema,
  CreateNoteCodeRequestSchema,
  CreateClaimRequestSchema,
  CreateArtifactRequestSchema,
]);

export const ResearchGetRequestSchema = z.strictObject({
  operation: z.literal('get'),
  entityKind: ResearchEntityKindSchema,
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  includeDeleted: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.entityKind === 'project' && value.entityId !== value.projectId) {
    context.addIssue({
      code: 'custom',
      message: 'Project entity ID must match project scope',
      path: ['entityId'],
    });
  }
});

const CommonListRequestShape = {
  operation: z.literal('list'),
  projectId: RuntimeIdSchema,
  includeDeleted: z.boolean().default(false),
  limit: z.number().int().min(1).max(RESEARCH_RUNTIME_LIMITS.listLimit).default(100),
  offset: z.number().int().min(0).max(RESEARCH_RUNTIME_LIMITS.listOffset).default(0),
};

export const ResearchListRequestSchema = z.discriminatedUnion('entityKind', [
  z.strictObject({ ...CommonListRequestShape, entityKind: z.literal('project') }),
  z.strictObject({ ...CommonListRequestShape, entityKind: z.literal('source') }),
  z.strictObject({
    ...CommonListRequestShape,
    entityKind: z.literal('evidence'),
    sourceId: RuntimeIdSchema.optional(),
  }),
  z.strictObject({
    ...CommonListRequestShape,
    entityKind: z.literal('note_code'),
    evidenceId: RuntimeIdSchema.optional(),
    acceptance: ResearchNoteCodeAcceptanceSchema.optional(),
  }),
  z.strictObject({ ...CommonListRequestShape, entityKind: z.literal('claim') }),
  z.strictObject({ ...CommonListRequestShape, entityKind: z.literal('artifact') }),
]);

const UpdateProjectRequestSchema = z.strictObject({
  operation: z.literal('update'),
  entityKind: z.literal('project'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  patch: ResearchProjectPatchSchema,
});

const UpdateSourceRequestSchema = z.strictObject({
  operation: z.literal('update'),
  entityKind: z.literal('source'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  patch: ResearchSourcePatchSchema,
});

const UpdateEvidenceRequestSchema = z.strictObject({
  operation: z.literal('update'),
  entityKind: z.literal('evidence'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  patch: ResearchEvidencePatchSchema,
});

const UpdateNoteCodeRequestSchema = z.strictObject({
  operation: z.literal('update'),
  entityKind: z.literal('note_code'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  patch: ResearchNoteCodePatchSchema,
});

const UpdateClaimRequestSchema = z.strictObject({
  operation: z.literal('update'),
  entityKind: z.literal('claim'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  patch: ResearchClaimPatchSchema,
});

const UpdateArtifactRequestSchema = z.strictObject({
  operation: z.literal('update'),
  entityKind: z.literal('artifact'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  patch: ResearchArtifactPatchSchema,
});

export const ResearchUpdateRequestSchema = z.discriminatedUnion('entityKind', [
  UpdateProjectRequestSchema,
  UpdateSourceRequestSchema,
  UpdateEvidenceRequestSchema,
  UpdateNoteCodeRequestSchema,
  UpdateClaimRequestSchema,
  UpdateArtifactRequestSchema,
]).superRefine((value, context) => {
  if (value.entityKind === 'project' && value.entityId !== value.projectId) {
    context.addIssue({
      code: 'custom',
      message: 'Project entity ID must match project scope',
      path: ['entityId'],
    });
  }
});

export const ResearchDeleteRequestSchema = z.strictObject({
  operation: z.literal('delete'),
  entityKind: ResearchEntityKindSchema,
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
}).superRefine((value, context) => {
  if (value.entityKind === 'project' && value.entityId !== value.projectId) {
    context.addIssue({
      code: 'custom',
      message: 'Project entity ID must match project scope',
      path: ['entityId'],
    });
  }
});

export const ResearchCrudRequestSchema = z.union([
  ResearchCreateRequestSchema,
  ResearchGetRequestSchema,
  ResearchListRequestSchema,
  ResearchUpdateRequestSchema,
  ResearchDeleteRequestSchema,
]);

export const ResearchSnapshotRequestSchema = z.strictObject({
  operation: z.literal('snapshot'),
  projectId: RuntimeIdSchema,
});

export type ResearchCreateRequest = z.infer<typeof ResearchCreateRequestSchema>;
export type ResearchGetRequest = z.infer<typeof ResearchGetRequestSchema>;
export type ResearchListRequest = z.infer<typeof ResearchListRequestSchema>;
export type ResearchUpdateRequest = z.infer<typeof ResearchUpdateRequestSchema>;
export type ResearchDeleteRequest = z.infer<typeof ResearchDeleteRequestSchema>;
export type ResearchCrudRequest = z.infer<typeof ResearchCrudRequestSchema>;
export type ResearchSnapshotRequest = z.infer<typeof ResearchSnapshotRequestSchema>;

// ─── Link, review, restore, version, checkpoint and decision requests ──

export const ResearchLinkClaimEvidenceRequestSchema = z.strictObject({
  operation: z.literal('link'),
  projectId: RuntimeIdSchema,
  link: z.strictObject({
    id: RuntimeIdSchema,
    claimId: RuntimeIdSchema,
    evidenceId: RuntimeIdSchema,
    relation: ResearchClaimEvidenceRelationSchema,
    weight: ConfidenceSchema,
    note: ResearchLongTextSchema.default(''),
  }),
});

export const ResearchUnlinkClaimEvidenceRequestSchema = z.strictObject({
  operation: z.literal('unlink'),
  projectId: RuntimeIdSchema,
  linkId: RuntimeIdSchema,
});

export const ResearchListClaimEvidenceLinksRequestSchema = z.strictObject({
  operation: z.literal('list_links'),
  projectId: RuntimeIdSchema,
  claimId: RuntimeIdSchema.optional(),
  evidenceId: RuntimeIdSchema.optional(),
});

export const ResearchLinkRequestSchema = z.union([
  ResearchLinkClaimEvidenceRequestSchema,
  ResearchUnlinkClaimEvidenceRequestSchema,
  ResearchListClaimEvidenceLinksRequestSchema,
]);

const ResearchNoteCodeReviewEditsSchema = z.strictObject({
  code: ResearchLabelSchema.optional(),
  content: ResearchLongTextSchema.optional(),
  tags: TagsSchema.optional(),
}).refine(nonEmptyPatch, { message: 'Review edits cannot be empty' });

const ReviewNoteCodeRequestSchema = z.strictObject({
  operation: z.literal('review'),
  reviewKind: z.literal('note_code'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  decision: ResearchNoteCodeAcceptanceSchema,
  edits: ResearchNoteCodeReviewEditsSchema.optional(),
  reason: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.reviewReasonChars).default(''),
});

const ReviewArtifactRequestSchema = z.strictObject({
  operation: z.literal('review'),
  reviewKind: z.literal('artifact'),
  projectId: RuntimeIdSchema,
  entityId: RuntimeIdSchema,
  expectedVersion: VersionSchema,
  toStatus: ResearchArtifactReviewStatusSchema,
  reason: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.reviewReasonChars).trim().min(1),
});

export const ResearchReviewRequestSchema = z.discriminatedUnion('reviewKind', [
  ReviewNoteCodeRequestSchema,
  ReviewArtifactRequestSchema,
]);

export const ResearchRestoreRequestSchema = z.strictObject({
  operation: z.literal('restore'),
  projectId: RuntimeIdSchema,
  entityKind: ResearchEntityKindSchema,
  entityId: RuntimeIdSchema,
}).superRefine((value, context) => {
  if (value.entityKind === 'project' && value.entityId !== value.projectId) {
    context.addIssue({
      code: 'custom',
      message: 'Project entity ID must match project scope',
      path: ['entityId'],
    });
  }
});

export const ResearchArtifactInputSchema = z.strictObject({
  kind: z.enum(['claim', 'evidence', 'source', 'dataset', 'previous_artifact']),
  id: RuntimeIdSchema,
});

export const ResearchArtifactRendererKindSchema = z.enum([
  'text',
  'markdown',
  'vega_lite',
  'image',
  'table_html',
  'pdf',
  'react_component',
]);

const SaveArtifactVersionRequestSchema = z.strictObject({
  operation: z.literal('save_version'),
  projectId: RuntimeIdSchema,
  artifactId: RuntimeIdSchema,
  expectedVersion: VersionSchema.nullable().default(null),
  title: ResearchDisplayTitleSchema,
  artifactType: ResearchArtifactTypeSchema,
  reviewStatus: ResearchArtifactReviewStatusSchema.default('draft'),
  inputs: z.array(ResearchArtifactInputSchema).max(RESEARCH_RUNTIME_LIMITS.artifactInputs)
    .default([]),
  capabilityId: RuntimeIdSchema,
  method: ResearchLabelSchema,
  citedSourceIds: uniqueStringArray(
    RuntimeIdSchema,
    RESEARCH_RUNTIME_LIMITS.citedSources,
  ).default([]),
  deliverableProfile: DeliverableProfileBindingSchema.optional(),
  deliverableContext: DeliverableContextSchema.optional(),
  citationRequests: z.array(CitationTruthRequestSchema.extend({
    sourceId: RuntimeIdSchema,
    locator: ResearchLabelSchema.trim().min(1),
  }))
    .max(RESEARCH_RUNTIME_LIMITS.citedSources)
    .default([]),
  rendererKind: ResearchArtifactRendererKindSchema,
  rendererSpec: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.artifactContentChars).optional(),
  contentRef: ResearchContentRefSchema.nullable().default(null),
  /** Renderer may select managed source ids and author captions/order only. */
  media: z.array(ResearchMediaReferenceSchema)
    .max(RESEARCH_MEDIA_LIMITS.mediaPerArtifact)
    .default([]),
  inputHash: ResearchRequiredHashSchema.nullable().default(null),
  content: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.artifactContentChars),
  createdBy: z.literal('user').default('user'),
  branchFromVersion: NullableVersionSchema.default(null),
}).superRefine((value, context) => {
  if (value.reviewStatus === 'verified' && value.inputs.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'Verified artifacts require at least one recorded input',
      path: ['inputs'],
    });
  }
  if (value.reviewStatus === 'verified' && value.citedSourceIds.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'Verified artifacts require at least one cited source',
      path: ['citedSourceIds'],
    });
  }
  if (value.reviewStatus === 'verified' && !value.deliverableProfile) {
    context.addIssue({
      code: 'custom',
      message: 'Verified artifacts require a versioned deliverable profile',
      path: ['deliverableProfile'],
    });
  }
  if (value.reviewStatus === 'verified' && !value.deliverableContext) {
    context.addIssue({
      code: 'custom',
      message: 'Verified artifacts require structured deliverable context',
      path: ['deliverableContext'],
    });
  }
  if (value.reviewStatus === 'verified') {
    for (const sourceId of value.citedSourceIds) {
      const matching = value.citationRequests.filter((citation) => citation.sourceId === sourceId);
      if (matching.length !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'Every cited source requires exactly one locator request for main-side validation',
          path: ['citationRequests'],
        });
      }
    }
    if (value.citationRequests.some((citation) => !value.citedSourceIds.includes(citation.sourceId))) {
      context.addIssue({
        code: 'custom',
        message: 'Citation locator requests must reference cited sources only',
        path: ['citationRequests'],
      });
    }
  }
});

const GetArtifactVersionRequestSchema = z.strictObject({
  operation: z.literal('get_version'),
  projectId: RuntimeIdSchema,
  artifactId: RuntimeIdSchema,
  version: VersionSchema.optional(),
});

const ListArtifactVersionsRequestSchema = z.strictObject({
  operation: z.literal('list_versions'),
  projectId: RuntimeIdSchema,
  artifactId: RuntimeIdSchema,
  limit: z.number().int().min(1).max(RESEARCH_RUNTIME_LIMITS.listLimit).default(100),
  offset: z.number().int().min(0).max(RESEARCH_RUNTIME_LIMITS.listOffset).default(0),
});

const RestoreArtifactVersionRequestSchema = z.strictObject({
  operation: z.literal('restore_version'),
  projectId: RuntimeIdSchema,
  artifactId: RuntimeIdSchema,
  version: VersionSchema,
  createdBy: z.literal('user').default('user'),
});

export const ResearchArtifactVersionRequestSchema = z.union([
  SaveArtifactVersionRequestSchema,
  GetArtifactVersionRequestSchema,
  ListArtifactVersionsRequestSchema,
  RestoreArtifactVersionRequestSchema,
]);

export const ResearchVersionRequestSchema = ResearchArtifactVersionRequestSchema;

const RecordCheckpointRequestSchema = z.strictObject({
  operation: z.literal('record_checkpoint'),
  projectId: RuntimeIdSchema,
  checkpointId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
  stepId: RuntimeIdSchema,
  lifecycle: ResearchLifecycleSchema,
  inputHash: ResearchRequiredHashSchema,
  outputHash: ResearchRequiredHashSchema.nullable().default(null),
  completedSteps: StepIdListSchema.default([]),
  decisionIds: StepIdListSchema.default([]),
  pendingSteps: StepIdListSchema.default([]),
  runtimeProfileVersion: ResearchRequiredHashSchema,
  outputSummary: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.shortTextChars).default(''),
  errorCategory: ResearchLabelSchema.nullable().default(null),
  recoveryStrategy: ResearchLabelSchema.nullable().default(null),
});

const LatestCheckpointRequestSchema = z.strictObject({
  operation: z.literal('latest_checkpoint'),
  projectId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
});

const ListCheckpointsRequestSchema = z.strictObject({
  operation: z.literal('list_checkpoints'),
  projectId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
  limit: z.number().int().min(1).max(RESEARCH_RUNTIME_LIMITS.listLimit).default(100),
  offset: z.number().int().min(0).max(RESEARCH_RUNTIME_LIMITS.listOffset).default(0),
});

export const ResearchCheckpointRequestSchema = z.union([
  RecordCheckpointRequestSchema,
  LatestCheckpointRequestSchema,
  ListCheckpointsRequestSchema,
]);

const RecordDecisionRequestSchema = z.strictObject({
  operation: z.literal('record_decision'),
  projectId: RuntimeIdSchema,
  decisionId: RuntimeIdSchema,
  runId: RuntimeIdSchema.nullable().default(null),
  targetKind: ResearchDecisionTargetKindSchema,
  targetId: RuntimeIdSchema,
  decision: z.enum(['accept', 'edit', 'reject']),
  approvalStage: DeliverableApprovalStageSchema.optional(),
  note: boundedMultilineText(RESEARCH_RUNTIME_LIMITS.reviewReasonChars).default(''),
}).superRefine((value, context) => {
  if (value.approvalStage !== undefined && (value.targetKind !== 'artifact' || value.decision !== 'accept')) {
    context.addIssue({
      code: 'custom',
      message: 'Deliverable approval stages require an accepted artifact decision',
      path: ['approvalStage'],
    });
  }
});

const UndoDecisionRequestSchema = z.strictObject({
  operation: z.literal('undo_decision'),
  projectId: RuntimeIdSchema,
  decisionId: RuntimeIdSchema,
});

const ListDecisionsRequestSchema = z.strictObject({
  operation: z.literal('list_decisions'),
  projectId: RuntimeIdSchema,
  runId: RuntimeIdSchema.optional(),
  limit: z.number().int().min(1).max(RESEARCH_RUNTIME_LIMITS.listLimit).default(100),
  offset: z.number().int().min(0).max(RESEARCH_RUNTIME_LIMITS.listOffset).default(0),
});

export const ResearchDecisionRequestSchema = z.union([
  RecordDecisionRequestSchema,
  UndoDecisionRequestSchema,
  ListDecisionsRequestSchema,
]);

export type ResearchLinkRequest = z.infer<typeof ResearchLinkRequestSchema>;
export type ResearchReviewRequest = z.infer<typeof ResearchReviewRequestSchema>;
export type ResearchRestoreRequest = z.infer<typeof ResearchRestoreRequestSchema>;
export type ResearchArtifactVersionRequest = z.infer<typeof ResearchArtifactVersionRequestSchema>;
export type ResearchVersionRequest = ResearchArtifactVersionRequest;
export type ResearchCheckpointRequest = z.infer<typeof ResearchCheckpointRequestSchema>;
export type ResearchDecisionRequest = z.infer<typeof ResearchDecisionRequestSchema>;

// ─── Fixed request recovery and renderer result unions ───────

export const ResearchRuntimeRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: z.enum([
    'research_crud_request_unavailable',
    'research_link_request_unavailable',
    'research_review_request_unavailable',
    'research_restore_request_unavailable',
    'research_version_request_unavailable',
    'research_checkpoint_request_unavailable',
    'research_decision_request_unavailable',
    'research_snapshot_request_unavailable',
    'research_record_unavailable',
    'research_snapshot_unavailable',
  ]),
});

export type ResearchRuntimeRecovery = z.infer<typeof ResearchRuntimeRecoverySchema>;

export type ResearchRequestDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: ResearchRuntimeRecovery };

function decodeResearchRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: ResearchRuntimeRecovery['code'],
): ResearchRequestDecodeResult<T> {
  const value = parseWithoutThrow(schema, input);
  return value === undefined
    ? { ok: false, recovery: { kind: 'recovery', code } }
    : { ok: true, value };
}

export function decodeResearchCrudRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchCrudRequest> {
  return decodeResearchRequest(
    ResearchCrudRequestSchema,
    input,
    'research_crud_request_unavailable',
  );
}

export function decodeResearchLinkRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchLinkRequest> {
  return decodeResearchRequest(
    ResearchLinkRequestSchema,
    input,
    'research_link_request_unavailable',
  );
}

export function decodeResearchReviewRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchReviewRequest> {
  return decodeResearchRequest(
    ResearchReviewRequestSchema,
    input,
    'research_review_request_unavailable',
  );
}

export function decodeResearchRestoreRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchRestoreRequest> {
  return decodeResearchRequest(
    ResearchRestoreRequestSchema,
    input,
    'research_restore_request_unavailable',
  );
}

export function decodeResearchArtifactVersionRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchArtifactVersionRequest> {
  return decodeResearchRequest(
    ResearchArtifactVersionRequestSchema,
    input,
    'research_version_request_unavailable',
  );
}

export function decodeResearchVersionRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchVersionRequest> {
  return decodeResearchArtifactVersionRequest(input);
}

export function decodeResearchCheckpointRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchCheckpointRequest> {
  return decodeResearchRequest(
    ResearchCheckpointRequestSchema,
    input,
    'research_checkpoint_request_unavailable',
  );
}

export function decodeResearchDecisionRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchDecisionRequest> {
  return decodeResearchRequest(
    ResearchDecisionRequestSchema,
    input,
    'research_decision_request_unavailable',
  );
}

export function decodeResearchSnapshotRequest(
  input: unknown,
): ResearchRequestDecodeResult<ResearchSnapshotRequest> {
  return decodeResearchRequest(
    ResearchSnapshotRequestSchema,
    input,
    'research_snapshot_request_unavailable',
  );
}

export const ResearchMutationSuccessCodeSchema = z.enum([
  'created',
  'updated',
  'deleted',
  'restored',
  'linked',
  'unlinked',
  'reviewed',
  'versioned',
  'checkpointed',
  'decided',
  'undone',
]);

export const ResearchMutationResourceKindSchema = z.enum([
  'project',
  'source',
  'evidence',
  'note_code',
  'claim',
  'artifact',
  'claim_evidence_link',
  'artifact_version',
  'checkpoint',
  'decision',
]);

const ResearchMutationSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: ResearchMutationSuccessCodeSchema,
  projectId: RuntimeIdSchema,
  resourceKind: ResearchMutationResourceKindSchema,
  resourceId: RuntimeIdSchema,
  version: VersionSchema.optional(),
});

const ResearchMutationFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.enum([
    'not_found',
    'conflict',
    'rejected',
    'forbidden',
    'research_mutation_unavailable',
  ]),
});

export const ResearchMutationResultSchema = z.discriminatedUnion('success', [
  ResearchMutationSuccessSchema,
  ResearchMutationFailureSchema,
]);

export type ResearchMutationResult = z.infer<typeof ResearchMutationResultSchema>;

export function createResearchMutationRecovery(): ResearchMutationResult {
  return { success: false, code: 'research_mutation_unavailable' };
}

export function decodeResearchMutationResult(input: unknown): ResearchMutationResult {
  return parseWithoutThrow(ResearchMutationResultSchema, input)
    ?? createResearchMutationRecovery();
}

const ResearchEntityResultFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('research_entity_unavailable'),
});

const ResearchEntityResultSuccessSchema = z.strictObject({
  success: z.literal(true),
  entity: ResearchEntityEnvelopeSchema,
});

export const ResearchEntityResultSchema = z.discriminatedUnion('success', [
  ResearchEntityResultSuccessSchema,
  ResearchEntityResultFailureSchema,
]);

export type ResearchEntityResult = z.infer<typeof ResearchEntityResultSchema>;

export function createResearchEntityRecovery(): ResearchEntityResult {
  return { success: false, code: 'research_entity_unavailable' };
}

export function decodeResearchEntityResult(input: unknown): ResearchEntityResult {
  return parseWithoutThrow(ResearchEntityResultSchema, input)
    ?? createResearchEntityRecovery();
}

const ResearchEntityListFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('research_entity_list_unavailable'),
  items: z.tuple([]),
});

const ResearchEntityListSuccessSchema = z.strictObject({
  success: z.literal(true),
  items: z.array(ResearchEntityEnvelopeSchema).max(RESEARCH_RUNTIME_LIMITS.entities),
});

export const ResearchEntityListResultSchema = z.discriminatedUnion('success', [
  ResearchEntityListSuccessSchema,
  ResearchEntityListFailureSchema,
]);

export type ResearchEntityListResult = z.infer<typeof ResearchEntityListResultSchema>;

export function createResearchEntityListRecovery(): ResearchEntityListResult {
  return { success: false, code: 'research_entity_list_unavailable', items: [] };
}

export function decodeResearchEntityListResult(input: unknown): ResearchEntityListResult {
  return parseWithoutThrow(ResearchEntityListResultSchema, input)
    ?? createResearchEntityListRecovery();
}

const ResearchSnapshotFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('research_snapshot_unavailable'),
});

const ResearchSnapshotSuccessSchema = z.strictObject({
  success: z.literal(true),
  snapshot: ProjectSnapshotRuntimeSchema,
});

export const ResearchSnapshotResultSchema = z.discriminatedUnion('success', [
  ResearchSnapshotSuccessSchema,
  ResearchSnapshotFailureSchema,
]);

export type ResearchSnapshotResult = z.infer<typeof ResearchSnapshotResultSchema>;

export function createResearchSnapshotRecovery(): ResearchSnapshotResult {
  return { success: false, code: 'research_snapshot_unavailable' };
}

export function decodeResearchSnapshotResult(input: unknown): ResearchSnapshotResult {
  return parseWithoutThrow(ResearchSnapshotResultSchema, input)
    ?? createResearchSnapshotRecovery();
}

function createFixedItemResultSchema<
  T extends z.ZodTypeAny,
  const Code extends string,
>(
  itemSchema: T,
  unavailableCode: Code,
) {
  const success = z.strictObject({
    success: z.literal(true),
    item: itemSchema,
  });
  const failure = z.strictObject({
    success: z.literal(false),
    code: z.literal(unavailableCode),
  });
  return z.discriminatedUnion('success', [success, failure]);
}

export const ResearchArtifactVersionResultSchema = createFixedItemResultSchema(
  ResearchArtifactVersionDtoSchema,
  'research_version_unavailable',
);

export const ResearchCheckpointResultSchema = createFixedItemResultSchema(
  ResearchCheckpointDtoSchema,
  'research_checkpoint_unavailable',
);

export const ResearchDecisionResultSchema = createFixedItemResultSchema(
  ResearchDecisionDtoSchema,
  'research_decision_unavailable',
);

export type ResearchArtifactVersionResult = z.infer<typeof ResearchArtifactVersionResultSchema>;
export type ResearchCheckpointResult = z.infer<typeof ResearchCheckpointResultSchema>;
export type ResearchDecisionResult = z.infer<typeof ResearchDecisionResultSchema>;

export function decodeResearchArtifactVersionResult(
  input: unknown,
): ResearchArtifactVersionResult {
  return parseWithoutThrow(ResearchArtifactVersionResultSchema, input) ?? {
    success: false,
    code: 'research_version_unavailable',
  };
}

export function decodeResearchCheckpointResult(input: unknown): ResearchCheckpointResult {
  return parseWithoutThrow(ResearchCheckpointResultSchema, input) ?? {
    success: false,
    code: 'research_checkpoint_unavailable',
  };
}

export function decodeResearchDecisionResult(input: unknown): ResearchDecisionResult {
  return parseWithoutThrow(ResearchDecisionResultSchema, input) ?? {
    success: false,
    code: 'research_decision_unavailable',
  };
}

function createFixedListResultSchema<
  T extends z.ZodTypeAny,
  const Code extends string,
>(
  itemSchema: T,
  maximum: number,
  unavailableCode: Code,
) {
  const success = z.strictObject({
    success: z.literal(true),
    items: z.array(itemSchema).max(maximum),
  });
  const failure = z.strictObject({
    success: z.literal(false),
    code: z.literal(unavailableCode),
    items: z.tuple([]),
  });
  return z.discriminatedUnion('success', [success, failure]);
}

export const ResearchLinkListResultSchema = createFixedListResultSchema(
  ResearchClaimEvidenceLinkDtoSchema,
  RESEARCH_RUNTIME_LIMITS.links,
  'research_link_list_unavailable',
);

export const ResearchArtifactVersionListResultSchema = createFixedListResultSchema(
  ResearchArtifactVersionDtoSchema,
  RESEARCH_RUNTIME_LIMITS.artifactVersions,
  'research_version_list_unavailable',
);

export const ResearchCheckpointListResultSchema = createFixedListResultSchema(
  ResearchCheckpointDtoSchema,
  RESEARCH_RUNTIME_LIMITS.checkpoints,
  'research_checkpoint_list_unavailable',
);

export const ResearchDecisionListResultSchema = createFixedListResultSchema(
  ResearchDecisionDtoSchema,
  RESEARCH_RUNTIME_LIMITS.decisions,
  'research_decision_list_unavailable',
);

export type ResearchLinkListResult = z.infer<typeof ResearchLinkListResultSchema>;
export type ResearchArtifactVersionListResult = z.infer<typeof ResearchArtifactVersionListResultSchema>;
export type ResearchCheckpointListResult = z.infer<typeof ResearchCheckpointListResultSchema>;
export type ResearchDecisionListResult = z.infer<typeof ResearchDecisionListResultSchema>;

export function decodeResearchLinkListResult(input: unknown): ResearchLinkListResult {
  return parseWithoutThrow(ResearchLinkListResultSchema, input) ?? {
    success: false,
    code: 'research_link_list_unavailable',
    items: [],
  };
}

export function decodeResearchArtifactVersionListResult(
  input: unknown,
): ResearchArtifactVersionListResult {
  return parseWithoutThrow(ResearchArtifactVersionListResultSchema, input) ?? {
    success: false,
    code: 'research_version_list_unavailable',
    items: [],
  };
}

export function decodeResearchCheckpointListResult(
  input: unknown,
): ResearchCheckpointListResult {
  return parseWithoutThrow(ResearchCheckpointListResultSchema, input) ?? {
    success: false,
    code: 'research_checkpoint_list_unavailable',
    items: [],
  };
}

export function decodeResearchDecisionListResult(
  input: unknown,
): ResearchDecisionListResult {
  return parseWithoutThrow(ResearchDecisionListResultSchema, input) ?? {
    success: false,
    code: 'research_decision_list_unavailable',
    items: [],
  };
}

// ─── Explicit legacy persistence migration ───────────────────

export type ResearchLegacyDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: ResearchRuntimeRecovery };

function legacyFailure<T>(
  code: Extract<
    ResearchRuntimeRecovery['code'],
    'research_record_unavailable' | 'research_snapshot_unavailable'
  >,
): ResearchLegacyDecodeResult<T> {
  return { ok: false, recovery: { kind: 'recovery', code } };
}

function legacyRecord<T>(
  schema: z.ZodType<T>,
  candidate: unknown,
): ResearchLegacyDecodeResult<T> {
  const value = parseWithoutThrow(schema, candidate);
  return value === undefined
    ? legacyFailure('research_record_unavailable')
    : { ok: true, value };
}

function safeLegacyTitle(value: unknown): string {
  return parseWithoutThrow(ResearchDisplayTitleSchema, value) ?? 'Untitled';
}

function safeLegacyContentRef(value: unknown): string | null {
  return parseWithoutThrow(ResearchContentRefSchema, value) ?? null;
}

function legacyDefault(value: unknown, fallback: unknown): unknown {
  return value === undefined || value === null ? fallback : value;
}

function safeLegacyNoteCodeAcceptance(value: unknown): unknown {
  if (value === 1) return 'accepted';
  if (value === -1) return 'rejected';
  if (value === 0 || value === undefined || value === null) return 'pending';
  return value;
}

function safeLegacyArtifactVersionAuthor(value: unknown): unknown {
  return value === 'human' ? 'user' : legacyDefault(value, 'user');
}

export function decodeLegacyResearchProject(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchProjectDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchProjectDtoSchema, {
    id: readField(input, 'id'),
    title: safeLegacyTitle(readField(input, 'title')),
    originalIntent: legacyDefault(readField(input, 'originalIntent'), ''),
    researchQuestion: legacyDefault(readField(input, 'researchQuestion'), ''),
    lifecycle: legacyDefault(readField(input, 'lifecycle'), 'draft'),
    methodology: legacyDefault(readField(input, 'methodology'), ''),
    discipline: legacyDefault(readField(input, 'discipline'), ''),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    archivedAt: nullableLegacyField(input, 'archivedAt'),
    version: legacyDefault(readField(input, 'version'), 1),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchSource(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchSourceDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchSourceDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    kind: readField(input, 'kind'),
    title: safeLegacyTitle(readField(input, 'title')),
    authors: legacyDefault(readField(input, 'authors'), []),
    year: nullableLegacyField(input, 'year'),
    venue: legacyDefault(readField(input, 'venue'), ''),
    identifier: safeLegacyIdentifier(legacyDefault(readField(input, 'identifier'), '')),
    identifierType: parseWithoutThrow(
      ResearchIdentifierTypeSchema,
      readField(input, 'identifierType'),
    ) ?? 'other',
    externalUrl: safeLegacyHttpUrl(readField(input, 'externalUrl')),
    tags: legacyDefault(readField(input, 'tags'), []),
    sourceVersionHash: nullableLegacyField(input, 'sourceVersionHash'),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchEvidence(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchEvidenceDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchEvidenceDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    sourceId: readField(input, 'sourceId'),
    anchorType: legacyDefault(readField(input, 'anchorType'), 'none'),
    anchorStart: nullableLegacyField(input, 'anchorStart'),
    anchorEnd: nullableLegacyField(input, 'anchorEnd'),
    pageNumber: nullableLegacyField(input, 'pageNumber'),
    snippet: legacyDefault(readField(input, 'snippet'), ''),
    snippetHash: legacyDefault(readField(input, 'snippetHash'), ''),
    sourceVersionHash: nullableLegacyField(input, 'sourceVersionHash'),
    confidence: legacyDefault(readField(input, 'confidence'), 0),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchNoteCode(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchNoteCodeDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchNoteCodeDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    evidenceId: nullableLegacyField(input, 'evidenceId'),
    code: readField(input, 'code'),
    content: legacyDefault(readField(input, 'content'), ''),
    author: legacyDefault(readField(input, 'author'), 'human'),
    confidence: legacyDefault(readField(input, 'confidence'), 0),
    accepted: safeLegacyNoteCodeAcceptance(readField(input, 'accepted')),
    tags: legacyDefault(readField(input, 'tags'), []),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchClaim(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchClaimDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchClaimDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    statement: readField(input, 'statement'),
    claimType: legacyDefault(readField(input, 'claimType'), 'assertion'),
    confidence: legacyDefault(readField(input, 'confidence'), 0),
    status: legacyDefault(readField(input, 'status'), 'unsupported'),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchArtifact(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchArtifactDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchArtifactDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    title: safeLegacyTitle(readField(input, 'title')),
    artifactType: readField(input, 'artifactType'),
    reviewStatus: readField(input, 'reviewStatus'),
    contentRef: safeLegacyContentRef(readField(input, 'contentRef')),
    inputHash: nullableLegacyField(input, 'inputHash'),
    version: readField(input, 'version'),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchClaimEvidenceLink(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchClaimEvidenceLinkDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchClaimEvidenceLinkDtoSchema, {
    id: readField(input, 'id'),
    claimId: readField(input, 'claimId'),
    evidenceId: readField(input, 'evidenceId'),
    relation: readField(input, 'relation'),
    weight: legacyDefault(readField(input, 'weight'), 1),
    note: legacyDefault(readField(input, 'note'), ''),
    createdAt: readField(input, 'createdAt'),
  });
}

export function decodeLegacyResearchArtifactVersion(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchArtifactVersionDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchArtifactVersionDtoSchema, {
    artifactId: readField(input, 'artifactId'),
    version: readField(input, 'version'),
    contentHash: readField(input, 'contentHash'),
    createdAt: readField(input, 'createdAt'),
    createdBy: safeLegacyArtifactVersionAuthor(readField(input, 'createdBy')),
    branchFromVersion: nullableLegacyField(input, 'branchFromVersion'),
  });
}

export function decodeLegacyResearchRun(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchRunDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchRunDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    status: readField(input, 'status'),
    currentStepId: nullableLegacyField(input, 'currentStepId'),
    createdAt: readField(input, 'createdAt'),
    updatedAt: readField(input, 'updatedAt'),
    completedAt: nullableLegacyField(input, 'completedAt'),
    deletedAt: nullableLegacyField(input, 'deletedAt'),
  });
}

export function decodeLegacyResearchCheckpoint(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchCheckpointDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchCheckpointDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    runId: readField(input, 'runId'),
    stepId: readField(input, 'stepId'),
    lifecycle: readField(input, 'lifecycle'),
    inputHash: readField(input, 'inputHash'),
    outputHash: nullableLegacyField(input, 'outputHash'),
    completedSteps: legacyDefault(readField(input, 'completedSteps'), []),
    decisions: legacyDefault(readField(input, 'decisions'), []),
    pendingSteps: legacyDefault(readField(input, 'pendingSteps'), []),
    runtimeProfileVersion: legacyDefault(readField(input, 'runtimeProfileVersion'), ''),
    errorCategory: nullableLegacyField(input, 'errorCategory'),
    recoveryStrategy: nullableLegacyField(input, 'recoveryStrategy'),
    createdAt: readField(input, 'createdAt'),
  });
}

export function decodeLegacyResearchDecision(
  input: unknown,
): ResearchLegacyDecodeResult<ResearchDecisionDto> {
  if (!isPlainRecord(input)) return legacyFailure('research_record_unavailable');
  return legacyRecord(ResearchDecisionDtoSchema, {
    id: readField(input, 'id'),
    projectId: readField(input, 'projectId'),
    runId: nullableLegacyField(input, 'runId'),
    targetKind: readField(input, 'targetKind'),
    targetId: readField(input, 'targetId'),
    decision: readField(input, 'decision'),
    origin: readField(input, 'origin'),
    note: readField(input, 'note'),
    createdAt: readField(input, 'createdAt'),
    undoneAt: nullableLegacyField(input, 'undoneAt'),
  });
}

export function decodeLegacyResearchEntity(
  entityKind: z.infer<typeof ResearchEntityKindSchema>,
  input: unknown,
): ResearchEntityResult {
  switch (entityKind) {
    case 'project': {
      const decoded = decodeLegacyResearchProject(input);
      return decoded.ok
        ? { success: true, entity: { entityKind, value: decoded.value } }
        : createResearchEntityRecovery();
    }
    case 'source': {
      const decoded = decodeLegacyResearchSource(input);
      return decoded.ok
        ? { success: true, entity: { entityKind, value: decoded.value } }
        : createResearchEntityRecovery();
    }
    case 'evidence': {
      const decoded = decodeLegacyResearchEvidence(input);
      return decoded.ok
        ? { success: true, entity: { entityKind, value: decoded.value } }
        : createResearchEntityRecovery();
    }
    case 'note_code': {
      const decoded = decodeLegacyResearchNoteCode(input);
      return decoded.ok
        ? { success: true, entity: { entityKind, value: decoded.value } }
        : createResearchEntityRecovery();
    }
    case 'claim': {
      const decoded = decodeLegacyResearchClaim(input);
      return decoded.ok
        ? { success: true, entity: { entityKind, value: decoded.value } }
        : createResearchEntityRecovery();
    }
    case 'artifact': {
      const decoded = decodeLegacyResearchArtifact(input);
      return decoded.ok
        ? { success: true, entity: { entityKind, value: decoded.value } }
        : createResearchEntityRecovery();
    }
  }
  const unreachable: never = entityKind;
  void unreachable;
  return createResearchEntityRecovery();
}

export function decodeLegacyResearchEntityList(
  entityKind: z.infer<typeof ResearchEntityKindSchema>,
  input: unknown,
): ResearchEntityListResult {
  if (!isArrayValue(input)) {
    return createResearchEntityListRecovery();
  }
  try {
    if (input.length > RESEARCH_RUNTIME_LIMITS.entities) {
      return createResearchEntityListRecovery();
    }
    const items: ResearchEntityEnvelope[] = [];
    for (const item of input) {
      const decoded = decodeLegacyResearchEntity(entityKind, item);
      if (!decoded.success) return createResearchEntityListRecovery();
      items.push(decoded.entity);
    }
    return { success: true, items };
  } catch {
    return createResearchEntityListRecovery();
  }
}

function decodeLegacyArray<T>(
  input: unknown,
  maximum: number,
  decoder: (item: unknown) => ResearchLegacyDecodeResult<T>,
): T[] | undefined {
  if (!isArrayValue(input)) return undefined;
  try {
    if (input.length > maximum) return undefined;
    const values: T[] = [];
    for (const item of input) {
      const decoded = decoder(item);
      if (!decoded.ok) return undefined;
      values.push(decoded.value);
    }
    return values;
  } catch {
    return undefined;
  }
}

function legacySnapshotArray(
  record: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  const value = readField(record, key);
  if (value === undefined) return [];
  return isArrayValue(value) ? value : undefined;
}

export function decodeLegacyProjectSnapshot(
  input: unknown,
): ResearchLegacyDecodeResult<ProjectSnapshotRuntime> {
  if (!isPlainRecord(input)) return legacyFailure('research_snapshot_unavailable');

  const project = decodeLegacyResearchProject(readField(input, 'project'));
  if (!project.ok) return legacyFailure('research_snapshot_unavailable');

  const sources = decodeLegacyArray(
    legacySnapshotArray(input, 'sources'),
    RESEARCH_RUNTIME_LIMITS.entities,
    decodeLegacyResearchSource,
  );
  const evidence = decodeLegacyArray(
    legacySnapshotArray(input, 'evidence'),
    RESEARCH_RUNTIME_LIMITS.entities,
    decodeLegacyResearchEvidence,
  );
  const noteCodes = decodeLegacyArray(
    legacySnapshotArray(input, 'noteCodes'),
    RESEARCH_RUNTIME_LIMITS.entities,
    decodeLegacyResearchNoteCode,
  );
  const claims = decodeLegacyArray(
    legacySnapshotArray(input, 'claims'),
    RESEARCH_RUNTIME_LIMITS.entities,
    decodeLegacyResearchClaim,
  );
  const claimEvidenceLinks = decodeLegacyArray(
    legacySnapshotArray(input, 'claimEvidenceLinks'),
    RESEARCH_RUNTIME_LIMITS.links,
    decodeLegacyResearchClaimEvidenceLink,
  );
  const artifacts = decodeLegacyArray(
    legacySnapshotArray(input, 'artifacts'),
    RESEARCH_RUNTIME_LIMITS.entities,
    decodeLegacyResearchArtifact,
  );
  const artifactVersions = decodeLegacyArray(
    legacySnapshotArray(input, 'artifactVersions'),
    RESEARCH_RUNTIME_LIMITS.artifactVersions,
    decodeLegacyResearchArtifactVersion,
  );
  const runs = decodeLegacyArray(
    legacySnapshotArray(input, 'runs'),
    RESEARCH_RUNTIME_LIMITS.runs,
    decodeLegacyResearchRun,
  );
  const checkpoints = decodeLegacyArray(
    legacySnapshotArray(input, 'checkpoints'),
    RESEARCH_RUNTIME_LIMITS.checkpoints,
    decodeLegacyResearchCheckpoint,
  );
  const decisions = decodeLegacyArray(
    legacySnapshotArray(input, 'decisions'),
    RESEARCH_RUNTIME_LIMITS.decisions,
    decodeLegacyResearchDecision,
  );

  if (
    sources === undefined
    || evidence === undefined
    || noteCodes === undefined
    || claims === undefined
    || claimEvidenceLinks === undefined
    || artifacts === undefined
    || artifactVersions === undefined
    || runs === undefined
    || checkpoints === undefined
    || decisions === undefined
  ) {
    return legacyFailure('research_snapshot_unavailable');
  }

  const snapshot = parseWithoutThrow(ProjectSnapshotRuntimeSchema, {
    project: project.value,
    sources,
    evidence,
    noteCodes,
    claims,
    claimEvidenceLinks,
    artifacts,
    artifactVersions,
    runs,
    checkpoints,
    decisions,
    capturedAt: legacyDefault(readField(input, 'capturedAt'), project.value.updatedAt),
  });
  return snapshot === undefined
    ? legacyFailure('research_snapshot_unavailable')
    : { ok: true, value: snapshot };
}

/** Accepts either the current fixed response or an explicit legacy snapshot. */
export function decodeResearchSnapshotPayload(input: unknown): ResearchSnapshotResult {
  const current = parseWithoutThrow(ResearchSnapshotResultSchema, input);
  if (current !== undefined) return current;
  const legacy = decodeLegacyProjectSnapshot(input);
  return legacy.ok
    ? { success: true, snapshot: legacy.value }
    : createResearchSnapshotRecovery();
}
