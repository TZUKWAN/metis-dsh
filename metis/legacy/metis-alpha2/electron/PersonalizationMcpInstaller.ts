import dns from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildArgsDecoder } from '../engine/tools/ArgsValidator.js';
import {
  MCP_INSTALL_LIMITS,
  McpHttpsUrlSchema,
  McpInstalledRecordSchema,
  McpPackageManifestSchema,
  McpProbeResultSchema,
  McpUrlInstallRequestSchema,
  McpUrlInstallResponseSchema,
  type McpInstalledRecord,
  type McpPackageManifest,
  type McpProbeResult,
  type McpUrlInstallResponse,
} from '../engine/runtime/McpInstallationContract.js';

export interface McpDownloadedResource {
  finalUrl: string;
  body: Uint8Array;
  contentType: string | null;
}

export interface McpNetworkClient {
  download(url: string, maxBytes: number, maxRedirects: number): Promise<McpDownloadedResource>;
}

export interface McpControlledProbeRequest {
  installationId: string;
  command: string;
  args: string[];
  workingDirectory: string;
  secretRefs: Readonly<Record<string, string>>;
  timeoutMs: number;
  shell: false;
  inheritParentEnvironment: false;
  fixedEnvironment: Readonly<Record<string, string>>;
}

export interface McpControlledProbeRunner {
  /** Runs in the trusted main-process probe harness. Installers never invoke a shell. */
  probe(request: McpControlledProbeRequest): Promise<unknown>;
}

export interface McpProbeRollbackSnapshot {
  installationId: string;
  record: McpInstalledRecord;
  recordDigest: string;
}

export interface McpStaticValidationResult {
  ok: boolean;
  code?: string;
  record?: McpInstalledRecord;
}

export interface McpLaunchDescriptor {
  installationId: string;
  command: string;
  args: string[];
  workingDirectory: string;
  secretRefs: Readonly<Record<string, string>>;
  tools: McpPackageManifest['tools'];
  verifiedFiles: ReadonlyArray<{
    path: string;
    absolutePath: string;
    size: number;
    sha256: string;
  }>;
  shell: false;
  inheritParentEnvironment: false;
  fixedEnvironment: Readonly<Record<string, string>>;
}

interface GeneratedPackagePayload {
  path: string;
  body: Uint8Array;
}

interface McpInstallationSnapshot {
  directory: string;
  manifest: McpPackageManifest;
  record: McpInstalledRecord;
  verifiedFiles: McpLaunchDescriptor['verifiedFiles'];
}

type McpInstallFailureCode = Extract<McpUrlInstallResponse, { ok: false }>['code'];

