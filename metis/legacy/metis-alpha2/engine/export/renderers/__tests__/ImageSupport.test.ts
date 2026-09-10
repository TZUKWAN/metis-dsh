import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateResearchImagePayload } from '../ImageSupport.js';

function payload(mediaType: string, bytes: Buffer) {
  return {
    mediaType,
    base64Data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlV9Z8AAAAASUVORK5CYII=',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9,
]);

describe('Research image validation', () => {
  it.each([
    ['image/png', PNG, 'png'],
    ['image/gif', GIF, 'gif'],
    ['image/jpeg', JPEG, 'jpg'],
  ])('accepts a bounded %s payload with matching signature and digest', (mediaType, bytes, extension) => {
    const result = validateResearchImagePayload(payload(mediaType, bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.extension).toBe(extension);
    expect(result.image.widthPx).toBe(1);
    expect(result.image.heightPx).toBe(1);
    expect(result.image.bytes).toEqual(bytes);
  });

  it('rejects a declared media type that disagrees with the bytes', () => {
    const result = validateResearchImagePayload(payload('image/jpeg', PNG));
    expect(result.ok).toBe(false);
  });

  it('rejects a non-canonical base64 payload before decoding', () => {
    const valid = payload('image/png', PNG);
    const result = validateResearchImagePayload({ ...valid, base64Data: `${valid.base64Data}\n` });
    expect(result.ok).toBe(false);
  });
});
