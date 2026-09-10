/**
 * @vitest-environment node
 *
 * WeChat CDN media codec tests: AES key parsing (both encodings), AES-128-ECB
 * round trip, CDN URL building, and download+decrypt against a local mock.
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  parseAesKey,
  decryptAesEcb,
  buildCdnDownloadUrl,
  downloadCdnMedia,
  mediaKindToMime,
} from '../../engine/im/MediaCodec.js';

function aesEcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

describe('WeChat media codec', () => {
  it('parses raw 16-byte base64 keys (image style)', () => {
    const raw = randomBytes(16);
    const key = parseAesKey(raw.toString('base64'));
    expect(key).toEqual(raw);
  });

  it('parses hex-string-in-base64 keys (file/voice/video style)', () => {
    const raw = randomBytes(16);
    const hex = raw.toString('hex');
    const key = parseAesKey(Buffer.from(hex, 'ascii').toString('base64'));
    expect(key).toEqual(raw);
  });

  it('rejects malformed keys', () => {
    expect(() => parseAesKey(Buffer.from('too-short').toString('base64'))).toThrow();
    expect(() => parseAesKey(Buffer.from('not-hex-not-hex-not-hex!!', 'ascii').toString('base64'))).toThrow();
  });

  it('decrypts AES-128-ECB ciphertext (PKCS7)', () => {
    const key = randomBytes(16);
    const plain = Buffer.from('微信图片解密验证 payload');
    const cipher = aesEcbEncrypt(plain, key);
    const decrypted = decryptAesEcb(cipher, key);
    expect(decrypted.toString('utf-8')).toBe('微信图片解密验证 payload');
  });

  it('builds the CDN download URL with encoded query param', () => {
    const url = buildCdnDownloadUrl('abc+def/==', 'https://novac2c.cdn.weixin.qq.com/c2c');
    expect(url).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc%2Bdef%2F%3D%3D');
  });

  it('downloads and decrypts a media file from the CDN (full_url)', async () => {
    const key = randomBytes(16);
    const plain = Buffer.from('hello media file');
    const cipher = aesEcbEncrypt(plain, key);

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(cipher);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    try {
      const result = await downloadCdnMedia(
        { full_url: `http://127.0.0.1:${address.port}/media`, aes_key: key.toString('base64') },
        { cdnBaseUrl: 'http://127.0.0.1:1/c2c' },
      );
      expect(result.buffer.toString('utf-8')).toBe('hello media file');
      expect(result.bytes).toBe(plain.length);
    } finally {
      server.close();
    }
  });

  it('falls back to the /download endpoint when full_url is absent', async () => {
    const key = randomBytes(16);
    const cipher = aesEcbEncrypt(Buffer.from('fallback route'), key);

    const server = http.createServer((req, res) => {
      expect(req.url).toContain('/download?encrypted_query_param=');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(cipher);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    try {
      const result = await downloadCdnMedia(
        { encrypt_query_param: 'enc-param', aes_key: key.toString('base64') },
        { cdnBaseUrl: `http://127.0.0.1:${address.port}/c2c` },
      );
      expect(result.buffer.toString('utf-8')).toBe('fallback route');
    } finally {
      server.close();
    }
  });

  it('maps media kinds to mime types with file name priority', () => {
    expect(mediaKindToMime('image')).toEqual({ mime: 'image/jpeg', extension: 'jpg' });
    expect(mediaKindToMime('file', 'report.pdf')).toEqual({ mime: 'application/pdf', extension: 'pdf' });
    expect(mediaKindToMime('voice', 'voice.silk')).toEqual({ mime: 'audio/silk', extension: 'silk' });
    expect(mediaKindToMime('video', 'clip.mp4')).toEqual({ mime: 'video/mp4', extension: 'mp4' });
    expect(mediaKindToMime('file', 'notes.md')).toEqual({ mime: 'text/markdown', extension: 'md' });
  });
});