const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';
const RECORD_FILE = 'installation-record.json';
const MANIFEST_FILE = 'manifest.json';
const STATIC_FORBIDDEN = [
  /\beval\s*\(/u,
  /\bnew\s+Function\b/u,
  /\bFunction\s*\(/u,
  /\bprocess\s*\.\s*binding\b/u,
  /\bprocess\s*\.\s*dlopen\b/u,
  /\brequire\s*\(/u,
  /\bimport\s*\(/u,
  /\bnode:(?:child_process|cluster|worker_threads|vm|module)\b/u,
  /\b(?:exec|execFile|spawn|fork)\s*\(/u,
  /\bshell\s*:\s*true\b/u,
];
const ALLOWED_STATIC_IMPORTS = new Set([
  'node:readline', 'node:process', 'node:https', 'node:dns/promises', 'node:net',
]);

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

const BLOCKED_MCP_IPV6 = new net.BlockList();
for (const [subnet, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
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
  BLOCKED_MCP_IPV6.addSubnet(subnet, prefix, 'ipv6');
}

export function isPrivateMcpNetworkAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    if (a === 203 && b === 0) return true;
    return false;
  }
  if (version === 6) {
    return BLOCKED_MCP_IPV6.check(address, 'ipv6');
  }
  return true;
}

/** HTTPS downloader pinned to a DNS result so validation cannot be bypassed by rebinding. */
export class NodeHttpsMcpNetworkClient implements McpNetworkClient {
  async download(url: string, maxBytes: number, maxRedirects: number): Promise<McpDownloadedResource> {
    const parsed = McpHttpsUrlSchema.safeParse(url);
    if (!parsed.success) throw new Error('unsafe_url');
    const target = new URL(parsed.data);
    const resolved = await dns.lookup(target.hostname, { all: true, verbatim: true });
    if (resolved.length === 0 || resolved.some((item) => isPrivateMcpNetworkAddress(item.address))) {
      throw new Error('dns_rejected');
    }
    const chosen = resolved[0]!;
    return new Promise<McpDownloadedResource>((resolve, reject) => {
      const request = https.request(target, {
        method: 'GET',
        headers: { Accept: 'application/json, application/octet-stream;q=0.9', 'User-Agent': 'Metis-MCP-Installer/1' },
        servername: target.hostname,
        lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family),
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          const location = response.headers.location;
          if (!location || maxRedirects <= 0) {
            reject(new Error('redirect_rejected'));
            return;
          }
          let redirected: URL;
          try { redirected = new URL(location, target); } catch { reject(new Error('redirect_rejected')); return; }
          this.download(redirected.toString(), maxBytes, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error('download_failed'));
          return;
        }
        const declaredLength = Number(response.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy();
          reject(new Error('download_failed'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy(new Error('download_failed'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({
          finalUrl: target.toString(),
          body: Buffer.concat(chunks),
          contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null,
        }));
      });
      request.setTimeout(15_000, () => request.destroy(new Error('download_failed')));
      request.on('error', reject);
      request.end();
    });
  }
}

export class PersonalizationMcpInstaller {
  readonly #baseRoot: string;
  readonly #network: McpNetworkClient;
  readonly #now: () => number;
  readonly #runtimeExecutable: string;
  readonly #fixedEnvironment: Readonly<Record<string, string>>;

  constructor(baseRoot: string, options?: {
    network?: McpNetworkClient;
    now?: () => number;
    runtimeExecutable?: string;
    fixedEnvironment?: Readonly<Record<string, string>>;
  }) {
    this.#baseRoot = ensureTrustedDirectory(baseRoot);
    this.#network = options?.network ?? new NodeHttpsMcpNetworkClient();
    this.#now = options?.now ?? Date.now;
    this.#runtimeExecutable = options?.runtimeExecutable ?? process.execPath;
    this.#fixedEnvironment = Object.freeze({
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(options?.fixedEnvironment ?? {}),
    });
  }

  async installFromUrl(raw: unknown): Promise<McpUrlInstallResponse> {
    const operationId = extractOperationId(raw);
    const request = McpUrlInstallRequestSchema.safeParse(raw);
    if (!request.success) return McpUrlInstallResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });

    let manifestDownload: McpDownloadedResource;
    try {
      manifestDownload = await this.#network.download(
        request.data.manifestUrl,
        MCP_INSTALL_LIMITS.manifestBytes,
        MCP_INSTALL_LIMITS.redirects,
      );
    } catch (error) {
      return this.#installFailure(operationId, mapNetworkError(error));
    }
    const manifestBytes = Buffer.from(manifestDownload.body);
    const manifestSha256 = sha256(manifestBytes);
    if (request.data.expectedManifestSha256 && request.data.expectedManifestSha256 !== manifestSha256) {
      return this.#installFailure(operationId, 'manifest_digest_mismatch');
    }

    let manifest: McpPackageManifest;
    try {
      manifest = McpPackageManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    } catch {
      return this.#installFailure(operationId, 'manifest_invalid');
    }
    const manifestOrigin = new URL(manifestDownload.finalUrl).origin;
    const payloads: GeneratedPackagePayload[] = [];
    for (const file of manifest.files) {
      if (new URL(file.url).origin !== manifestOrigin) {
        return this.#installFailure(operationId, 'unsafe_url');
      }
      let downloaded: McpDownloadedResource;
      try {
        downloaded = await this.#network.download(file.url, file.size, MCP_INSTALL_LIMITS.redirects);
      } catch (error) {
        return this.#installFailure(operationId, mapNetworkError(error));
      }
      const body = Buffer.from(downloaded.body);
      if (body.length !== file.size) return this.#installFailure(operationId, 'file_size_mismatch');
      if (sha256(body) !== file.sha256) return this.#installFailure(operationId, 'file_digest_mismatch');
      payloads.push({ path: file.path, body });
    }
    try {
      const canonicalManifestSha256 = sha256(Buffer.from(canonicalJson(manifest), 'utf8'));
      const record = this.#persistPackage(manifest, canonicalManifestSha256, payloads);
      return McpUrlInstallResponseSchema.parse({ ok: true, operationId, record });
    } catch (error) {
      const code = error instanceof Error && error.message === 'already_installed'
        ? 'already_installed' : error instanceof Error && error.message === 'path_rejected'
          ? 'path_rejected' : 'storage_failed';
      return this.#installFailure(operationId, code);
    }
  }

  /**
   * Imports a complete local Metis MCP package directory. Its manifest keeps
   * the portable package shape; network file URLs are never read on this path.
   */
  installFromDirectory(sourcePath: string): McpInstalledRecord {
    const sourceRoot = path.resolve(sourcePath);
    const stat = fs.lstatSync(sourceRoot);
    const real = fs.realpathSync(sourceRoot);
    const same = process.platform === 'win32'
      ? real.toLocaleLowerCase('en-US') === sourceRoot.toLocaleLowerCase('en-US')
      : real === sourceRoot;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same) throw new Error('local_package_invalid');
    const manifestBytes = readStableContainedFile(sourceRoot, MANIFEST_FILE, MCP_INSTALL_LIMITS.manifestBytes);
    const manifest = McpPackageManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    const diskPaths = listRegularRelativeFiles(sourceRoot);
    const declared = new Set(manifest.files.map((file) => file.path));
    if (diskPaths.length !== declared.size + 1
      || !diskPaths.includes(MANIFEST_FILE)
      || diskPaths.some((item) => item !== MANIFEST_FILE && !declared.has(item))) {
      throw new Error('local_package_file_mismatch');
    }
    const payloads = manifest.files.map((file) => ({
      path: file.path,
      body: readStableContainedFile(sourceRoot, file.path, MCP_INSTALL_LIMITS.fileBytes),
    }));
    return this.installGeneratedPackage(manifest, payloads);
  }

  /** Stores deterministic Builder output. It remains disabled until static validation and probe. */
  installGeneratedPackage(manifestRaw: unknown, payloadsRaw: readonly GeneratedPackagePayload[]): McpInstalledRecord {
    const manifest = McpPackageManifestSchema.parse(manifestRaw);
    const payloads = payloadsRaw.map((payload) => ({ path: payload.path, body: Buffer.from(payload.body) }));
    const byPath = new Map(payloads.map((payload) => [payload.path, payload.body]));
    if (byPath.size !== payloads.length || payloads.length !== manifest.files.length) throw new Error('payload_mismatch');
    for (const file of manifest.files) {
      const body = byPath.get(file.path);
      if (!body || body.length !== file.size || sha256(body) !== file.sha256) throw new Error('payload_mismatch');
    }
    const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
    return this.#persistPackage(manifest, sha256(manifestBytes), payloads);
  }

  /**
   * Idempotent recovery for the narrow crash window after deterministic files
   * were stored but before the generated activation intent journal was written.
   * Only an exact, fully verified and still-disabled package may be resumed.
   */
  resumeExactUnactivatedGeneratedPackage(
    manifestRaw: unknown,
    payloadsRaw: readonly GeneratedPackagePayload[],
  ): McpInstalledRecord | null {
    try {
      const manifest = McpPackageManifestSchema.parse(manifestRaw);
      const payloads = payloadsRaw.map((payload) => ({ path: payload.path, body: Buffer.from(payload.body) }));
      const byPath = new Map(payloads.map((payload) => [payload.path, payload.body]));
      if (byPath.size !== payloads.length || payloads.length !== manifest.files.length) return null;
      for (const file of manifest.files) {
        const body = byPath.get(file.path);
        if (!body || body.length !== file.size || sha256(body) !== file.sha256) return null;
      }
      const manifestSha256 = sha256(Buffer.from(canonicalJson(manifest), 'utf8'));
      const packageSha256 = sha256(canonicalJson(
        manifest.files.map((file) => [file.path, file.sha256, file.size]),
      ));
      const installationId = `mcp_${sha256(`${manifest.packageId}\0${manifest.version}\0${manifestSha256}`).slice(0, 32)}`;
      const record = this.#readInstallation(installationId).record;
      if (record.enabled || record.state === 'enabled'
        || record.packageId !== manifest.packageId
        || record.packageVersion !== manifest.version
        || record.manifestSha256 !== manifestSha256
        || record.packageSha256 !== packageSha256) return null;
      return record;
    } catch {
      return null;
    }
  }

  staticValidate(installationId: string): McpStaticValidationResult {
    try {
      const { directory, manifest, record } = this.#readInstallation(installationId);
      const declaredPaths = new Set(manifest.files.map((file) => file.path));
      const diskPaths = listRegularRelativeFiles(directory).filter((item) => item !== MANIFEST_FILE && item !== RECORD_FILE);
      if (diskPaths.length !== declaredPaths.size || diskPaths.some((item) => !declaredPaths.has(item))) {
        return this.#failValidation(record, 'undeclared_file');
      }
      for (const file of manifest.files) {
        const filePath = containedFile(directory, file.path);
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
          return this.#failValidation(record, 'file_identity_mismatch');
        }
        const bytes = fs.readFileSync(filePath);
        if (sha256(bytes) !== file.sha256) return this.#failValidation(record, 'file_digest_mismatch');
        if (file.path.endsWith('.js') || file.path.endsWith('.mjs')) {
          const source = bytes.toString('utf8');
          if (STATIC_FORBIDDEN.some((pattern) => pattern.test(source))) {
            return this.#failValidation(record, 'forbidden_source_construct');
          }
          for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu)) {
            const specifier = match[1]!;
            if (!ALLOWED_STATIC_IMPORTS.has(specifier) && !specifier.startsWith('./')) {
              return this.#failValidation(record, 'forbidden_import');
            }
          }
        }
      }
      for (const tool of manifest.tools) buildArgsDecoder(tool.inputSchema);
      const updated = this.#writeRecord(directory, {
        ...record,
        state: 'static_verified',
        enabled: false,
        verifiedAt: this.#now(),
        failureCode: null,
      });
      return { ok: true, record: updated };
    } catch (error) {
      return { ok: false, code: error instanceof Error ? error.message : 'static_validation_failed' };
    }
  }

  async probeAndEnable(installationId: string, runner: McpControlledProbeRunner): Promise<McpStaticValidationResult> {
    let installation: McpInstallationSnapshot;
    try { installation = this.#readInstallation(installationId); } catch (error) {
      return { ok: false, code: error instanceof Error ? error.message : 'installation_not_found' };
    }
    const { directory, manifest, record } = installation;
    if (record.state !== 'static_verified' && record.state !== 'probe_failed') {
      return { ok: false, code: 'static_validation_required' };
    }
    const secretRefs = Object.fromEntries(manifest.environment.map((entry) => [entry.name, entry.secretRef]));
    let result: McpProbeResult;
    try {
      result = McpProbeResultSchema.parse(await runner.probe({
        installationId,
        command: this.#runtimeExecutable,
        args: [containedFile(directory, manifest.entry), ...manifest.args],
        workingDirectory: directory,
        secretRefs,
        timeoutMs: 5_000,
        shell: false,
        inheritParentEnvironment: false,
        fixedEnvironment: this.#fixedEnvironment,
      }));
    } catch {
      result = { ok: false, code: 'probe_exception' };
    }
    if (!result.ok) return this.#failValidation(record, result.code, 'probe_failed');

    const declared = new Map(manifest.tools.map((tool) => [tool.name, sha256(canonicalJson(tool.inputSchema))]));
    const observed = new Map<string, string>();
    try {
      for (const tool of result.tools) {
        buildArgsDecoder(tool.inputSchema);
        if (observed.has(tool.name)) return this.#failValidation(record, 'duplicate_probe_tool', 'probe_failed');
        observed.set(tool.name, sha256(canonicalJson(tool.inputSchema)));
      }
    } catch {
      return this.#failValidation(record, 'unsupported_probe_schema', 'probe_failed');
    }
    if (declared.size !== observed.size
      || [...declared].some(([name, digest]) => observed.get(name) !== digest)) {
      return this.#failValidation(record, 'phantom_or_missing_tool', 'probe_failed');
    }
    const enabled = this.#writeRecord(directory, {
      ...record,
      state: 'enabled',
      enabled: true,
      probedAt: this.#now(),
      exposedTools: [...declared.keys()],
      failureCode: null,
    });
    return { ok: true, record: enabled };
  }

  /** Reads a fully integrity-checked installation record for activation/recovery coordination. */
  readInstalledRecord(installationId: string): McpInstalledRecord | null {
    try { return this.#readInstallation(installationId).record; } catch { return null; }
  }

  /**
   * Removes a fully integrity-checked installation only while it is disabled.
   * Builder failure recovery uses this narrow operation so a failed generated
   * package does not permanently reserve its deterministic installation ID.
   * Enabled installations are never removable through this path.
   */
  removeUnactivatedInstallation(installationId: string): boolean {
    try {
      const { directory, record } = this.#readInstallation(installationId);
      if (record.enabled || record.state === 'enabled') return false;
      if (record.state !== 'downloaded'
        && record.state !== 'static_verified'
        && record.state !== 'probe_failed') return false;

      const tombstone = containedFile(
        this.#baseRoot,
        `.cleanup-${installationId}-${randomUUID()}`,
      );
      fs.renameSync(directory, tombstone);
      fsyncDirectory(this.#baseRoot);
      fs.rmSync(tombstone, { recursive: true, force: false });
      fsyncDirectory(this.#baseRoot);
      return !fs.existsSync(directory) && !fs.existsSync(tombstone);
    } catch {
      return false;
    }
  }

  /** Captures the only states from which a controlled probe may transition to enabled. */
  captureProbeRollback(installationId: string): McpProbeRollbackSnapshot | null {
    try {
      const { record } = this.#readInstallation(installationId);
      if (record.enabled || (record.state !== 'static_verified' && record.state !== 'probe_failed')) return null;
      return Object.freeze({
        installationId,
        record: Object.freeze({ ...record, exposedTools: [...record.exposedTools] }),
        recordDigest: mcpInstalledRecordDigest(record),
      });
    } catch {
      return null;
    }
  }

  /**
   * Strict activation-only CAS rollback. It cannot write arbitrary states: the
   * current record must exactly match the supplied enabled record and the
   * snapshot must be the same installation's prior static/probe-failed state.
   */
  rollbackEnabledProbe(snapshotRaw: unknown, expectedEnabledRaw: unknown): boolean {
    try {
      if (!snapshotRaw || typeof snapshotRaw !== 'object' || Array.isArray(snapshotRaw)) return false;
      const snapshotObject = snapshotRaw as Record<string, unknown>;
      if (Object.keys(snapshotObject).sort().join(',') !== 'installationId,record,recordDigest') return false;
      const snapshotInstallationId = snapshotObject.installationId;
      const snapshotDigest = snapshotObject.recordDigest;
      const prior = McpInstalledRecordSchema.safeParse(snapshotObject.record);
      const expectedEnabled = McpInstalledRecordSchema.safeParse(expectedEnabledRaw);
      if (typeof snapshotInstallationId !== 'string' || typeof snapshotDigest !== 'string'
        || !prior.success || !expectedEnabled.success) return false;
      if (prior.data.installationId !== snapshotInstallationId
        || prior.data.enabled || (prior.data.state !== 'static_verified' && prior.data.state !== 'probe_failed')
        || snapshotDigest !== mcpInstalledRecordDigest(prior.data)) return false;

      const installation = this.#readInstallation(snapshotInstallationId);
      const current = installation.record;
      if (!current.enabled || current.state !== 'enabled' || current.probedAt === null || current.failureCode !== null
        || canonicalJson(current) !== canonicalJson(expectedEnabled.data)
        || !sameMcpRecordIdentity(prior.data, current)) return false;

      const restored = this.#writeRecord(installation.directory, prior.data);
      if (canonicalJson(restored) !== canonicalJson(prior.data)) return false;
      const reread = this.#readInstallation(snapshotInstallationId).record;
      return canonicalJson(reread) === canonicalJson(prior.data);
    } catch {
      return false;
    }
  }

  getLaunchDescriptor(installationId: string): McpLaunchDescriptor | null {
    try {
      const { directory, manifest, record, verifiedFiles } = this.#readInstallation(installationId);
      if (!record.enabled || record.state !== 'enabled') return null;
      return {
        installationId,
        command: this.#runtimeExecutable,
        args: [containedFile(directory, manifest.entry), ...manifest.args],
        workingDirectory: directory,
        secretRefs: Object.freeze(Object.fromEntries(manifest.environment.map((entry) => [entry.name, entry.secretRef]))),
        tools: manifest.tools,
        verifiedFiles,
        shell: false,
        inheritParentEnvironment: false,
        fixedEnvironment: this.#fixedEnvironment,
      };
    } catch {
      return null;
    }
  }

  #persistPackage(
    manifest: McpPackageManifest,
    manifestSha256: string,
    payloads: readonly GeneratedPackagePayload[],
  ): McpInstalledRecord {
    this.#assertBaseIntact();
    const packageSha256 = sha256(canonicalJson(manifest.files.map((file) => [file.path, file.sha256, file.size])));
    const installationId = `mcp_${sha256(`${manifest.packageId}\0${manifest.version}\0${manifestSha256}`).slice(0, 32)}`;
    const finalDirectory = containedFile(this.#baseRoot, installationId);
    if (fs.existsSync(finalDirectory)) throw new Error('already_installed');
    const staging = containedFile(this.#baseRoot, `.staging-${installationId}-${randomUUID()}`);
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    try {
      const byPath = new Map(payloads.map((payload) => [payload.path, payload.body]));
      for (const file of manifest.files) {
        const body = byPath.get(file.path);
        if (!body || body.length !== file.size || sha256(body) !== file.sha256) throw new Error('payload_mismatch');
        const destination = containedFile(staging, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        writeExclusiveAndSync(destination, body);
      }
      writeExclusiveAndSync(path.join(staging, MANIFEST_FILE), Buffer.from(canonicalJson(manifest), 'utf8'));
      const record: McpInstalledRecord = {
        installationId,
        packageId: manifest.packageId,
        packageVersion: manifest.version,
        manifestSha256,
        packageSha256,
        state: 'downloaded',
        enabled: false,
        installedAt: this.#now(),
        verifiedAt: null,
        probedAt: null,
        exposedTools: [],
        failureCode: null,
      };
      writeExclusiveAndSync(path.join(staging, RECORD_FILE), Buffer.from(canonicalJson(record), 'utf8'));
      fs.renameSync(staging, finalDirectory);
      fsyncDirectory(this.#baseRoot);
      return record;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  #readInstallation(installationId: string): McpInstallationSnapshot {
    if (!/^mcp_[a-f0-9]{32}$/u.test(installationId)) throw new Error('installation_not_found');
    this.#assertBaseIntact();
    const directory = containedFile(this.#baseRoot, installationId);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('installation_not_found');
    const manifest = McpPackageManifestSchema.parse(JSON.parse(
      readStableContainedFile(directory, MANIFEST_FILE, MCP_INSTALL_LIMITS.manifestBytes).toString('utf8'),
    ));
    const record = McpInstalledRecordSchema.parse(JSON.parse(
      readStableContainedFile(directory, RECORD_FILE, MCP_INSTALL_LIMITS.manifestBytes).toString('utf8'),
    ));
    if (record.installationId !== installationId || record.packageId !== manifest.packageId
      || record.packageVersion !== manifest.version) throw new Error('installation_identity_mismatch');
    if (sha256(Buffer.from(canonicalJson(manifest), 'utf8')) !== record.manifestSha256) {
      throw new Error('manifest_digest_mismatch');
    }
    const packageSha256 = sha256(canonicalJson(manifest.files.map((file) => [file.path, file.sha256, file.size])));
    if (packageSha256 !== record.packageSha256) throw new Error('package_digest_mismatch');
    const declaredPaths = new Set(manifest.files.map((file) => file.path));
    const diskPaths = listRegularRelativeFiles(directory)
      .filter((item) => item !== MANIFEST_FILE && item !== RECORD_FILE);
    if (diskPaths.length !== declaredPaths.size || diskPaths.some((item) => !declaredPaths.has(item))) {
      throw new Error('undeclared_file');
    }
    const verifiedFiles: Array<McpLaunchDescriptor['verifiedFiles'][number]> = [];
    for (const file of manifest.files) {
      const bytes = readStableContainedFile(directory, file.path, MCP_INSTALL_LIMITS.fileBytes);
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
        throw new Error('file_digest_mismatch');
      }
      verifiedFiles.push({
        path: file.path,
        absolutePath: containedFile(directory, file.path),
        size: file.size,
        sha256: file.sha256,
      });
    }
    return { directory, manifest, record, verifiedFiles };
  }

  #writeRecord(directory: string, raw: unknown): McpInstalledRecord {
    const record = McpInstalledRecordSchema.parse(raw);
    const target = path.join(directory, RECORD_FILE);
    const temp = path.join(directory, `.record-${randomUUID()}.tmp`);
    try {
      writeExclusiveAndSync(temp, Buffer.from(canonicalJson(record), 'utf8'));
      fs.renameSync(temp, target);
      fsyncDirectory(directory);
      return record;
    } finally {
      try { fs.unlinkSync(temp); } catch { /* already renamed or best-effort cleanup */ }
    }
  }

  #failValidation(
    record: McpInstalledRecord,
    code: string,
    state: 'downloaded' | 'probe_failed' = 'downloaded',
  ): McpStaticValidationResult {
    try {
      const directory = containedFile(this.#baseRoot, record.installationId);
      const updated = this.#writeRecord(directory, { ...record, state, enabled: false, failureCode: code });
      return { ok: false, code, record: updated };
    } catch {
      return { ok: false, code };
    }
  }

  #assertBaseIntact(): void {
    const stat = fs.lstatSync(this.#baseRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.#baseRoot) !== this.#baseRoot) {
      throw new Error('storage_failed');
    }
  }

  #installFailure(operationId: string, code: McpInstallFailureCode): McpUrlInstallResponse {
    return McpUrlInstallResponseSchema.parse({ ok: false, operationId, code });
  }
}

export function mcpInstalledRecordDigest(raw: unknown): string {
  const record = McpInstalledRecordSchema.parse(raw);
  return sha256(Buffer.from(canonicalJson(record), 'utf8'));
}

function sameMcpRecordIdentity(left: McpInstalledRecord, right: McpInstalledRecord): boolean {
  return left.installationId === right.installationId
    && left.packageId === right.packageId
    && left.packageVersion === right.packageVersion
    && left.manifestSha256 === right.manifestSha256
    && left.packageSha256 === right.packageSha256
    && left.installedAt === right.installedAt
    && left.verifiedAt === right.verifiedAt;
}

function extractOperationId(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).operationId;
    if (typeof value === 'string' && McpUrlInstallRequestSchema.shape.operationId.safeParse(value).success) return value;
  }
  return FALLBACK_OPERATION_ID;
}

function mapNetworkError(error: unknown): 'unsafe_url' | 'dns_rejected' | 'redirect_rejected' | 'download_failed' {
  const code = error instanceof Error ? error.message : '';
  if (code === 'unsafe_url' || code === 'dns_rejected' || code === 'redirect_rejected') return code;
  return 'download_failed';
}

function ensureTrustedDirectory(input: string): string {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Unsafe MCP installation root');
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error('Unsafe MCP installation root');
  return real;
}

function containedFile(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    if (target === root) return target;
    throw new Error('path_rejected');
  }
  return target;
}

function readStableContainedFile(root: string, relative: string, maxBytes: number): Buffer {
  const filePath = containedFile(root, relative);
  const lstat = fs.lstatSync(filePath);
  const real = fs.realpathSync(filePath);
  const same = process.platform === 'win32'
    ? real.toLocaleLowerCase('en-US') === filePath.toLocaleLowerCase('en-US')
    : real === filePath;
  if (!lstat.isFile() || lstat.isSymbolicLink() || !same || lstat.size > maxBytes) {
    throw new Error('file_identity_mismatch');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || (process.platform !== 'win32' && (before.dev !== after.dev || before.ino !== after.ino))
      || bytes.length !== after.size) {
      throw new Error('file_identity_mismatch');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function writeExclusiveAndSync(filePath: string, bytes: Uint8Array): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function listRegularRelativeFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error('symlink_rejected');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(relative);
      else throw new Error('non_file_rejected');
    }
  };
  visit(root);
  return output.sort();
}
