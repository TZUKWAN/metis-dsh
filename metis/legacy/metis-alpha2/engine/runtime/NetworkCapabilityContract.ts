import { z } from 'zod';
import { inspectExternalNavigationUrl } from '../security/ExternalNavigation.js';

export const NETWORK_CAPABILITY_LIMITS = Object.freeze({
  urlChars: 2_048,
  sourceIdChars: 256,
  displayNameChars: 240,
  contentTypes: 8,
  defaultMaxBytes: 64 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  defaultRedirects: 3,
  maxRedirects: 5,
} as const);

export const NETWORK_CAPABILITY_UNAVAILABLE = 'network_capability_unavailable' as const;
export const NETWORK_DOWNLOAD_COMPLETE = 'network_download_complete' as const;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function boundedControlFreeText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const NetworkDisplayNameSchema = boundedControlFreeText(
  NETWORK_CAPABILITY_LIMITS.displayNameChars,
)
  .min(1)
  .refine((value) => !/[\\/]/u.test(value) && value !== '.' && value !== '..', {
    message: 'Display name is unavailable',
  });

export const NetworkContentTypeSchema = boundedControlFreeText(127)
  .min(3)
  .regex(MIME_TYPE)
  .transform((value) => value.toLowerCase());

const AllowedContentTypesSchema = z.array(NetworkContentTypeSchema)
  .min(1)
  .max(NETWORK_CAPABILITY_LIMITS.contentTypes)
  .superRefine((contentTypes, context) => {
    const seen = new Set<string>();
    for (const [index, contentType] of contentTypes.entries()) {
      if (seen.has(contentType)) {
        context.addIssue({
          code: 'custom',
          message: 'Allowed content types must be unique',
          path: [index],
        });
      }
      seen.add(contentType);
    }
  });

export const CleanHttpsUrlSchema = z.string()
  .min(1)
  .max(NETWORK_CAPABILITY_LIMITS.urlChars)
  .superRefine((value, context) => {
    if (!inspectExternalNavigationUrl(value).ok) {
      context.addIssue({
        code: 'custom',
        message: 'HTTPS resource URL is unavailable',
      });
    }
  });

export const ControlledSourceIdSchema = boundedControlFreeText(
  NETWORK_CAPABILITY_LIMITS.sourceIdChars,
)
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const MaxBytesSchema = z.number()
  .int()
  .min(1)
  .max(NETWORK_CAPABILITY_LIMITS.maxBytes)
  .default(NETWORK_CAPABILITY_LIMITS.defaultMaxBytes);

const TimeoutSchema = z.number()
  .int()
  .min(1_000)
  .max(NETWORK_CAPABILITY_LIMITS.maxTimeoutMs)
  .default(NETWORK_CAPABILITY_LIMITS.defaultTimeoutMs);

const RedirectSchema = z.number()
  .int()
  .min(0)
  .max(NETWORK_CAPABILITY_LIMITS.maxRedirects)
  .default(NETWORK_CAPABILITY_LIMITS.defaultRedirects);

const CleanPdfRequestSchema = z.strictObject({
  mode: z.literal('clean-url'),
  resource: z.literal('pdf'),
  url: CleanHttpsUrlSchema,
  maxBytes: MaxBytesSchema,
  timeoutMs: TimeoutSchema,
  maxRedirects: RedirectSchema,
});

const CleanBinaryRequestSchema = z.strictObject({
  mode: z.literal('clean-url'),
  resource: z.literal('binary'),
  url: CleanHttpsUrlSchema,
  allowedContentTypes: AllowedContentTypesSchema,
  maxBytes: MaxBytesSchema,
  timeoutMs: TimeoutSchema,
  maxRedirects: RedirectSchema,
});

const SourcePdfRequestSchema = z.strictObject({
  mode: z.literal('controlled-source'),
  resource: z.literal('pdf'),
  sourceId: ControlledSourceIdSchema,
  maxBytes: MaxBytesSchema,
  timeoutMs: TimeoutSchema,
  maxRedirects: RedirectSchema,
});

const SourceBinaryRequestSchema = z.strictObject({
  mode: z.literal('controlled-source'),
  resource: z.literal('binary'),
  sourceId: ControlledSourceIdSchema,
  allowedContentTypes: AllowedContentTypesSchema,
  maxBytes: MaxBytesSchema,
  timeoutMs: TimeoutSchema,
  maxRedirects: RedirectSchema,
});

export const NetworkDownloadRequestSchema = z.union([
  CleanPdfRequestSchema,
  CleanBinaryRequestSchema,
  SourcePdfRequestSchema,
  SourceBinaryRequestSchema,
]);

export type NetworkDownloadRequest = z.infer<typeof NetworkDownloadRequestSchema>;

export const NetworkDownloadFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal(NETWORK_CAPABILITY_UNAVAILABLE),
});

export type NetworkDownloadFailure = z.infer<typeof NetworkDownloadFailureSchema>;

export const NetworkDownloadSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(NETWORK_DOWNLOAD_COMPLETE),
  displayName: NetworkDisplayNameSchema,
  mediaType: NetworkContentTypeSchema,
  byteLength: z.number().int().min(1).max(NETWORK_CAPABILITY_LIMITS.maxBytes),
  sha256: z.string().regex(SHA256),
});

export type NetworkDownloadSuccess = z.infer<typeof NetworkDownloadSuccessSchema>;

export const NetworkDownloadResultSchema = z.union([
  NetworkDownloadSuccessSchema,
  NetworkDownloadFailureSchema,
]);

export type NetworkDownloadResult = z.infer<typeof NetworkDownloadResultSchema>;

export type NetworkDownloadRequestDecodeResult =
  | { ok: true; value: NetworkDownloadRequest }
  | { ok: false; failure: NetworkDownloadFailure };

export function createNetworkDownloadFailure(): NetworkDownloadFailure {
  return { success: false, code: NETWORK_CAPABILITY_UNAVAILABLE };
}

export function decodeNetworkDownloadRequest(
  input: unknown,
): NetworkDownloadRequestDecodeResult {
  const value = parseWithoutThrow(NetworkDownloadRequestSchema, input);
  return value === undefined
    ? { ok: false, failure: createNetworkDownloadFailure() }
    : { ok: true, value };
}

export function decodeNetworkDownloadResult(input: unknown): NetworkDownloadResult {
  return parseWithoutThrow(NetworkDownloadResultSchema, input)
    ?? createNetworkDownloadFailure();
}
