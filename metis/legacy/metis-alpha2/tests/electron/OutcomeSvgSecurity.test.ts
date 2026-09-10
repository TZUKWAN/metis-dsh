import { describe, expect, it } from 'vitest';
import {
  exportStandaloneSvg,
  isSafeSvgBuffer,
  MAX_OUTCOME_SVG_BYTES,
  roundTripStandaloneSvg,
} from '../../electron/OutcomeSvgSecurity.js';

const safe = (body = '<rect x="0" y="0" width="10" height="10" fill="#123456"/>') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

describe('OutcomeSvgSecurity', () => {
  it('accepts bounded static SVG with internal fragment references', () => {
    expect(isSafeSvgBuffer(safe('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/>'))).toBe(true);
    expect(isSafeSvgBuffer(safe('<defs><path id="p" d="M0 0h10v10z"/></defs><use href="#p"/>'))).toBe(true);
  });

  it.each([
    ['script element', '<script>alert(1)</script>'],
    ['DOCTYPE', '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///secret">]><text>&xxe;</text>'],
    ['foreignObject', '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'],
    ['event attribute', '<rect width="10" height="10" onclick="alert(1)"/>'],
    ['external href', '<use href="https://example.test/x.svg#p"/>'],
    ['external CSS', '<style>@import url(https://example.test/a.css);</style>'],
    ['data reference', '<rect style="fill:url(data:image/svg+xml,x)"/>'],
    ['javascript reference', '<use href="javascript:alert(1)"/>'],
    ['missing dimensions', '<rect width="10" height="10"/>'],
    ['malformed XML', '<g><rect/></svg>'],
  ])('rejects %s', (_label, body) => {
    expect(isSafeSvgBuffer(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`))).toBe(false);
  });

  it('exports and re-validates a standalone SVG without claiming vector editing', () => {
    const source = safe('<title>静态图</title><rect width="10" height="10" fill="#123456"/>');
    const exported = exportStandaloneSvg(source);
    expect(exported).toMatchObject({ mediaType: 'image/svg+xml', extension: 'svg' });
    expect(exported.bytes).toEqual(source);
    expect(exported.bytes).not.toBe(source);
    const roundTripped = roundTripStandaloneSvg(exported);
    expect(roundTripped).toEqual(source);
    expect(roundTripped).not.toBe(exported.bytes);
  });

  it.each([
    ['tampered export bytes', { mediaType: 'image/svg+xml', extension: 'svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>') }],
    ['wrong media type', { mediaType: 'image/png', extension: 'svg', bytes: safe() }],
    ['wrong extension', { mediaType: 'image/svg+xml', extension: 'png', bytes: safe() }],
  ] as const)('rejects %s at the standalone roundtrip boundary', (_label, exported) => {
    expect(() => roundTripStandaloneSvg(exported as never)).toThrow('svg_not_safe_roundtrip');
  });

  it('rejects invalid UTF-8, control characters, and oversized SVG', () => {
    expect(isSafeSvgBuffer(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff]))).toBe(false);
    expect(isSafeSvgBuffer(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">\u0001</svg>`))).toBe(false);
    expect(isSafeSvgBuffer(Buffer.concat([safe(), Buffer.alloc(MAX_OUTCOME_SVG_BYTES)]))).toBe(false);
  });
});
