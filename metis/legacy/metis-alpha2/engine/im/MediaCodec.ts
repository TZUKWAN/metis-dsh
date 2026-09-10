/**
 * WeChat CDN media codec (METIS-WX-2) — download and AES-128-ECB decryption.
 *
 * Mirrors the official Tencent WeChat channel plugin (Tencent/openclaw-weixin,
 * MIT): media is delivered encrypted; the key arrives as either
 *   - base64(16 raw bytes)                          → images
 *   - base64(hex string of 16 bytes)                → file / voice / video
 * and the payload decrypts with AES-128-ECB (PKCS7 padding).
 */

import { createDecipheriv } from 'node:crypto';

export const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const MAX_WECHAT_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB (official cap)

export interface CdnMediaRef {
  /** Encrypted query param for the /download endpoint (fallback when full_url absent). */
  encrypt_query_param?: string;
  /** Base64 AES key; two encodings supported (see parseAesKey). */
  aes_key?: string;
  encrypt_type?: number;
  /** Complete download URL when the server provides one. */
  full_url?: string;
}

export interface DownloadedMedia {
  buffer: Buffer;
  mime: string;
  extension: string;
  bytes: number;
}

/** Parse a base64 AES key into 16 raw bytes (two encodings, see header). */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

/** AES-128-ECB decrypt (PKCS7 padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Build the CDN download URL from an encrypted query param. */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** Map a WeChat media kind to a MIME type + extension (best effort). */
export function mediaKindToMime(kind: 'image' | 'voice' | 'file' | 'video', fileName?: string): { mime: string; extension: string } {
  if (fileName) {
    const ext = (fileName.match(/\.[A-Za-z0-9]+$/) ?? [])[0]?.toLowerCase();
    if (ext === '.pdf') return { mime: 'application/pdf', extension: 'pdf' };
    if (ext === '.txt') return { mime: 'text/plain', extension: 'txt' };
    if (ext === '.md') return { mime: 'text/markdown', extension: 'md' };
    if (ext === '.docx') return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' };
    if (ext === '.jpg' || ext === '.jpeg') return { mime: 'image/jpeg', extension: 'jpg' };
    if (ext === '.png') return { mime: 'image/png', extension: 'png' };
    if (ext === '.mp3') return { mime: 'audio/mpeg', extension: 'mp3' };
    if (ext === '.mp4') return { mime: 'video/mp4', extension: 'mp4' };
  }
  switch (kind) {
    case 'image': return { mime: 'image/jpeg', extension: 'jpg' };
    case 'voice': return { mime: 'audio/silk', extension: 'silk' };
    case 'video': return { mime: 'video/mp4', extension: 'mp4' };
    default: return { mime: 'application/octet-stream', extension: 'bin' };
  }
}

/**
 * Download + decrypt a CDN media reference. full_url wins when present;
 * otherwise the /download endpoint is used with encrypt_query_param.
 */
export async function downloadCdnMedia(
  media: CdnMediaRef,
  options: { cdnBaseUrl?: string; maxBytes?: number } = {},
): Promise<DownloadedMedia> {
  if (!media.aes_key) {
    throw new Error('CDN media is missing aes_key');
  }
  const cdnBaseUrl = options.cdnBaseUrl ?? WECHAT_CDN_BASE_URL;
  const url = media.full_url
    ?? (media.encrypt_query_param
      ? buildCdnDownloadUrl(media.encrypt_query_param, cdnBaseUrl)
      : undefined);
  if (!url) {
    throw new Error('CDN media has neither full_url nor encrypt_query_param');
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDN download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const encrypted = Buffer.from(await response.arrayBuffer());
  const maxBytes = options.maxBytes ?? MAX_WECHAT_MEDIA_BYTES;
  if (encrypted.length > maxBytes) {
    throw new Error(`CDN media exceeds ${maxBytes} bytes (got ${encrypted.length})`);
  }
  const key = parseAesKey(media.aes_key);
  const buffer = decryptAesEcb(encrypted, key);
  return { buffer, mime: 'application/octet-stream', extension: 'bin', bytes: buffer.length };
}
