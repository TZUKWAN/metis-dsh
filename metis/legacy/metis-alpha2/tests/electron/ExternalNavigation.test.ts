import { describe, expect, it } from 'vitest';
import {
  ExternalNavigationUrlError,
  MAX_EXTERNAL_NAVIGATION_URL_LENGTH,
  inspectExternalNavigationUrl,
  requireExternalNavigationUrl,
} from '../../engine/security/ExternalNavigation.js';

describe('external navigation URL policy', () => {
  it('accepts and canonicalizes only a clean absolute HTTPS URL', () => {
    expect(inspectExternalNavigationUrl('https://Example.COM:443/a/../paper')).toEqual({
      ok: true,
      url: 'https://example.com/paper',
      display: 'https://example.com/paper',
    });
    expect(inspectExternalNavigationUrl('https://example.com')).toEqual({
      ok: true,
      url: 'https://example.com/',
      display: 'https://example.com',
    });
  });

  it('canonicalizes a Unicode hostname to ASCII punycode', () => {
    const decision = inspectExternalNavigationUrl('https://例子.测试/论文');
    expect(decision).toEqual({
      ok: true,
      url: 'https://xn--fsqu00a.xn--0zwm56d/%E8%AE%BA%E6%96%87',
      display: 'https://xn--fsqu00a.xn--0zwm56d/%E8%AE%BA%E6%96%87',
    });
  });

  it.each([
    null,
    undefined,
    42,
    true,
    {},
    new URL('https://example.com'),
  ])('rejects a non-string input: %j', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'not-string' });
  });

  it('rejects empty and overlength input', () => {
    expect(inspectExternalNavigationUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(inspectExternalNavigationUrl(
      `https://example.com/${'a'.repeat(MAX_EXTERNAL_NAVIGATION_URL_LENGTH)}`,
    )).toEqual({ ok: false, reason: 'too-long' });
  });

  it.each([
    ' https://example.com',
    'https://example.com ',
    'https://example.com/a b',
    'https://example.com/\tpath',
    'https://example.com/\npath',
  ])('rejects raw whitespace: %j', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'whitespace' });
  });

  it.each([
    'https://example.com/\u0000path',
    'https://example.com/\u007fpath',
    'https://example.com/\u202epath',
    'https://example.com/\u200bpath',
  ])('rejects raw control or invisible formatting characters: %j', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'control-character' });
  });

  it.each([
    'https:\\example.com\\paper',
    'https://example.com\\@attacker.test',
  ])('rejects a raw backslash: %j', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'backslash' });
  });

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,secret',
    'file:///C:/private.txt',
    'mailto:researcher@example.com',
    '//example.com/path',
    '/relative/path',
    'https:example.com/path',
  ])('rejects a dangerous, unknown, or non-absolute protocol: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'protocol' });
  });

  it.each([
    'https://user@example.com/path',
    'https://user:password@example.com/path',
    'https://@example.com/path',
  ])('rejects URL userinfo: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'userinfo' });
  });

  it.each([
    'https://example.com/path?',
    'https://example.com/path?token=secret',
  ])('rejects any query delimiter or data: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'query' });
  });

  it.each([
    'https://example.com/path#',
    'https://example.com/path#private',
  ])('rejects any fragment delimiter or data: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'fragment' });
  });

  it.each([
    'https://example.com/%3Ftoken=secret',
    'https://example.com/%253Ftoken=secret',
    'https://example.com/%25253Ftoken=secret',
    'https://example.com/%23fragment',
    'https://example.com/%2523fragment',
    'https://example.com/user%40host',
    'https://example.com/user%2540host',
    'https://example.com/key%3Dvalue',
    'https://example.com/a%26b',
    'https://example.com/time%3Avalue',
  ])('rejects percent- or double-encoded URL metadata: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'encoded-metadata' });
  });

  it.each([
    'https://example.com/%00',
    'https://example.com/%250A',
    'https://example.com/%25250D',
    'https://example.com/%7f',
    'https://example.com/%5Cpath',
    'https://example.com/%255cpath',
  ])('rejects percent- or double-encoded controls and backslashes: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({ ok: false, reason: 'encoded-control' });
  });

  it.each([
    'https://example.com/%',
    'https://example.com/%2',
    'https://example.com/%zz',
  ])('rejects malformed percent escapes: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw)).toEqual({
      ok: false,
      reason: 'invalid-percent-encoding',
    });
  });

  it.each([
    'https://',
    'https:///example.com/path',
    'https://:443/path',
  ])('rejects a missing or invalid host: %s', (raw) => {
    expect(inspectExternalNavigationUrl(raw).ok).toBe(false);
  });

  it('returns the canonical string from requireExternalNavigationUrl', () => {
    expect(requireExternalNavigationUrl('HTTPS://Example.COM:443/paper')).toBe(
      'https://example.com/paper',
    );
  });

  it('throws a typed, non-secret-bearing error for rejected input', () => {
    const raw = 'https://example.com/path?token=do-not-echo-this-secret';
    let caught: unknown;
    try {
      requireExternalNavigationUrl(raw);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ExternalNavigationUrlError);
    expect(caught).toMatchObject({ reason: 'query' });
    expect(String(caught)).not.toContain('do-not-echo-this-secret');
  });
});
