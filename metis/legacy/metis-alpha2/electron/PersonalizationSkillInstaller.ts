import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { Agent as UndiciAgent, ProxyAgent, type Dispatcher } from 'undici';
import {
  InstalledSkillVersionSchema,
  SKILL_INSTALLATION_LIMITS,
  SKILL_PACKAGE_SCHEMA_VERSION,
  SkillPackageManifestSchema,
  SkillPackagePathSchema,
  type InstalledSkillVersion,
  type SkillInstallationFailureCode,
  type SkillInstallationProvenance,
  type SkillInstallationResult,
  type SkillPackageManifest,
} from '../engine/runtime/SkillInstallationContract.js';

const MANIFEST_FILE = 'metis-skill.json';
const INSTALL_RECORD_FILE = 'metis-install.json';
const ACTIVE_RECORD_FILE = 'active.json';
const ACCEPTED_ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);
const GITHUB_REDIRECT_HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com']);
const INSTALL_LOCK_FORMAT = 'metis-skill-install-lock';
const INSTALL_LOCK_VERSION = 1;
const BLOCKED_SKILL_IPV6 = new net.BlockList();
for (const [subnet, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  // The well-known NAT64 prefix can embed private IPv4 targets (including
  // link-local metadata addresses), so it is not a safe public download
  // destination even though the prefix itself is globally scoped.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_SKILL_IPV6.addSubnet(subnet, prefix, 'ipv6');
}

interface ExtractedFile {
  path: string;
  data: Buffer;
  compressedSize: number;
}

interface ParsedPackage {
  manifest: SkillPackageManifest;
  manifestBytes: Buffer;
  files: ExtractedFile[];
  archiveSha256: string;
}

interface DownloadResult {
  body: Buffer;
  resolvedUrl: string;
  redirectChain: string[];
}

export interface PersonalizationSkillInstallerOptions {
  fetch?: typeof fetch;
  lookup?: typeof dnsLookup;
  now?: () => number;
  timeoutMs?: number;
  maxArchiveBytes?: number;
  /** 出站代理（http://host:port）。缺省读取 HTTPS_PROXY/ALL_PROXY 环境变量；DIRECT 环境保持 DNS pin 直连。 */
  proxyUri?: string | null;
}

function defaultProxyUri(): string | null {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = process.env[name];
    if (value && /^http:\/\/[^\s]+$/iu.test(value)) return value;
  }
  return null;
}

interface UrlInstallConstraints {
  expectedArchiveSha256: string | null;
  expectedId: string | null;
  expectedVersion: string | null;
}

interface ActiveRecord {
  schemaVersion: 1;
  id: string;
  activeVersion: string;
  updatedAt: number;
}

class SkillInstallError extends Error {
  readonly code: SkillInstallationFailureCode;

  constructor(code: SkillInstallationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SkillInstallError';
    this.code = code;
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function packageDirectoryName(id: string): string {
  return sha256(id);
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
    : path.resolve(left) === path.resolve(right);
}

function normalizeMediaType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') ?? '';
}

function validateRelativePackagePath(value: string): string {
  const normalized = value.normalize('NFC');
  const parsed = SkillPackagePathSchema.safeParse(normalized);
  if (!parsed.success) throw new SkillInstallError('path_invalid', `Unsafe package path: ${value}`);
  return parsed.data;
}

function sortVersionsDescending(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.+-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return right.localeCompare(left);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isZipSymlink(externalAttributes: number): boolean {
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function decodeZipName(buffer: Buffer, utf8: boolean): string {
  if (!utf8 && buffer.some((byte) => byte > 0x7f)) {
    throw new SkillInstallError('archive_unsupported', 'Non-UTF-8 ZIP file names are not supported');
  }
  const decoded = buffer.toString('utf8');
  if (decoded.includes('\ufffd')) throw new SkillInstallError('archive_invalid', 'ZIP contains an invalid UTF-8 file name');
  return decoded;
}

function locateEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new SkillInstallError('archive_invalid', 'ZIP end-of-central-directory record is missing');
}

function parseZip(archive: Buffer, urlHint?: string): ParsedPackage {
  if (archive.length < 22) throw new SkillInstallError('archive_invalid', 'ZIP archive is truncated');
  const eocd = locateEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new SkillInstallError('archive_unsupported', 'Multi-disk ZIP archives are not supported');
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new SkillInstallError('archive_unsupported', 'ZIP64 archives are not supported');
  }
  if (eocd + 22 + commentLength !== archive.length || centralOffset + centralSize > eocd) {
    throw new SkillInstallError('archive_invalid', 'ZIP directory offsets are invalid');
  }
  if (totalEntries > SKILL_INSTALLATION_LIMITS.files + 64) {
    throw new SkillInstallError('too_many_files', 'ZIP contains too many entries');
  }

  const extracted: ExtractedFile[] = [];
  const names = new Set<string>();
  const localRanges: Array<[number, number]> = [];
  let centralCursor = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (centralCursor + 46 > archive.length || archive.readUInt32LE(centralCursor) !== 0x02014b50) {
      throw new SkillInstallError('archive_invalid', 'ZIP central directory entry is invalid');
    }
    const flags = archive.readUInt16LE(centralCursor + 8);
    const method = archive.readUInt16LE(centralCursor + 10);
    const expectedCrc = archive.readUInt32LE(centralCursor + 16);
    const compressedSize = archive.readUInt32LE(centralCursor + 20);
    const uncompressedSize = archive.readUInt32LE(centralCursor + 24);
    const nameLength = archive.readUInt16LE(centralCursor + 28);
    const extraLength = archive.readUInt16LE(centralCursor + 30);
    const entryCommentLength = archive.readUInt16LE(centralCursor + 32);
    const entryDisk = archive.readUInt16LE(centralCursor + 34);
    const externalAttributes = archive.readUInt32LE(centralCursor + 38);
    const localOffset = archive.readUInt32LE(centralCursor + 42);
    const centralEnd = centralCursor + 46 + nameLength + extraLength + entryCommentLength;
    if (centralEnd > archive.length) throw new SkillInstallError('archive_invalid', 'ZIP central directory is truncated');
    if (entryDisk !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new SkillInstallError('archive_unsupported', 'ZIP64 or multi-disk entries are not supported');
    }
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) throw new SkillInstallError('archive_encrypted', 'Encrypted ZIP entries are not supported');
    if (method !== 0 && method !== 8) throw new SkillInstallError('archive_unsupported', `Unsupported ZIP compression method: ${method}`);
    if (isZipSymlink(externalAttributes)) throw new SkillInstallError('symlink_rejected', 'ZIP symbolic links are not allowed');

