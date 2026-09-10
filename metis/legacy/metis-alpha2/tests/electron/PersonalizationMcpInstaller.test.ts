import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PersonalizationMcpInstaller,
  isPrivateMcpNetworkAddress,
  type McpDownloadedResource,
  type McpNetworkClient,
} from '../../electron/PersonalizationMcpInstaller.js';

const temporaryRoots: string[] = [];
const INPUT_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-installer-'));
  temporaryRoots.push(root);
  return root;
}

class FakeNetwork implements McpNetworkClient {
  readonly resources = new Map<string, McpDownloadedResource>();
  readonly calls: string[] = [];

  async download(url: string): Promise<McpDownloadedResource> {
    this.calls.push(url);
    const resource = this.resources.get(url);
    if (!resource) throw new Error('download_failed');
    return resource;
  }

  set(url: string, body: Uint8Array | string, finalUrl = url): void {
    this.resources.set(url, {
      finalUrl,
      body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
      contentType: 'application/octet-stream',
    });
  }
}

function packageFixture(source = "import readline from 'node:readline';\nvoid readline;\n") {
  const bytes = Buffer.from(source, 'utf8');
  const manifest = {
    format: 'metis-mcp-package',
    contractVersion: 1,
    packageId: 'safe-search',
    version: '1.0.0',
    name: 'Safe Search',
    description: 'A test MCP package.',
    transport: 'stdio',
    runtime: 'node',
    entry: 'server.mjs',
    args: [],
    environment: [{
      name: 'SEARCH_TOKEN',
      secretRef: '${secret:SEARCH_TOKEN}',
      required: true,
      description: 'Search service token',
    }],
    tools: [{ name: 'search', description: 'Search', inputSchema: INPUT_SCHEMA }],
    files: [{
      path: 'server.mjs',
      url: 'https://packages.example.org/server.mjs',
      sha256: digest(bytes),
      size: bytes.length,
    }],
  };
  return { bytes, manifest, manifestJson: JSON.stringify(manifest) };
}

function configure(network: FakeNetwork, source?: string) {
  const fixture = packageFixture(source);
  network.set('https://packages.example.org/manifest.json', fixture.manifestJson);
  network.set('https://packages.example.org/server.mjs', fixture.bytes);
  return fixture;
}

function writeLocalPackage(root: string, source?: string): { directory: string; fixture: ReturnType<typeof packageFixture> } {
  const directory = path.join(root, 'local-mcp-package');
  fs.mkdirSync(directory, { recursive: true });
  const fixture = packageFixture(source);
  fs.writeFileSync(path.join(directory, 'manifest.json'), fixture.manifestJson);
  fs.writeFileSync(path.join(directory, 'server.mjs'), fixture.bytes);
  return { directory, fixture };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationMcpInstaller URL mode', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.10.1',
    '100.64.0.1', '::1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0',
    'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1',
  ])('classifies private DNS result %s as forbidden', (address) => {
    expect(isPrivateMcpNetworkAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows public DNS result %s', (address) => {
      expect(isPrivateMcpNetworkAddress(address)).toBe(false);
    },
  );

  it('downloads and atomically stores a hash-bound package in disabled state', async () => {
    const network = new FakeNetwork();
    const fixture = configure(network);
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network, now: () => 100 });
    const result = await installer.installFromUrl({
      operationId: randomUUID(),
      manifestUrl: 'https://packages.example.org/manifest.json',
      expectedManifestSha256: digest(fixture.manifestJson),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toMatchObject({ state: 'downloaded', enabled: false, installedAt: 100 });
    expect(installer.getLaunchDescriptor(result.record.installationId)).toBeNull();
    expect(fs.readdirSync(temporaryRoots[0]!).some((entry) => entry.startsWith('.staging-'))).toBe(false);
  });

  it('rejects credential URLs before any network access', async () => {
    const network = new FakeNetwork();
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network });
    const result = await installer.installFromUrl({
      operationId: randomUUID(),
      manifestUrl: 'https://user:password@packages.example.org/manifest.json',
      expectedManifestSha256: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(network.calls).toEqual([]);
  });

  it('rejects cross-origin files and file digest tampering', async () => {
    const crossOriginNetwork = new FakeNetwork();
    const crossOrigin = packageFixture();
    crossOrigin.manifest.files[0]!.url = 'https://evil.example.net/server.mjs';
    crossOriginNetwork.set('https://packages.example.org/manifest.json', JSON.stringify(crossOrigin.manifest));
    const first = new PersonalizationMcpInstaller(temporaryRoot(), { network: crossOriginNetwork });
    await expect(first.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    })).resolves.toMatchObject({ ok: false, code: 'unsafe_url' });

    const tamperedNetwork = new FakeNetwork();
    configure(tamperedNetwork);
    tamperedNetwork.set('https://packages.example.org/server.mjs', 'tampered-but-not-hash-bound');
    const second = new PersonalizationMcpInstaller(temporaryRoot(), { network: tamperedNetwork });
    await expect(second.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    })).resolves.toMatchObject({ ok: false, code: 'file_size_mismatch' });
  });

  it('rejects malicious manifests with extra launch fields', async () => {
    const network = new FakeNetwork();
    const fixture = packageFixture();
    network.set('https://packages.example.org/manifest.json', JSON.stringify({
      ...fixture.manifest,
      command: 'powershell.exe',
      shell: true,
    }));
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network });
    await expect(installer.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    })).resolves.toMatchObject({ ok: false, code: 'manifest_invalid' });
  });

  it('refuses duplicate installation and detects manifest replacement before validation', async () => {
    const network = new FakeNetwork();
    configure(network);
    const root = temporaryRoot();
    const installer = new PersonalizationMcpInstaller(root, { network });
    const request = {
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    };
    const installed = await installer.installFromUrl(request);
    expect(installed.ok).toBe(true);
    await expect(installer.installFromUrl({ ...request, operationId: randomUUID() }))
      .resolves.toMatchObject({ ok: false, code: 'already_installed' });
    if (!installed.ok) return;
    const manifestPath = path.join(root, installed.record.installationId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.description = 'tampered after installation';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(installer.staticValidate(installed.record.installationId)).toMatchObject({
      ok: false, code: 'manifest_digest_mismatch',
    });
  });
});

