/**
 * Pure external-navigation URL policy shared by renderer presentation and the
 * Electron main process.  This module intentionally has no DOM or Electron
 * dependencies.
 */

export const MAX_EXTERNAL_NAVIGATION_URL_LENGTH = 2048;

export type ExternalNavigationRejectReason =
  | 'not-string'
  | 'empty'
  | 'too-long'
  | 'whitespace'
  | 'control-character'
  | 'backslash'
  | 'invalid-percent-encoding'
  | 'encoded-control'
  | 'encoded-metadata'
  | 'protocol'
  | 'query'
  | 'fragment'
  | 'userinfo'
  | 'invalid-url'
  | 'missing-host';

export type ExternalNavigationDecision =
  | { ok: true; url: string; display: string }
  | { ok: false; reason: ExternalNavigationRejectReason };

const RAW_WHITESPACE = /\s/u;
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const INVISIBLE_FORMAT = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;

// Detect one or more layers of percent encoding.  For example, `%3F`,
// `%253F`, and `%25253F` all resolve to the query delimiter `?` after bounded
// decoding.  Metadata delimiters are forbidden even in a path because a later
// decoder or redirect could reinterpret them as userinfo/query/fragment data.
const ENCODED_CONTROL_OR_BACKSLASH = /%(?:25)*(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu;
const ENCODED_METADATA = /%(?:25)*(?:23|26|3a|3d|3f|40)/iu;

function reject(reason: ExternalNavigationRejectReason): ExternalNavigationDecision {
  return { ok: false, reason };
}

function safeDisplay(url: URL): string {
  const pathname = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}${pathname}`;
}

/**
 * Inspect an untrusted value without throwing or echoing it into an error.
 * Only clean, absolute HTTPS URLs without userinfo, query, or fragment data
 * are accepted.  Accepted URLs are returned in WHATWG canonical form.
 */
export function inspectExternalNavigationUrl(raw: unknown): ExternalNavigationDecision {
  if (typeof raw !== 'string') return reject('not-string');
  if (raw.length === 0) return reject('empty');
  if (raw.length > MAX_EXTERNAL_NAVIGATION_URL_LENGTH) return reject('too-long');
  if (RAW_WHITESPACE.test(raw)) return reject('whitespace');
  if (RAW_CONTROL.test(raw) || INVISIBLE_FORMAT.test(raw)) return reject('control-character');
  if (raw.includes('\\')) return reject('backslash');
  if (INVALID_PERCENT_ESCAPE.test(raw)) return reject('invalid-percent-encoding');
  if (ENCODED_CONTROL_OR_BACKSLASH.test(raw)) return reject('encoded-control');
  if (ENCODED_METADATA.test(raw)) return reject('encoded-metadata');
  if (!/^https:\/\//iu.test(raw)) return reject('protocol');
  if (raw.includes('?')) return reject('query');
  if (raw.includes('#')) return reject('fragment');

  const afterScheme = raw.slice('https://'.length);
  const authorityEnd = afterScheme.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (!authority) return reject('missing-host');
  if (authority.includes('@')) return reject('userinfo');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return reject('invalid-url');
  }

  if (parsed.protocol !== 'https:') return reject('protocol');
  if (!parsed.hostname) return reject('missing-host');
  if (parsed.username || parsed.password) return reject('userinfo');
  if (parsed.search) return reject('query');
  if (parsed.hash) return reject('fragment');

  const url = parsed.toString();
  return { ok: true, url, display: safeDisplay(parsed) };
}

export class ExternalNavigationUrlError extends TypeError {
  readonly reason: ExternalNavigationRejectReason;

  constructor(reason: ExternalNavigationRejectReason) {
    super(`External navigation URL rejected: ${reason}`);
    this.name = 'ExternalNavigationUrlError';
    this.reason = reason;
  }
}

/**
 * Return the canonical URL or throw a fixed, non-secret-bearing error.
 */
export function requireExternalNavigationUrl(raw: unknown): string {
  const decision = inspectExternalNavigationUrl(raw);
  if (!decision.ok) throw new ExternalNavigationUrlError(decision.reason);
  return decision.url;
}