    const rawName = archive.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const name = decodeZipName(rawName, (flags & 0x800) !== 0);
    if (name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.includes('\u0000')) {
      throw new SkillInstallError('path_invalid', `ZIP contains an unsafe path: ${name}`);
    }
    const pathWithoutDirectoryMarker = name.endsWith('/') ? name.slice(0, -1) : name;
    if (pathWithoutDirectoryMarker.length > 0) validateRelativePackagePath(pathWithoutDirectoryMarker);
    const folded = name.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(folded)) throw new SkillInstallError('duplicate_path', `Duplicate ZIP path: ${name}`);
    names.add(folded);

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new SkillInstallError('archive_invalid', 'ZIP local header is invalid');
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || localFlags !== flags || localMethod !== method) {
      throw new SkillInstallError('archive_invalid', 'ZIP local and central headers do not match');
    }
    const localName = decodeZipName(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength), (flags & 0x800) !== 0);
    if (localName !== name) throw new SkillInstallError('archive_invalid', 'ZIP local file name does not match its directory entry');
    if (localRanges.some(([start, end]) => dataStart < end && dataEnd > start)) {
      throw new SkillInstallError('archive_invalid', 'ZIP entries contain overlapping payload ranges');
    }
    localRanges.push([dataStart, dataEnd]);

    if (!name.endsWith('/')) {
      if (uncompressedSize > SKILL_INSTALLATION_LIMITS.fileBytes) throw new SkillInstallError('uncompressed_too_large', `File exceeds the extraction limit: ${name}`);
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > SKILL_INSTALLATION_LIMITS.extractedBytes) throw new SkillInstallError('uncompressed_too_large', 'ZIP expands beyond the extraction limit');
      if (compressedSize === 0 && uncompressedSize > 0) throw new SkillInstallError('archive_invalid', `Invalid compressed size for ${name}`);
      if (compressedSize > 0 && uncompressedSize / compressedSize > SKILL_INSTALLATION_LIMITS.compressionRatio) {
        throw new SkillInstallError('compression_ratio_exceeded', `Suspicious ZIP compression ratio for ${name}`);
      }
      const compressed = archive.subarray(dataStart, dataEnd);
      let data: Buffer;
      try {
        data = method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: uncompressedSize + 1 });
      } catch (error) {
        throw new SkillInstallError('archive_invalid', `Unable to decompress ${name}`, { cause: error });
      }
      if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
        throw new SkillInstallError('archive_invalid', `ZIP integrity verification failed for ${name}`);
      }
      extracted.push({ path: name, data, compressedSize });
    }
    centralCursor = centralEnd;
  }
  if (centralCursor !== centralOffset + centralSize) throw new SkillInstallError('archive_invalid', 'ZIP central directory size does not match its entries');
  try {
    return validatePackageFiles(extracted, sha256(archive));
  } catch (error) {
    if (urlHint && error instanceof SkillInstallError && error.code === 'manifest_missing') {
      return bridgeGithubSkillPackage(extracted, sha256(archive), urlHint);
    }
    throw error;
  }
}

const SKILL_DOC_FILENAMES = ['SKILL.md', 'skill.md'] as const;

function bridgeRoleFor(relativePath: string): 'documentation' | 'script' | 'asset' | 'schema' {
  const lower = relativePath.toLocaleLowerCase('en-US');
  if (lower.endsWith('.json')) return 'schema';
  if (/\.(?:py|js|mjs|cjs|ts|sh|ps1|rb|go|rs|java)$/u.test(lower)) return 'script';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'documentation';
  return 'asset';
}

/**
 * GitHub 技能仓库桥接：下载的 zip 没有 metis-skill.json（普通 GitHub/Claude
 * 技能仓库都不带该文件），但存在唯一 SKILL.md 时，以 SKILL.md 所在目录为包
 * 根自动构建 manifest，让市场里的真实技能仓库可以安装。文件列表与哈希来自
 * 下载内容本身，安装校验（digest/CAS/provenance）全部复用主流程。
 */