describe('PersonalizationMcpInstaller local package mode', () => {
  it('copies a manifest-bound local directory into the managed store without reading its remote URLs', () => {
    const root = temporaryRoot();
    const { directory, fixture } = writeLocalPackage(root);
    const network = new FakeNetwork();
    const installer = new PersonalizationMcpInstaller(path.join(root, 'managed-store'), { network, now: () => 300 });

    const record = installer.installFromDirectory(directory);

    expect(record).toMatchObject({ packageId: fixture.manifest.packageId, state: 'downloaded', enabled: false, installedAt: 300 });
    expect(network.calls).toEqual([]);
    expect(installer.staticValidate(record.installationId)).toMatchObject({
      ok: true,
      record: { installationId: record.installationId, state: 'static_verified', enabled: false },
    });
    expect(fs.existsSync(path.join(root, 'managed-store', record.installationId, 'server.mjs'))).toBe(true);
  });

  it('rejects local directories with undeclared files before copying anything', () => {
    const root = temporaryRoot();
    const { directory } = writeLocalPackage(root);
    fs.writeFileSync(path.join(directory, 'unlisted.txt'), 'not declared');
    const installer = new PersonalizationMcpInstaller(path.join(root, 'managed-store'));

    expect(() => installer.installFromDirectory(directory)).toThrow('local_package_file_mismatch');
    expect(fs.readdirSync(path.join(root, 'managed-store'))).toEqual([]);
  });
});

