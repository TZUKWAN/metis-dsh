import { createHash, timingSafeEqual } from 'node:crypto';
import {
  RESEARCH_MEDIA_LIMITS,
  RESEARCH_MEDIA_TYPES,
  type ResearchMediaType,
} from '../../runtime/ResearchMediaRuntimeContract.js';

export const RESEARCH_IMAGE_LIMITS = RESEARCH_MEDIA_LIMITS;

export const SUPPORTED_RESEARCH_IMAGE_MEDIA_TYPES = RESEARCH_MEDIA_TYPES;

export type SupportedResearchImageMediaType = ResearchMediaType;

export interface ResearchImagePayload {
  mediaType: string;
  base64Data: string;
  sha256: string;
  widthPx?: number;
  heightPx?: number;
}

export interface ValidatedResearchImage {
  bytes: Buffer;
  mediaType: SupportedResearchImageMediaType;
  extension: 'png' | 'jpg' | 'gif';
  widthPx: number;
  heightPx: number;
  sha256: string;
}

export type ResearchImageValidationResult =
  | { ok: true; image: ValidatedResearchImage }
  | { ok: false; reason: string };

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function pngDimensions(bytes: Buffer): { widthPx: number; heightPx: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    bytes.length < 33
    || !bytes.subarray(0, signature.length).equals(signature)
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
    || bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii') !== 'IEND'
  ) {
    return null;
  }
  return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes: Buffer): { widthPx: number; heightPx: number } | null {
  if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) return null;
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return { widthPx: bytes.readUInt16LE(6), heightPx: bytes.readUInt16LE(8) };
}

function jpegDimensions(bytes: Buffer): { widthPx: number; heightPx: number } | null {
  if (
    bytes.length < 12
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    if (marker === undefined) return null;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        heightPx: bytes.readUInt16BE(offset + 3),
        widthPx: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function validateDimensions(
  dimensions: { widthPx: number; heightPx: number } | null,
): dimensions is { widthPx: number; heightPx: number } {
  if (!dimensions) return false;
  const { widthPx, heightPx } = dimensions;
  return Number.isInteger(widthPx)
    && Number.isInteger(heightPx)
    && widthPx >= 1
    && heightPx >= 1
    && widthPx <= RESEARCH_IMAGE_LIMITS.widthPx
    && heightPx <= RESEARCH_IMAGE_LIMITS.heightPx
    && widthPx * heightPx <= RESEARCH_IMAGE_LIMITS.pixels;
}

export function validateResearchImagePayload(
  payload: ResearchImagePayload,
): ResearchImageValidationResult {
  if (!SUPPORTED_RESEARCH_IMAGE_MEDIA_TYPES.includes(
    payload.mediaType as SupportedResearchImageMediaType,
  )) {
    return { ok: false, reason: 'Unsupported research image media type' };
  }
  if (
    payload.base64Data.length === 0
    || payload.base64Data.length % 4 !== 0
    || !CANONICAL_BASE64.test(payload.base64Data)
  ) {
    return { ok: false, reason: 'Research image data is not canonical base64' };
  }

  const bytes = Buffer.from(payload.base64Data, 'base64');
  if (bytes.toString('base64') !== payload.base64Data) {
    return { ok: false, reason: 'Research image byte length is unavailable' };
  }
  if (!SHA256.test(payload.sha256)) {
    return { ok: false, reason: 'Research image SHA-256 is unavailable' };
  }
  const inspected = inspectResearchImageBytes(bytes);
  if (!inspected.ok) return inspected;
  const actualDigest = Buffer.from(inspected.image.sha256, 'hex');
  const expectedDigest = Buffer.from(payload.sha256, 'hex');
  if (
    actualDigest.length !== expectedDigest.length
    || !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    return { ok: false, reason: 'Research image SHA-256 mismatch' };
  }
  if (inspected.image.mediaType !== payload.mediaType) {
    return { ok: false, reason: 'Research image media type does not match its bytes' };
  }
  if (
    (payload.widthPx !== undefined && payload.widthPx !== inspected.image.widthPx)
    || (payload.heightPx !== undefined && payload.heightPx !== inspected.image.heightPx)
  ) {
    return { ok: false, reason: 'Research image dimensions do not match its bytes' };
  }

  return inspected;
}

/**
 * Main-process byte inspector. It derives every trusted intrinsic value from the
 * bytes and accepts no renderer-supplied MIME, digest or dimensions.
 */
export function inspectResearchImageBytes(
  input: Uint8Array,
): ResearchImageValidationResult {
  const bytes = Buffer.from(input);
  if (bytes.length < 10 || bytes.length > RESEARCH_IMAGE_LIMITS.decodedBytes) {
    return { ok: false, reason: 'Research image byte length is unavailable' };
  }

  const candidates: Array<{
    mediaType: SupportedResearchImageMediaType;
    extension: ValidatedResearchImage['extension'];
    dimensions: { widthPx: number; heightPx: number } | null;
  }> = [
    { mediaType: 'image/png', extension: 'png', dimensions: pngDimensions(bytes) },
    { mediaType: 'image/jpeg', extension: 'jpg', dimensions: jpegDimensions(bytes) },
    { mediaType: 'image/gif', extension: 'gif', dimensions: gifDimensions(bytes) },
  ];
  const detected = candidates.find((candidate) => validateDimensions(candidate.dimensions));
  if (!detected || !detected.dimensions) {
    return { ok: false, reason: 'Research image dimensions or signature are unavailable' };
  }

  return {
    ok: true,
    image: {
      bytes,
      mediaType: detected.mediaType,
      extension: detected.extension,
      widthPx: detected.dimensions.widthPx,
      heightPx: detected.dimensions.heightPx,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