function bridgeGithubSkillPackage(archiveFiles: ExtractedFile[], archiveSha256: string, urlHint: string): ParsedPackage {
  const docCandidates = archiveFiles.filter((file) => SKILL_DOC_FILENAMES.some((name) => file.path === name || file.path.endsWith(`/${name}`)));
  if (docCandidates.length === 0) {
    throw new SkillInstallError('manifest_missing', 'Neither metis-skill.json nor SKILL.md was found in the archive');
  }
  if (docCandidates.length > 1) {
    throw new SkillInstallError('manifest_ambiguous', 'Archive contains multiple SKILL.md files');
  }
  const doc = docCandidates[0]!;
  const docName = SKILL_DOC_FILENAMES.find((name) => doc.path === name || doc.path.endsWith(`/${name}`))!;
  const prefix = doc.path.slice(0, doc.path.length - docName.length);
  const docRelative = doc.path.slice(prefix.length);
  const isIgnored = (relative: string) => relative.length === 0
    || relative.endsWith('/')
    || relative.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0 || segment.startsWith('.'));
  const payload = archiveFiles
    .filter((file) => file !== doc && file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
    .filter((file) => !isIgnored(file.path));
  if (payload.length + 1 > SKILL_INSTALLATION_LIMITS.files) {
    throw new SkillInstallError('archive_invalid', 'Bridged skill package contains too many files');
  }
  let owner = 'github';
  let repository = 'skill';
  try {
    const parsed = new URL(urlHint);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      owner = parts[0] ?? owner;
      repository = (parts[1] ?? repository).replace(/\.git$/u, '');
    }
  } catch {
    // URL 不可解析时使用缺省命名。
  }
  const docText = doc.data.toString('utf8');
  const frontmatterName = /(?:^|\n)name:[ \t]*(.+)$/mu.exec(docText)?.[1]?.trim();
  const headingName = /^#[ \t]+(.+)$/mu.exec(docText)?.[1]?.trim();
  const name = (frontmatterName || headingName || repository).slice(0, 200);
  const descriptionLine = /(?:^|\n)description:[ \t]*([^\n]+)/u.exec(docText)?.[1]?.trim();
  const description = (descriptionLine || `Skill bridged from ${owner}/${repository}`).slice(0, 4_000);
  const slugSource = `${owner}-${repository}${prefix ? `-${prefix.replace(/\/+$/u, '').replaceAll('/', '-')}` : ''}`;
  const manifest = {
    schemaVersion: SKILL_PACKAGE_SCHEMA_VERSION,
    id: `url:skills/${slugSource.toLocaleLowerCase('en-US').replace(/[^a-z0-9-]+/gu, '-')}`,
    name,
    description,
    version: '1.0.0',
    author: owner,
    license: null,
    entry: validateBridgePath(docRelative),
    systemPromptFile: null,
    files: [
      {
        path: validateBridgePath(docRelative),
        size: doc.data.length,
        sha256: sha256(doc.data),
        role: 'documentation' as const,
        executable: false,
      },
      ...payload.map((file) => ({
        path: validateBridgePath(file.path),
        size: file.data.length,
        sha256: sha256(file.data),
        role: bridgeRoleFor(file.path),
        executable: false,
      })),
    ],
  };
  const decoded = SkillPackageManifestSchema.safeParse(manifest);
  if (!decoded.success) {
    throw new SkillInstallError('manifest_invalid', `Bridged manifest is invalid: ${decoded.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return {
    manifest: decoded.data,
    manifestBytes: Buffer.from(JSON.stringify(manifest), 'utf8'),
    files: [
      { ...doc, path: validateBridgePath(docRelative) },
      ...payload.map((file) => ({ ...file, path: validateBridgePath(file.path) })),
    ],
    archiveSha256,
  };
}

function validateBridgePath(relativePath: string): string {
  const result = SkillPackagePathSchema.safeParse(relativePath);
  if (!result.success) {
    throw new SkillInstallError('file_mismatch', `Bridged package contains an unsafe path: ${relativePath}`);
  }
  return relativePath;
}

function validatePackageFiles(archiveFiles: ExtractedFile[], archiveSha256: string): ParsedPackage {
  const manifestCandidates = archiveFiles.filter((file) => file.path === MANIFEST_FILE || file.path.endsWith(`/${MANIFEST_FILE}`));
  if (manifestCandidates.length === 0) throw new SkillInstallError('manifest_missing', `${MANIFEST_FILE} is missing`);
  if (manifestCandidates.length !== 1) throw new SkillInstallError('manifest_ambiguous', `Package contains multiple ${MANIFEST_FILE} files`);
  const manifestCandidate = manifestCandidates[0];
  if (!manifestCandidate) throw new SkillInstallError('manifest_missing', `${MANIFEST_FILE} is missing`);
  if (manifestCandidate.data.length > SKILL_INSTALLATION_LIMITS.manifestBytes) throw new SkillInstallError('manifest_invalid', 'Skill manifest is too large');
  const prefix = manifestCandidate.path.slice(0, -MANIFEST_FILE.length);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestCandidate.data.toString('utf8')) as unknown;
  } catch (error) {
    throw new SkillInstallError('manifest_invalid', 'Skill manifest is not valid JSON', { cause: error });
  }
  const decoded = SkillPackageManifestSchema.safeParse(rawManifest);
  if (!decoded.success) throw new SkillInstallError('manifest_invalid', decoded.error.issues.map((issue) => issue.message).join('; '));
  const manifest = decoded.data;

  const payload = archiveFiles
    .filter((file) => file !== manifestCandidate)
    .map((file) => {
      if (!file.path.startsWith(prefix)) throw new SkillInstallError('file_mismatch', `File is outside the package root: ${file.path}`);
      return { ...file, path: validateRelativePackagePath(file.path.slice(prefix.length)) };
    });
  const actualByPath = new Map(payload.map((file) => [file.path, file]));
  if (actualByPath.size !== payload.length) throw new SkillInstallError('duplicate_path', 'Package has duplicate payload paths');
  if (payload.length !== manifest.files.length) throw new SkillInstallError('file_mismatch', 'Manifest file list does not match package contents');
  for (const declared of manifest.files) {
    const actual = actualByPath.get(declared.path);
    if (!actual || actual.data.length !== declared.size || sha256(actual.data) !== declared.sha256) {
      throw new SkillInstallError('file_mismatch', `Manifest integrity mismatch for ${declared.path}`);
    }
  }
  return {
    manifest,
    manifestBytes: Buffer.from(manifestCandidate.data),
    files: payload,
    archiveSha256,
  };
}

function isPrivateIp(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 192 && b === 88)
      || (a === 198 && b === 51)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 203 && b === 0);
  }
  if (kind === 6) {
    return BLOCKED_SKILL_IPV6.check(address, 'ipv6');
  }
  return true;
}

interface InstallLockRecord {
  format: typeof INSTALL_LOCK_FORMAT;
  version: typeof INSTALL_LOCK_VERSION;
  pid: number;
  createdAt: number;
  nonce: string;
}

function decodeInstallLock(raw: string): InstallLockRecord | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'createdAt,format,nonce,pid,version'
    || value.format !== INSTALL_LOCK_FORMAT
    || value.version !== INSTALL_LOCK_VERSION
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || typeof value.nonce !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.nonce)) {
    return undefined;
  }
  return value as unknown as InstallLockRecord;
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function normalizeGithubUrl(input: URL): URL {
  if (input.hostname.toLocaleLowerCase('en-US') !== 'github.com') return input;
  const parts = input.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return input;
  const owner = parts[0];
  const repository = parts[1]?.replace(/\.git$/u, '');
  if (!owner || !repository) return input;
  if (parts[2] === 'tree' && parts[3]) {
    const ref = parts.slice(3).join('/');
    return new URL(`https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zip/${ref.split('/').map(encodeURIComponent).join('/')}`);
  }
  if (parts.length === 2) return new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zipball`);
  return input;
}