describe('PersonalizationMcpInstaller validation and controlled probe', () => {
  it('blocks source capable of process spawning before probe', async () => {
    const network = new FakeNetwork();
    configure(network, "import { spawn } from 'node:child_process';\nspawn('calc');\n");
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network });
    const installed = await installer.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installer.staticValidate(installed.record.installationId)).toMatchObject({
      ok: false, code: 'forbidden_source_construct',
    });
    expect(installer.getLaunchDescriptor(installed.record.installationId)).toBeNull();
  });

  it('enables only after exact tool/schema probe and preserves secret references', async () => {
    const network = new FakeNetwork();
    configure(network);
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network, now: () => 200 });
    const installed = await installer.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    });
    if (!installed.ok) throw new Error('fixture failed to install');
    expect(installer.staticValidate(installed.record.installationId)).toMatchObject({
      ok: true, record: { state: 'static_verified', enabled: false },
    });
    const observed: unknown[] = [];
    const probed = await installer.probeAndEnable(installed.record.installationId, {
      probe: async (request) => {
        observed.push(request);
        return {
          ok: true,
          protocolVersion: '2025-06-18',
          tools: [{ name: 'search', description: 'Search', inputSchema: INPUT_SCHEMA }],
        };
      },
    });
    expect(probed).toMatchObject({ ok: true, record: { state: 'enabled', enabled: true, probedAt: 200 } });
    const descriptor = installer.getLaunchDescriptor(installed.record.installationId);
    expect(descriptor).toMatchObject({
      command: process.execPath,
      shell: false,
      inheritParentEnvironment: false,
      secretRefs: { SEARCH_TOKEN: '${secret:SEARCH_TOKEN}' },
    });
    expect(JSON.stringify(observed)).not.toContain('actual-secret');
  });

  it('fails closed on phantom tools and never publishes a launch descriptor', async () => {
    const network = new FakeNetwork();
    configure(network);
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network });
    const installed = await installer.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    });
    if (!installed.ok) throw new Error('fixture failed to install');
    expect(installer.staticValidate(installed.record.installationId).ok).toBe(true);
    const probed = await installer.probeAndEnable(installed.record.installationId, {
      probe: async () => ({
        ok: true,
        protocolVersion: '2025-06-18',
        tools: [
          { name: 'search', description: 'Search', inputSchema: INPUT_SCHEMA },
          { name: 'phantom_delete_all', description: 'Not declared', inputSchema: INPUT_SCHEMA },
        ],
      }),
    });
    expect(probed).toMatchObject({ ok: false, code: 'phantom_or_missing_tool' });
    expect(installer.getLaunchDescriptor(installed.record.installationId)).toBeNull();
  });

  it('uses the Metis-selected executable and literal arguments with shell disabled', async () => {
    const network = new FakeNetwork();
    const fixture = configure(network);
    fixture.manifest.args = ['; calc.exe', '$(whoami)', '--flag'];
    network.set('https://packages.example.org/manifest.json', JSON.stringify(fixture.manifest));
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network });
    const installed = await installer.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    });
    if (!installed.ok) throw new Error('fixture failed to install');
    expect(installer.staticValidate(installed.record.installationId).ok).toBe(true);
    await installer.probeAndEnable(installed.record.installationId, {
      probe: async () => ({
        ok: true, protocolVersion: '2025-06-18',
        tools: [{ name: 'search', description: 'Search', inputSchema: INPUT_SCHEMA }],
      }),
    });
    const descriptor = installer.getLaunchDescriptor(installed.record.installationId);
    expect(descriptor?.command).toBe(process.execPath);
    expect(descriptor?.args.slice(1)).toEqual(['; calc.exe', '$(whoami)', '--flag']);
    expect(descriptor?.shell).toBe(false);
    expect(descriptor?.inheritParentEnvironment).toBe(false);
  });

  it('captures a strict pre-probe snapshot and CAS-rolls back only its matching enabled transition', async () => {
    const network = new FakeNetwork();
    configure(network);
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network, now: () => 300 });
    const installed = await installer.installFromUrl({
      operationId: randomUUID(), manifestUrl: 'https://packages.example.org/manifest.json', expectedManifestSha256: null,
    });
    if (!installed.ok) throw new Error('fixture failed to install');
    const verified = installer.staticValidate(installed.record.installationId);
    if (!verified.ok || !verified.record) throw new Error('fixture failed static validation');
    const snapshot = installer.captureProbeRollback(installed.record.installationId);
    expect(snapshot).toMatchObject({ record: { state: 'static_verified', enabled: false } });
    if (!snapshot) throw new Error('missing rollback snapshot');

    const enabled = await installer.probeAndEnable(installed.record.installationId, {
      probe: async () => ({
        ok: true, protocolVersion: '2025-06-18',
        tools: [{ name: 'search', description: 'Search', inputSchema: INPUT_SCHEMA }],
      }),
    });
    if (!enabled.ok || !enabled.record) throw new Error('fixture failed probe');
    expect(installer.readInstalledRecord(installed.record.installationId)).toEqual(enabled.record);

    expect(installer.rollbackEnabledProbe(snapshot, { ...enabled.record, packageId: 'substituted' })).toBe(false);
    expect(installer.getLaunchDescriptor(installed.record.installationId)).not.toBeNull();
    expect(installer.rollbackEnabledProbe({ ...snapshot, recordDigest: '0'.repeat(64) }, enabled.record)).toBe(false);
    expect(installer.rollbackEnabledProbe(snapshot, enabled.record)).toBe(true);
    expect(installer.readInstalledRecord(installed.record.installationId)).toEqual(verified.record);
    expect(installer.getLaunchDescriptor(installed.record.installationId)).toBeNull();
    expect(installer.rollbackEnabledProbe(snapshot, enabled.record)).toBe(false);
  });
});
