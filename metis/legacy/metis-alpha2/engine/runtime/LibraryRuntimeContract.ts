import { z } from 'zod';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';
import { FileCapabilityDescriptorSchema } from './FileCapabilityContract.js';

export const LIBRARY_RUNTIME_LIMITS = Object.freeze({
  records: 20_000,
  titleChars: 1_000,
  shortTextChars: 8_000,
  abstractChars: 200_000,
  noteChars: 2_000_000,
  paperTextChars: 8_000_000,
  tags: 256,
  tagChars: 160,
  authors: 512,
  authorChars: 300,
  links: 20_000,
  mapEntries: 512,
} as const);

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const BoundedIdArraySchema = z.array(RuntimeIdSchema).max(LIBRARY_RUNTIME_LIMITS.links);
const TagSchema = z.string().trim().min(1).max(LIBRARY_RUNTIME_LIMITS.tagChars);
const TagsSchema = z.array(TagSchema).max(LIBRARY_RUNTIME_LIMITS.tags);
const AuthorSchema = z.string().trim().min(1).max(LIBRARY_RUNTIME_LIMITS.authorChars);
const AuthorsSchema = z.array(AuthorSchema).max(LIBRARY_RUNTIME_LIMITS.authors);

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

const HttpsUrlSchema = z.string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(isSafeHttpsUrl, { message: 'Only credential-free HTTPS URLs are allowed' });

export const LibraryReadStatusSchema = z.enum(['unread', 'reading', 'read', 'skimmed']);

export const LibraryPaperSaveRequestSchema = z.strictObject({
  id: RuntimeIdSchema,
  title: z.string().trim().min(1).max(LIBRARY_RUNTIME_LIMITS.titleChars),
  authors: AuthorsSchema,
  year: z.number().int().min(0).max(3_000),
  venue: z.string().max(LIBRARY_RUNTIME_LIMITS.shortTextChars),
  abstract: z.string().max(LIBRARY_RUNTIME_LIMITS.abstractChars),
  doi: z.string().trim().max(1_000).optional(),
  arxivId: z.string().trim().max(1_000).optional(),
  pdfCapability: FileCapabilityDescriptorSchema.optional(),
  pdfUrl: HttpsUrlSchema.optional(),
  url: HttpsUrlSchema.optional(),
  pdfText: z.string().max(LIBRARY_RUNTIME_LIMITS.paperTextChars).optional(),
  citationCount: z.number().int().min(0).max(1_000_000_000).optional(),
  tags: TagsSchema,
  notes: z.string().max(LIBRARY_RUNTIME_LIMITS.noteChars),
  readStatus: LibraryReadStatusSchema,
  readAt: TimestampSchema.optional(),
  rating: z.number().int().min(0).max(5),
  starred: z.boolean().optional(),
  referenceIds: BoundedIdArraySchema.optional(),
  readingProgress: z.number().min(0).max(100).optional(),
  readingTimeSeconds: z.number().int().min(0).max(10_000_000_000).optional(),
  archived: z.boolean().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  deadline: z.string().trim().max(100).optional(),
  projectId: z.string().max(100).optional(),
  projectIds: BoundedIdArraySchema.optional(),
  addedAt: TimestampSchema,
});
export type LibraryPaperSaveRequest = z.infer<typeof LibraryPaperSaveRequestSchema>;

export const LibraryPaperViewSchema = LibraryPaperSaveRequestSchema.omit({
  url: true,
  readAt: true,
  starred: true,
  referenceIds: true,
  readingProgress: true,
  readingTimeSeconds: true,
  archived: true,
  priority: true,
  deadline: true,
}).extend({
  pdfCapability: FileCapabilityDescriptorSchema.optional(),
});
export type LibraryPaperView = z.infer<typeof LibraryPaperViewSchema>;

export const LibraryCollectionSchema = z.strictObject({
  id: RuntimeIdSchema,
  name: z.string().trim().min(1).max(LIBRARY_RUNTIME_LIMITS.titleChars),
  description: z.string().max(LIBRARY_RUNTIME_LIMITS.abstractChars),
  paperIds: BoundedIdArraySchema,
  createdAt: TimestampSchema,
});
export type LibraryCollection = z.infer<typeof LibraryCollectionSchema>;

export const LibraryNoteSchema = z.strictObject({
  id: RuntimeIdSchema,
  scope: z.enum(['global', 'research']).default('global'),
  projectId: RuntimeIdSchema.optional(),
  title: z.string().trim().min(1).max(LIBRARY_RUNTIME_LIMITS.titleChars),
  content: z.string().max(LIBRARY_RUNTIME_LIMITS.noteChars),
  tags: TagsSchema,
  linkedPaperIds: BoundedIdArraySchema,
  linkedNoteIds: BoundedIdArraySchema,
  starred: z.boolean().optional(),
  updatedAt: TimestampSchema,
}).superRefine((value, context) => {
  if (value.scope === 'research' && !value.projectId) {
    context.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'Research notes require a project id',
    });
  }
});
export type LibraryNote = z.infer<typeof LibraryNoteSchema>;

export const LibraryDeleteRequestSchema = z.strictObject({ id: RuntimeIdSchema });
export type LibraryDeleteRequest = z.infer<typeof LibraryDeleteRequestSchema>;

export const LibraryMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    code: z.enum(['saved', 'deleted']),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('library_mutation_unavailable'),
  }),
]);
export type LibraryMutationResult = z.infer<typeof LibraryMutationResultSchema>;

const PaperListSchema = z.array(LibraryPaperViewSchema).max(LIBRARY_RUNTIME_LIMITS.records);
const CollectionListSchema = z.array(LibraryCollectionSchema).max(LIBRARY_RUNTIME_LIMITS.records);
const NoteListSchema = z.array(LibraryNoteSchema).max(LIBRARY_RUNTIME_LIMITS.records);

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function decodeLibraryPaperSaveRequest(input: unknown): LibraryPaperSaveRequest | undefined {
  return parseWithoutThrow(LibraryPaperSaveRequestSchema, input);
}

export function decodeLibraryCollection(input: unknown): LibraryCollection | undefined {
  return parseWithoutThrow(LibraryCollectionSchema, input);
}

export function decodeLibraryNote(input: unknown): LibraryNote | undefined {
  return parseWithoutThrow(LibraryNoteSchema, input);
}

export function decodeLibraryDeleteRequest(input: unknown): LibraryDeleteRequest | undefined {
  return parseWithoutThrow(LibraryDeleteRequestSchema, input);
}

export function decodeLibraryPaperList(input: unknown): LibraryPaperView[] {
  return parseWithoutThrow(PaperListSchema, input) ?? [];
}

export function decodeLibraryCollectionList(input: unknown): LibraryCollection[] {
  return parseWithoutThrow(CollectionListSchema, input) ?? [];
}

export function decodeLibraryNoteList(input: unknown): LibraryNote[] {
  return parseWithoutThrow(NoteListSchema, input) ?? [];
}

export function createLibraryMutationFailure(): LibraryMutationResult {
  return { success: false, code: 'library_mutation_unavailable' };
}

export function decodeLibraryMutationResult(input: unknown): LibraryMutationResult {
  return parseWithoutThrow(LibraryMutationResultSchema, input) ?? createLibraryMutationFailure();
}