export class PersonalizationSkillInstaller {
  readonly #root: string;
  readonly #skillsRoot: string;
  readonly #stagingRoot: string;
  readonly #fetch: typeof fetch;
  readonly #lookup: typeof dnsLookup;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #maxArchiveBytes: number;
  readonly #proxyUri: string | null;
  #proxyDispatcher: Dispatcher | null = null;

  #outboundDispatcher(url: URL): Promise<Dispatcher> {
    if (!this.#proxyUri) return this.#pinnedDispatcher(url);
    const proxyUri = this.#proxyUri;
    // 代理模式下仍先做本地解析校验：私网/保留地址目标一律拒绝，防止
    // 把代理当作访问内网的跳板；公网目标交由代理转发。
    return this.#resolvePublicAddress(url).then(() => {
      // 代理 dispatcher 进程级复用：逐跳新建并 close 会因 keep-alive 连接挂起。
      if (this.#proxyDispatcher === null) {
        this.#proxyDispatcher = new ProxyAgent({ uri: proxyUri });
      }
      return this.#proxyDispatcher;
    });
  }

  constructor(root: string, options: PersonalizationSkillInstallerOptions = {}) {
    this.#root = this.#createAndVerifyDirectory(root);
    this.#skillsRoot = this.#createAndVerifyDirectory(path.join(this.#root, 'skills'));
    this.#stagingRoot = this.#createAndVerifyDirectory(path.join(this.#root, '.staging'));
    this.#fetch = options.fetch ?? fetch;
    this.#lookup = options.lookup ?? dnsLookup;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? SKILL_INSTALLATION_LIMITS.downloadTimeoutMs;
    this.#maxArchiveBytes = options.maxArchiveBytes ?? SKILL_INSTALLATION_LIMITS.archiveBytes;
    this.#proxyUri = options.proxyUri === undefined ? defaultProxyUri() : options.proxyUri;
  }

  installFromPackage(sourcePath: string): SkillInstallationResult {
    try {
      const parsed = this.#readLocalPackage(sourcePath);
      return this.#publish(parsed, {
        sourceMode: 'package',
        sourceUrl: null,
        resolvedUrl: null,
        redirectChain: [],
        archiveSha256: parsed.archiveSha256,
        manifestSha256: sha256(parsed.manifestBytes),
        installedAt: this.#now(),
      });
    } catch (error) {
      return this.#failure(error);
    }
  }

  async installFromUrl(rawUrl: string, constraints: Partial<UrlInstallConstraints> = {}): Promise<SkillInstallationResult> {
    try {
      const originalUrl = this.#parseRemoteUrl(rawUrl);
      const normalizedUrl = normalizeGithubUrl(originalUrl);
      const downloaded = await this.#download(normalizedUrl);
      const parsed = parseZip(downloaded.body, originalUrl.toString());
      if (constraints.expectedArchiveSha256 && constraints.expectedArchiveSha256 !== parsed.archiveSha256) {
        throw new SkillInstallError('digest_mismatch', 'Downloaded archive digest does not match the expected digest');
      }
      if (constraints.expectedId && constraints.expectedId !== parsed.manifest.id) {
        throw new SkillInstallError('id_mismatch', 'Downloaded skill ID does not match the requested skill');
      }
      if (constraints.expectedVersion && constraints.expectedVersion !== parsed.manifest.version) {
        throw new SkillInstallError('version_mismatch', 'Downloaded skill version does not match the requested version');
      }
      return this.#publish(parsed, {
        sourceMode: 'url',
        sourceUrl: originalUrl.toString(),
        resolvedUrl: downloaded.resolvedUrl,
        redirectChain: downloaded.redirectChain,
        archiveSha256: parsed.archiveSha256,
        manifestSha256: sha256(parsed.manifestBytes),
        installedAt: this.#now(),
      });
    } catch (error) {
      return this.#failure(error);
    }
  }

  async updateFromUrl(id: string, rawUrl?: string, expectedArchiveSha256: string | null = null): Promise<SkillInstallationResult> {
    const versions = this.listInstalled(id);
    if (versions.length === 0) return { ok: false, code: 'not_found', message: 'Installed skill was not found' };
    const active = versions.find((version) => version.active) ?? versions[0];
    const sourceUrl = rawUrl ?? active?.provenance.sourceUrl;
    if (!sourceUrl) return { ok: false, code: 'url_invalid', message: 'Installed skill has no update URL' };
    return this.installFromUrl(sourceUrl, { expectedArchiveSha256, expectedId: id });
  }

  listInstalled(id?: string): InstalledSkillVersion[] {
    const records: InstalledSkillVersion[] = [];
    for (const packageDir of this.#safeChildDirectories(this.#skillsRoot)) {
      const versionsRoot = path.join(packageDir, 'versions');
      const active = this.#readActiveRecord(packageDir);
      for (const versionDir of this.#safeChildDirectories(versionsRoot, true)) {
        const record = this.#readInstallRecord(versionDir);
        if (!record || (id !== undefined && record.id !== id)) continue;
        records.push({ ...record, active: active?.id === record.id && active.activeVersion === record.version });
      }
    }
    return records.sort((left, right) => left.id.localeCompare(right.id) || sortVersionsDescending(left.version, right.version));
  }

  getInstalled(id: string, version?: string): InstalledSkillVersion | undefined {
    const installed = this.listInstalled(id);
    return version === undefined
      ? installed.find((entry) => entry.active) ?? installed[0]
      : installed.find((entry) => entry.version === version);
  }

  setActiveVersion(id: string, version: string): SkillInstallationResult {
    try {
      const installed = this.getInstalled(id, version);
      if (!installed) throw new SkillInstallError('version_not_found', 'Installed skill version was not found');
      const packageRoot = this.#packageRoot(id);
      return this.#withPackageLock(packageRoot, () => {
        const current = this.getInstalled(id, version);
        if (!current) throw new SkillInstallError('version_not_found', 'Installed skill version was not found');
        this.#writeActiveRecord(packageRoot, {
          schemaVersion: 1,
          id,
          activeVersion: version,
          updatedAt: this.#now(),
        });
        return { ok: true, installed: { ...current, active: true } };
      });
    } catch (error) {
      return this.#failure(error);
    }
  }

  uninstall(id: string, version?: string): { ok: true; removedVersions: string[] } | { ok: false; code: SkillInstallationFailureCode; message: string } {
    try {
      const installed = this.listInstalled(id);
      if (installed.length === 0) throw new SkillInstallError('not_found', 'Installed skill was not found');
      const packageRoot = this.#packageRoot(id);
      return this.#withPackageLock(packageRoot, () => {
        const currentInstalled = this.listInstalled(id);
        const selected = version === undefined ? currentInstalled : currentInstalled.filter((entry) => entry.version === version);
        if (selected.length === 0) throw new SkillInstallError('version_not_found', 'Installed skill version was not found');
        for (const entry of selected) this.#removeContainedTree(this.#versionDirectory(entry.id, entry.version));
        const remaining = this.listInstalled(id);
        if (remaining.length === 0) {
          const activePath = path.join(packageRoot, ACTIVE_RECORD_FILE);
          if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
          const versionsRoot = path.join(packageRoot, 'versions');
          if (fs.existsSync(versionsRoot)) fs.rmdirSync(versionsRoot);
        } else {
          const currentActive = remaining.find((entry) => entry.active);
          const next = currentActive ?? remaining[0];
          if (!next) throw new SkillInstallError('uninstall_failed', 'Unable to choose a remaining active version');
          this.#writeActiveRecord(packageRoot, {
            schemaVersion: 1,
            id,
            activeVersion: next.version,
            updatedAt: this.#now(),
          });
        }
        return { ok: true as const, removedVersions: selected.map((entry) => entry.version) };
      });
    } catch (error) {
      const failure = this.#failure(error);
      return failure.ok ? { ok: false, code: 'uninstall_failed', message: 'Unexpected uninstall result' } : failure;
    }
  }

  #readLocalPackage(sourcePath: string): ParsedPackage {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(sourcePath);
    } catch (error) {
      throw new SkillInstallError('source_missing', 'Skill package was not found', { cause: error });
    }
    if (stat.isSymbolicLink()) throw new SkillInstallError('source_symlink', 'Symbolic-link skill packages are not allowed');
    if (stat.isDirectory()) return this.#readDirectoryPackage(sourcePath);
    if (!stat.isFile()) throw new SkillInstallError('source_not_file', 'Skill package must be a ZIP file or directory');
    if (stat.size > this.#maxArchiveBytes) throw new SkillInstallError('source_too_large', 'Skill package exceeds the archive size limit');
    let fd: number | undefined;
    try {
      fd = fs.openSync(sourcePath, 'r');
      const before = fs.fstatSync(fd);
      const archive = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || archive.length !== before.size) {
        throw new SkillInstallError('archive_invalid', 'Skill package changed while it was being read');
      }
      return parseZip(archive);
    } catch (error) {
      if (error instanceof SkillInstallError) throw error;
      throw new SkillInstallError('archive_invalid', 'Unable to read the skill package', { cause: error });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  #readDirectoryPackage(sourcePath: string): ParsedPackage {
    const canonical = fs.realpathSync(sourcePath);
    if (!samePath(canonical, sourcePath)) throw new SkillInstallError('source_symlink', 'Directory package contains a junction or symbolic-link root');
    const found: ExtractedFile[] = [];
    const visit = (directory: string, relativeDirectory: string): void => {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        const itemStat = fs.lstatSync(absolute);
        if (itemStat.isSymbolicLink()) throw new SkillInstallError('symlink_rejected', `Symbolic link is not allowed: ${relative}`);
        if (entry.isDirectory()) {
          const real = fs.realpathSync(absolute);
          if (!isContained(canonical, real)) throw new SkillInstallError('symlink_rejected', `Directory escapes the package root: ${relative}`);
          visit(absolute, relative);
        } else if (entry.isFile()) {
          if (itemStat.size > SKILL_INSTALLATION_LIMITS.fileBytes) throw new SkillInstallError('uncompressed_too_large', `File is too large: ${relative}`);
          found.push({ path: relative.replaceAll('\\', '/'), data: this.#readStableFile(absolute), compressedSize: itemStat.size });
          if (found.length > SKILL_INSTALLATION_LIMITS.files + 1) throw new SkillInstallError('too_many_files', 'Directory package contains too many files');
          if (found.reduce((sum, file) => sum + file.data.length, 0) > SKILL_INSTALLATION_LIMITS.extractedBytes) {
            throw new SkillInstallError('uncompressed_too_large', 'Directory package exceeds the extraction size limit');
          }
        } else {
          throw new SkillInstallError('source_not_file', `Unsupported package entry: ${relative}`);
        }
      }
    };
    visit(canonical, '');
    const digest = sha256(Buffer.from(found
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.path}\u0000${sha256(file.data)}`)
      .join('\n'), 'utf8'));
    return validatePackageFiles(found, digest);
  }

  #publish(parsed: ParsedPackage, provenance: SkillInstallationProvenance): SkillInstallationResult {
    const packageRoot = this.#createAndVerifyDirectory(path.join(this.#skillsRoot, packageDirectoryName(parsed.manifest.id)));
    return this.#withPackageLock(packageRoot, () => this.#publishLocked(packageRoot, parsed, provenance));
  }

  #publishLocked(packageRoot: string, parsed: ParsedPackage, provenance: SkillInstallationProvenance): SkillInstallationResult {
    const versionsRoot = this.#createAndVerifyDirectory(path.join(packageRoot, 'versions'));
    const target = path.join(versionsRoot, parsed.manifest.version);
    if (!isContained(this.#root, target)) throw new SkillInstallError('storage_unavailable', 'Install target escapes the skill storage root');
    if (fs.existsSync(target)) throw new SkillInstallError('already_installed', 'This skill version is already installed');
    const transactionRoot = this.#createAndVerifyDirectory(path.join(this.#stagingRoot, randomUUID()));
    const staged = path.join(transactionRoot, 'payload');
    fs.mkdirSync(staged, { mode: 0o700 });
    let published = false;
    try {
      for (const file of parsed.files) {
        const output = path.resolve(staged, ...file.path.split('/'));
        if (!isContained(staged, output)) throw new SkillInstallError('path_invalid', `Install path escapes staging: ${file.path}`);
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        fs.writeFileSync(output, file.data, { flag: 'wx', mode: 0o600 });
        this.#fsyncFile(output);
      }
      fs.writeFileSync(path.join(staged, MANIFEST_FILE), parsed.manifestBytes, { flag: 'wx', mode: 0o600 });
      const record: InstalledSkillVersion = {
        id: parsed.manifest.id,
        name: parsed.manifest.name,
        version: parsed.manifest.version,
        active: true,
        packageDigest: parsed.archiveSha256,
        manifest: parsed.manifest,
        provenance,
        storageKey: packageDirectoryName(parsed.manifest.id),
      };
      fs.writeFileSync(path.join(staged, INSTALL_RECORD_FILE), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      this.#fsyncFile(path.join(staged, MANIFEST_FILE));
      this.#fsyncFile(path.join(staged, INSTALL_RECORD_FILE));
      this.#fsyncDirectory(staged);
      this.#assertDirectorySafe(versionsRoot);
      fs.renameSync(staged, target);
      published = true;
      this.#fsyncDirectory(versionsRoot);
      try {
        this.#writeActiveRecord(packageRoot, {
          schemaVersion: 1,
          id: parsed.manifest.id,
          activeVersion: parsed.manifest.version,
          updatedAt: this.#now(),
        });
      } catch (error) {
        try {
          this.#removeContainedTree(target);
          published = false;
        } catch (rollbackError) {
          throw new SkillInstallError('rollback_failed', 'Install pointer failed and the published version could not be rolled back', { cause: rollbackError });
        }
        throw new SkillInstallError('publish_failed', 'Unable to activate the installed skill version', { cause: error });
      }
      return { ok: true, installed: record };
    } catch (error) {
      if (published && fs.existsSync(target)) {
        try { this.#removeContainedTree(target); } catch { /* reported by the original failure */ }
      }
      throw error;
    } finally {
      if (fs.existsSync(transactionRoot)) this.#removeContainedTree(transactionRoot);
    }
  }

  async #download(initialUrl: URL): Promise<DownloadResult> {
    let current = initialUrl;
    const redirects: string[] = [];
    for (let redirect = 0; redirect <= SKILL_INSTALLATION_LIMITS.redirects; redirect += 1) {
      const ownsDispatcher = this.#proxyUri === null;
      const dispatcher: Dispatcher = await this.#outboundDispatcher(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      try {
        try {
          const requestInit: RequestInit & { dispatcher: Dispatcher } = {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            dispatcher,
            headers: {
              accept: 'application/zip, application/octet-stream',
              'user-agent': 'Metis-Research-Workbench/1 skill-installer',
            },
          };
          response = await this.#fetch(current, requestInit);
        } catch (error) {
          throw new SkillInstallError('download_failed', `Unable to download skill package from ${current.origin}`, { cause: error });
        }
        if (response.status >= 300 && response.status < 400) {
          if (redirect === SKILL_INSTALLATION_LIMITS.redirects) throw new SkillInstallError('redirect_limit', 'Skill download exceeded the redirect limit');
          const location = response.headers.get('location');
          if (!location) throw new SkillInstallError('redirect_rejected', 'Skill download redirect has no destination');
          const next = this.#parseRemoteUrl(new URL(location, current).toString());
          if (current.protocol === 'https:' && next.protocol !== 'https:') throw new SkillInstallError('redirect_rejected', 'HTTPS skill downloads cannot redirect to HTTP');
          const sameHost = current.hostname.toLocaleLowerCase('en-US') === next.hostname.toLocaleLowerCase('en-US');
          const githubChain = GITHUB_REDIRECT_HOSTS.has(current.hostname.toLocaleLowerCase('en-US'))
            && GITHUB_REDIRECT_HOSTS.has(next.hostname.toLocaleLowerCase('en-US'));
          if (!sameHost && !githubChain) throw new SkillInstallError('redirect_rejected', 'Cross-host skill download redirect was rejected');
          redirects.push(next.toString());
          current = next;
          continue;
        }
        if (!response.ok) throw new SkillInstallError('download_failed', `Skill package download failed with HTTP ${response.status}`);
        const mediaType = normalizeMediaType(response.headers.get('content-type'));
        if (!ACCEPTED_ARCHIVE_TYPES.has(mediaType)) throw new SkillInstallError('content_type_rejected', `Unsupported skill package content type: ${mediaType || 'missing'}`);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.#maxArchiveBytes) throw new SkillInstallError('download_too_large', 'Skill package exceeds the download limit');
        const body = await this.#readResponseBody(response);
        return { body, resolvedUrl: current.toString(), redirectChain: redirects };
      } finally {
        clearTimeout(timer);
        if (ownsDispatcher) await dispatcher.close();
      }
    }
    throw new SkillInstallError('redirect_limit', 'Skill download exceeded the redirect limit');
  }

  /** DNS pin 直连（无代理环境）：把连接固定到解析出的公网地址。 */
  async #pinnedDispatcher(url: URL): Promise<Dispatcher> {
    const pinned = await this.#resolvePublicAddress(url);
    return new UndiciAgent({
      connect: {
        // undici ≥7 的 lookup 回调返回地址数组；旧的三参形式会被当作
        // ERR_INVALID_IP_ADDRESS 拒绝，导致所有远程安装失败。
        lookup: (_hostname, _options, callback) => callback(null, [{ address: pinned.address, family: pinned.family }]),
      },
    });
  }

  async #readResponseBody(response: Response): Promise<Buffer> {
    if (!response.body) throw new SkillInstallError('download_failed', 'Skill package response has no body');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        total += chunk.length;
        if (total > this.#maxArchiveBytes) {
          await reader.cancel('download limit exceeded');
          throw new SkillInstallError('download_too_large', 'Skill package exceeds the download limit');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof SkillInstallError) throw error;
      throw new SkillInstallError('download_failed', 'Unable to read the skill package response', { cause: error });
    }
    return Buffer.concat(chunks, total);
  }

  #parseRemoteUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch (error) { throw new SkillInstallError('url_invalid', 'Skill URL is invalid', { cause: error }); }
    const credentialQuery = [...url.searchParams.keys()].some((key) => /(?:token|secret|password|credential|signature|api[_-]?key|access[_-]?key|auth)/iu.test(key));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || credentialQuery) {
      throw new SkillInstallError('url_invalid', 'Skill URL must be credential-free HTTPS without a fragment');
    }
    return url;
  }

  async #resolvePublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    const hostname = url.hostname.toLocaleLowerCase('en-US');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new SkillInstallError('private_network_rejected', 'Private-network skill URLs are not allowed');
    }
    const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (net.isIP(literal) !== 0 && isPrivateIp(literal)) throw new SkillInstallError('private_network_rejected', 'Private-network skill URLs are not allowed');
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.#lookup(hostname, { all: true, verbatim: true }) as Array<{ address: string; family: number }>;
    } catch (error) {
      throw new SkillInstallError('download_failed', `Unable to resolve skill host ${hostname}`, { cause: error });
    }
    if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
      throw new SkillInstallError('private_network_rejected', 'Skill URL resolves to a private or non-routable address');
    }
    const pinned = addresses[0];
    if (!pinned || (pinned.family !== 4 && pinned.family !== 6)) {
      throw new SkillInstallError('download_failed', `Skill host ${hostname} did not resolve to IPv4 or IPv6`);
    }
    return { address: pinned.address, family: pinned.family };
  }

  #createAndVerifyDirectory(directory: string): string {
    const resolved = path.resolve(directory);
    const root = path.parse(resolved).root;
    const relative = path.relative(root, resolved);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SkillInstallError('storage_unavailable', `Unsafe skill storage directory: ${current}`);
      const real = fs.realpathSync(current);
      if (!samePath(real, current)) throw new SkillInstallError('storage_unavailable', `Skill storage contains a junction: ${current}`);
    }
    return fs.realpathSync(resolved);
  }

  #assertDirectorySafe(directory: string): void {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SkillInstallError('storage_unavailable', 'Skill storage directory is unsafe');
    const real = fs.realpathSync(directory);
    if (!isContained(this.#root, real) || !samePath(real, directory)) throw new SkillInstallError('storage_unavailable', 'Skill storage directory escapes its trusted root');
  }

  #safeChildDirectories(directory: string, missingAllowed = false): string[] {
    if (!fs.existsSync(directory)) return missingAllowed ? [] : [];
    this.#assertDirectorySafe(directory);
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(directory, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
      try {
        this.#assertDirectorySafe(child);
        return [child];
      } catch {
        return [];
      }
    });
  }

  #readInstallRecord(versionDirectory: string): InstalledSkillVersion | undefined {
    try {
      this.#assertDirectorySafe(versionDirectory);
      const recordPath = path.join(versionDirectory, INSTALL_RECORD_FILE);
      const stat = fs.lstatSync(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SKILL_INSTALLATION_LIMITS.manifestBytes * 2) return undefined;
      const parsed = InstalledSkillVersionSchema.safeParse(JSON.parse(fs.readFileSync(recordPath, 'utf8')) as unknown);
      if (!parsed.success || parsed.data.storageKey !== packageDirectoryName(parsed.data.id)) return undefined;
      if (!samePath(this.#versionDirectory(parsed.data.id, parsed.data.version), versionDirectory)) return undefined;
      const manifestPath = path.join(versionDirectory, MANIFEST_FILE);
      const manifestStat = fs.lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return undefined;
      const manifestBytes = fs.readFileSync(manifestPath);
      if (sha256(manifestBytes) !== parsed.data.provenance.manifestSha256) return undefined;
      const expectedPaths = new Set([MANIFEST_FILE, INSTALL_RECORD_FILE]);
      for (const declared of parsed.data.manifest.files) {
        const payloadPath = path.resolve(versionDirectory, ...declared.path.split('/'));
        if (!isContained(versionDirectory, payloadPath)) return undefined;
        const payloadStat = fs.lstatSync(payloadPath);
        if (!payloadStat.isFile() || payloadStat.isSymbolicLink() || payloadStat.size !== declared.size) return undefined;
        if (!isContained(versionDirectory, fs.realpathSync(payloadPath)) || sha256(fs.readFileSync(payloadPath)) !== declared.sha256) return undefined;
        expectedPaths.add(declared.path);
      }
      const actualPaths = this.#listRelativeFiles(versionDirectory);
      if (actualPaths.length !== expectedPaths.size || actualPaths.some((filePath) => !expectedPaths.has(filePath))) return undefined;
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  #readActiveRecord(packageRoot: string): ActiveRecord | undefined {
    try {
      const recordPath = path.join(packageRoot, ACTIVE_RECORD_FILE);
      const stat = fs.lstatSync(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192) return undefined;
      const value = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
      if (value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.activeVersion !== 'string' || typeof value.updatedAt !== 'number') return undefined;
      return value as unknown as ActiveRecord;
    } catch {
      return undefined;
    }
  }

  #writeActiveRecord(packageRoot: string, record: ActiveRecord): void {
    this.#assertDirectorySafe(packageRoot);
    const destination = path.join(packageRoot, ACTIVE_RECORD_FILE);
    const temporary = path.join(packageRoot, `.active.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, destination);
      this.#fsyncDirectory(packageRoot);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  #withPackageLock<T>(packageRoot: string, action: () => T): T {
    this.#assertDirectorySafe(packageRoot);
    const lockPath = path.join(packageRoot, '.install.lock');
    let fd: number | undefined;
    const nonce = randomUUID();
    try {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          if (!this.#recoverStalePackageLock(lockPath)) {
            throw new SkillInstallError('install_conflict', 'Another skill install, update, or uninstall is already in progress');
          }
          try {
            fd = fs.openSync(lockPath, 'wx', 0o600);
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new SkillInstallError('install_conflict', 'Another skill install, update, or uninstall is already in progress');
            }
            throw retryError;
          }
        } else {
          throw error;
        }
      }
      fs.writeFileSync(fd, JSON.stringify({
        format: INSTALL_LOCK_FORMAT,
        version: INSTALL_LOCK_VERSION,
        pid: process.pid,
        createdAt: this.#now(),
        nonce,
      }), 'utf8');
      fs.fsyncSync(fd);
      return action();
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } finally {
          this.#removeOwnedPackageLock(lockPath, nonce);
        }
      }
    }
  }

  #recoverStalePackageLock(lockPath: string): boolean {
    try {
      const raw = this.#readLockFile(lockPath);
      const record = decodeInstallLock(raw);
      if (!record || processIsAlive(record.pid)) return false;
      if (this.#readLockFile(lockPath) !== raw) return false;
      fs.unlinkSync(lockPath);
      this.#fsyncDirectory(path.dirname(lockPath));
      return true;
    } catch {
      return false;
    }
  }

  #removeOwnedPackageLock(lockPath: string, nonce: string): void {
    try {
      const record = decodeInstallLock(this.#readLockFile(lockPath));
      if (!record || record.pid !== process.pid || record.nonce !== nonce) return;
      fs.unlinkSync(lockPath);
      this.#fsyncDirectory(path.dirname(lockPath));
    } catch {
      // A changed or unreadable lock is not ours to remove and fails closed.
    }
  }

  #readLockFile(lockPath: string): string {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048
      || !samePath(fs.realpathSync(lockPath), lockPath)) throw new Error('Unsafe install lock');
    return fs.readFileSync(lockPath, 'utf8');
  }

  #removeContainedTree(target: string): void {
    const resolved = path.resolve(target);
    if (!isContained(this.#root, resolved) || samePath(this.#root, resolved)) throw new SkillInstallError('uninstall_failed', 'Refusing to remove a path outside skill storage');
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new SkillInstallError('symlink_rejected', 'Refusing to remove a symbolic link from skill storage');
    fs.rmSync(resolved, { recursive: true, force: false });
  }

  #fsyncFile(filePath: string): void {
    const fd = fs.openSync(filePath, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  #readStableFile(filePath: string): Buffer {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > SKILL_INSTALLATION_LIMITS.fileBytes) {
        throw new SkillInstallError('source_not_file', `Package entry is not a supported file: ${filePath}`);
      }
      const content = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      const sameIdentity = process.platform === 'win32'
        ? before.size === after.size && before.mtimeMs === after.mtimeMs
        : before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
      if (!sameIdentity || content.length !== before.size) {
        throw new SkillInstallError('archive_invalid', `Package entry changed while being read: ${filePath}`);
      }
      return content;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  #fsyncDirectory(directory: string): void {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  #listRelativeFiles(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string, relativeDirectory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new SkillInstallError('symlink_rejected', `Installed skill contains a symbolic link: ${relative}`);
        if (entry.isDirectory()) visit(absolute, relative);
        else if (entry.isFile()) files.push(relative);
        else throw new SkillInstallError('file_mismatch', `Installed skill contains an unsupported entry: ${relative}`);
      }
    };
    visit(root, '');
    return files;
  }

  #failure(error: unknown): SkillInstallationResult {
    if (error instanceof SkillInstallError) return { ok: false, code: error.code, message: error.message };
    const message = error instanceof Error ? error.message : 'Unknown skill installation error';
    return { ok: false, code: 'publish_failed', message };
  }

  resolveInstalledDirectory(id: string, version?: string): string | undefined {
    const installed = this.getInstalled(id, version);
    if (!installed) return undefined;
    const directory = this.#versionDirectory(installed.id, installed.version);
    try {
      this.#assertDirectorySafe(directory);
      return directory;
    } catch {
      return undefined;
    }
  }

  #packageRoot(id: string): string {
    return path.join(this.#skillsRoot, packageDirectoryName(id));
  }

  #versionDirectory(id: string, version: string): string {
    return path.join(this.#packageRoot(id), 'versions', version);
  }
}
