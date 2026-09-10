import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  NETWORK_CAPABILITY_LIMITS,
  NetworkDisplayNameSchema,
  createNetworkDownloadFailure,
  decodeNetworkDownloadRequest,
  type NetworkDownloadFailure,
  type NetworkDownloadRequest,
  type NetworkDownloadSuccess,
} from '../engine/runtime/NetworkCapabilityContract.js';
import { inspectExternalNavigationUrl } from '../engine/security/ExternalNavigation.js';

const MAX_RESPONSE_HEADER_BYTES = 32 * 1024;
const PDF_MEDIA_TYPE = 'application/pdf';
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RAW_CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f-\u009f]/u;  // eslint-disable-line no-control-regex
const INVISIBLE_FORMAT = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;
const ENCODED_CONTROL_OR_BACKSLASH = /%(?:25)*(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu;
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

type UrlPolicy = 'clean-url' | 'controlled-source';

export interface ControlledSourceResolution {
  url: string | URL;
  displayName?: string;
}

export type ControlledSourceResolver = (
  sourceId: string,
) => Promise<ControlledSourceResolution | null>;

export interface SecureDownloadServiceOptions {
  sourceResolver?: ControlledSourceResolver;
}

export interface SecureDownloadDestination {
  directory: string;
  displayName: string;
}

export type SecureDownloadServiceResult =
  | {
      ok: true;
      publicResult: NetworkDownloadSuccess;
      /** Main-process-only canonical local path. Never return this field across IPC. */
      resolvedPath: string;
    }
  | {
      ok: false;
      publicResult: NetworkDownloadFailure;
    };

interface DownloadedPayload {
  mediaType: string;
  byteLength: number;
  sha256: string;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

class SecureDownloadInternalError extends Error {
  constructor() {
    super('Secure download unavailable');
    this.name = 'SecureDownloadInternalError';
  }
}

class BoundedHashTransform extends Transform {
  readonly #maximumBytes: number;
  readonly #hash = createHash('sha256');
  #byteLength = 0;
  #prefix = Buffer.alloc(0);

  constructor(maximumBytes: number) {
    super();
    this.#maximumBytes = maximumBytes;
  }

  override _transform(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk);
    const nextLength = this.#byteLength + buffer.byteLength;
    if (nextLength > this.#maximumBytes) {
      callback(new SecureDownloadInternalError());
      return;
    }

    this.#byteLength = nextLength;
    this.#hash.update(buffer);
    if (this.#prefix.byteLength < PDF_MAGIC.byteLength) {
      const remaining = PDF_MAGIC.byteLength - this.#prefix.byteLength;
      this.#prefix = Buffer.concat([this.#prefix, buffer.subarray(0, remaining)]);
    }
    callback(null, buffer);
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  get prefix(): Buffer {
    return Buffer.from(this.#prefix);
  }

  digestSha256(): string {
    return this.#hash.digest('hex');
  }
}

function fixedFailure(): SecureDownloadServiceResult {
  return { ok: false, publicResult: createNetworkDownloadFailure() };
}

function normalizeContentType(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const mediaType = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType || null;
}

function responseHeaderBytes(rawHeaders: string[]): number {
  return rawHeaders.reduce(
    (total, value) => total + Buffer.byteLength(value, 'utf8') + 2,
    0,
  );
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? bytes
    : null;
}

function isBlockedIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (!bytes) return true;
  const [a = 0, b = 0, c = 0, d = 0] = bytes;

  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || (a === 168 && b === 63 && c === 129 && d === 16)
    || a >= 224
  );
}

function parseIpv6(address: string): number[] | null {
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) return null;

  let normalized = address.toLowerCase();
  const ipv4TailMatch = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u);
  if (ipv4TailMatch?.[1]) {
    const ipv4 = parseIpv4(ipv4TailMatch[1]);
    if (!ipv4) return null;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    normalized = `${normalized.slice(0, -ipv4TailMatch[1].length)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const values = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part || '0', 16));
  if (
    values.length !== 8
    || values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)
  ) {
    return null;
  }
  return values;
}

function isBlockedIpv6(address: string): boolean {
  const words = parseIpv6(address);
  if (!words) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = words;

  const unspecifiedOrLoopback = a === 0 && b === 0 && c === 0 && d === 0
    && e === 0 && f === 0 && g === 0 && (h === 0 || h === 1);
  if (unspecifiedOrLoopback) return true;

  const ipv4Mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  if (ipv4Mapped) {
    return isBlockedIpv4(`${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`);
  }

  const ipv4Compatible = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0;
  if (ipv4Compatible) return true;

  return (
    (a & 0xfe00) === 0xfc00
    || (a & 0xffc0) === 0xfe80
    || (a & 0xffc0) === 0xfec0
    || (a & 0xff00) === 0xff00
    || (a === 0x0100 && b === 0 && c === 0 && d === 0)
    || (a === 0x0064 && b === 0xff9b)
    || (a === 0x2001 && b === 0x0000)
    || (a === 0x2001 && b === 0x0002)
    || (a === 0x2001 && b === 0x0db8)
    || a === 0x2002
    || (a === 0x3fff && (b & 0xf000) === 0)
  );
}

function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return METADATA_HOSTNAMES.has(normalized)
    || normalized.endsWith('.internal')
    || normalized.endsWith('.localhost')
    || normalized === 'localhost';
}

function inspectControlledSourceUrl(raw: string | URL): URL | null {
  const text = raw instanceof URL ? raw.toString() : raw;
  if (
    typeof text !== 'string'
    || text.length === 0
    || text.length > NETWORK_CAPABILITY_LIMITS.urlChars
    || RAW_CONTROL_OR_WHITESPACE.test(text)
    || INVISIBLE_FORMAT.test(text)
    || text.includes('\\')
    || INVALID_PERCENT_ESCAPE.test(text)
    || ENCODED_CONTROL_OR_BACKSLASH.test(text)
  ) {
    return null;
  }

  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:'
      || !url.hostname
      || url.username
      || url.password
      || url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function inspectDownloadUrl(raw: string | URL, policy: UrlPolicy): URL | null {
  if (policy === 'controlled-source') return inspectControlledSourceUrl(raw);
  const text = raw instanceof URL ? raw.toString() : raw;
  const decision = inspectExternalNavigationUrl(text);
  return decision.ok ? new URL(decision.url) : null;
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SecureDownloadInternalError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SecureDownloadInternalError()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SecureDownloadService {
  readonly #sourceResolver?: ControlledSourceResolver;

  constructor(options: SecureDownloadServiceOptions = {}) {
    this.#sourceResolver = options.sourceResolver;
  }

  async download(
    input: unknown,
    destination: SecureDownloadDestination,
  ): Promise<SecureDownloadServiceResult> {
    const decoded = decodeNetworkDownloadRequest(input);
    if (!decoded.ok) return fixedFailure();

    const displayName = NetworkDisplayNameSchema.safeParse(destination?.displayName);
    if (
      !displayName.success
      || typeof destination?.directory !== 'string'
      || !path.isAbsolute(destination.directory)
    ) {
      return fixedFailure();
    }

    let tempPath: string | null = null;
    try {
      const deadline = Date.now() + decoded.value.timeoutMs;
      const initial = await withDeadline(this.#resolveInitialUrl(decoded.value), deadline);
      if (!initial) return fixedFailure();

      await fs.promises.mkdir(destination.directory, { recursive: true });
      const canonicalDirectory = await fs.promises.realpath(destination.directory);
      const stat = await fs.promises.stat(canonicalDirectory);
      if (!stat.isDirectory()) return fixedFailure();

      const storageId = randomBytes(18).toString('base64url');
      const extension = decoded.value.resource === 'pdf' ? '.pdf' : '.bin';
      tempPath = path.join(canonicalDirectory, `.download-${storageId}.part`);
      const finalPath = path.join(canonicalDirectory, `download-${storageId}${extension}`);
      const payload = await this.#downloadToTemp(
        initial.url,
        initial.policy,
        decoded.value,
        tempPath,
        deadline,
        0,
      );

      await fs.promises.rename(tempPath, finalPath);
      tempPath = null;
      return {
        ok: true,
        publicResult: {
          success: true,
          code: 'network_download_complete',
          displayName: displayName.data,
          mediaType: payload.mediaType,
          byteLength: payload.byteLength,
          sha256: payload.sha256,
        },
        resolvedPath: finalPath,
      };
    } catch {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => undefined);
      return fixedFailure();
    }
  }

  async #resolveInitialUrl(
    request: NetworkDownloadRequest,
  ): Promise<{ url: URL; policy: UrlPolicy } | null> {
    if (request.mode === 'clean-url') {
      const url = inspectDownloadUrl(request.url, 'clean-url');
      return url ? { url, policy: 'clean-url' } : null;
    }
    if (!this.#sourceResolver) return null;

    const resolution = await this.#sourceResolver(request.sourceId);
    if (!resolution) return null;
    const url = inspectDownloadUrl(resolution.url, 'controlled-source');
    return url ? { url, policy: 'controlled-source' } : null;
  }

  async #resolvePublicAddress(url: URL, deadline: number): Promise<ResolvedAddress> {
    const hostname = normalizedHostname(url);
    if (!hostname || isBlockedHostname(hostname)) throw new SecureDownloadInternalError();

    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await withDeadline(lookup(hostname, { all: true, verbatim: true }), deadline);
    if (
      addresses.length === 0
      || addresses.some(({ address, family }) => isBlockedAddress(address, family))
    ) {
      throw new SecureDownloadInternalError();
    }

    const selected = addresses[0];
    if (!selected || (selected.family !== 4 && selected.family !== 6)) {
      throw new SecureDownloadInternalError();
    }
    return { address: selected.address, family: selected.family };
  }

  async #downloadToTemp(
    url: URL,
    policy: UrlPolicy,
    request: NetworkDownloadRequest,
    tempPath: string,
    deadline: number,
    redirects: number,
  ): Promise<DownloadedPayload> {
    const checkedUrl = inspectDownloadUrl(url, policy);
    if (!checkedUrl) throw new SecureDownloadInternalError();
    const resolved = await this.#resolvePublicAddress(checkedUrl, deadline);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SecureDownloadInternalError();

    const hostname = normalizedHostname(checkedUrl);
    const port = checkedUrl.port ? Number(checkedUrl.port) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new SecureDownloadInternalError();
    }

    return new Promise<DownloadedPayload>((resolve, reject) => {
      let settled = false;
      let delegatedToRedirect = false;
      const finish = (error: unknown, result?: DownloadedPayload) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (error || !result) reject(new SecureDownloadInternalError());
        else resolve(result);
      };

      const options: https.RequestOptions = {
        protocol: 'https:',
        hostname: resolved.address,
        family: resolved.family,
        port,
        method: 'GET',
        path: `${checkedUrl.pathname}${checkedUrl.search}`,
        maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
        headers: {
          Host: checkedUrl.host,
          Accept: request.resource === 'pdf'
            ? PDF_MEDIA_TYPE
            : request.allowedContentTypes.join(', '),
          'Accept-Encoding': 'identity',
          'User-Agent': 'Metis-SecureDownload/1.0',
          Connection: 'close',
        },
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      };

      const clientRequest = https.request(options, (response) => {
        void (async () => {
          if (responseHeaderBytes(response.rawHeaders) > MAX_RESPONSE_HEADER_BYTES) {
            response.destroy();
            throw new SecureDownloadInternalError();
          }

          const status = response.statusCode ?? 0;
          if (REDIRECT_STATUSES.has(status)) {
            const location = response.headers.location;
            if (!location || redirects >= request.maxRedirects) {
              response.destroy();
              throw new SecureDownloadInternalError();
            }
            let redirected: URL;
            try {
              redirected = new URL(location, checkedUrl);
            } catch {
              response.destroy();
              throw new SecureDownloadInternalError();
            }
            clearTimeout(totalTimer);
            clientRequest.setTimeout(0);
            delegatedToRedirect = true;
            response.destroy();
            return this.#downloadToTemp(
              redirected,
              policy,
              request,
              tempPath,
              deadline,
              redirects + 1,
            );
          }

          if (status < 200 || status >= 300) {
            response.destroy();
            throw new SecureDownloadInternalError();
          }

          const contentEncoding = response.headers['content-encoding'];
          if (contentEncoding && contentEncoding !== 'identity') {
            response.destroy();
            throw new SecureDownloadInternalError();
          }

          const mediaType = normalizeContentType(response.headers['content-type']);
          const allowedContentTypes = request.resource === 'pdf'
            ? [PDF_MEDIA_TYPE]
            : request.allowedContentTypes;
          if (!mediaType || !allowedContentTypes.includes(mediaType)) {
            response.destroy();
            throw new SecureDownloadInternalError();
          }

          const contentLengthHeader = response.headers['content-length'];
          if (contentLengthHeader !== undefined) {
            const contentLength = Number(contentLengthHeader);
            if (
              !Number.isInteger(contentLength)
              || contentLength < 1
              || contentLength > request.maxBytes
            ) {
              response.destroy();
              throw new SecureDownloadInternalError();
            }
          }

          const meter = new BoundedHashTransform(request.maxBytes);
          const output = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
          await pipeline(response, meter, output);
          if (meter.byteLength < 1) throw new SecureDownloadInternalError();
          if (request.resource === 'pdf' && !meter.prefix.equals(PDF_MAGIC)) {
            throw new SecureDownloadInternalError();
          }
          return {
            mediaType,
            byteLength: meter.byteLength,
            sha256: meter.digestSha256(),
          };
        })().then(
          (result) => finish(null, result),
          (error) => finish(error),
        );
      });

      const totalTimer = setTimeout(() => {
        clientRequest.destroy(new SecureDownloadInternalError());
        finish(new SecureDownloadInternalError());
      }, remaining);
      clientRequest.setTimeout(Math.min(15_000, remaining), () => {
        clientRequest.destroy(new SecureDownloadInternalError());
      });
      clientRequest.on('error', (error) => {
        if (!delegatedToRedirect) finish(error);
      });
      clientRequest.end();
    });
  }
}
