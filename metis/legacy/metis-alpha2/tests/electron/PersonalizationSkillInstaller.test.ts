import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';
import type { SkillPackageManifest } from '../../engine/runtime/SkillInstallationContract.js';

const roots: string[] = [];

function temporaryDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  externalAttributes?: number;
  method?: 0 | 8;
  flags?: number;
}

function createStoredZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const flags = 0x800 | (entry.flags ?? 0);
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.externalAttributes ?? (0o100600 << 16)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralOffset = offset;
  const centralBody = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBody.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralBody, eocd]);
}

function packageFixture(options: {
  id?: string;
  version?: string;
  prefix?: string;
  corruptDigest?: boolean;
  extraEntries?: ZipEntry[];
  compressed?: boolean;
} = {}): { manifest: SkillPackageManifest; archive: Buffer; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>([
    ['SKILL.md', Buffer.from('# Evidence synthesis\n\nUse sources carefully.\n', 'utf8')],
    ['scripts/analyze.mjs', Buffer.from('export function analyze(input) { return input.length; }\n', 'utf8')],
    ['references/schema.json', Buffer.from('{"type":"object"}\n', 'utf8')],
  ]);
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id: options.id ?? 'user:skills/evidence-synthesis',
    name: 'Evidence synthesis',
    description: 'A real package fixture with documentation, a retained script, and a schema.',
    version: options.version ?? '1.0.0',
    author: 'Metis test',
    license: 'Apache-2.0',
    entry: 'SKILL.md',
    systemPromptFile: 'SKILL.md',
    files: [...files.entries()].map(([filePath, data], index) => ({
      path: filePath,
      size: data.length,
      sha256: options.corruptDigest && index === 0 ? '0'.repeat(64) : digest(data),
      role: filePath === 'SKILL.md' ? 'documentation' : filePath.endsWith('.mjs') ? 'script' : 'schema',
      executable: filePath.endsWith('.mjs'),
    })),
  };
  const prefix = options.prefix ?? '';
  const entries: ZipEntry[] = [
    { name: `${prefix}metis-skill.json`, data: Buffer.from(JSON.stringify(manifest), 'utf8'), method: options.compressed ? 8 as const : 0 as const },
    ...[...files.entries()].map(([name, data]) => ({ name: `${prefix}${name}`, data, method: options.compressed ? 8 as const : 0 as const })),
    ...(options.extraEntries ?? []),
  ];
  return { manifest, archive: createStoredZip(entries), files };
}

function writeArchive(root: string, archive: Buffer, name = 'skill.zip'): string {
  const archivePath = path.join(root, name);
  fs.writeFileSync(archivePath, archive);
  return archivePath;
}

function publicLookup() {
  return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationSkillInstaller local package boundary', () => {
  it('installs a strict ZIP atomically and retains documentation, scripts, and schemas without executing them', () => {
    const root = temporaryDirectory('metis-skill-installer-');
    const { manifest, archive, files } = packageFixture({ prefix: 'repo-main/', compressed: true });
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), { now: () => 1234 });
    const result = installer.installFromPackage(writeArchive(root, archive));

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.installed.manifest).toEqual(manifest);
    expect(result.installed.provenance.sourceMode).toBe('package');
    expect(result.installed.packageDigest).toBe(digest(archive));
    const installDirectory = installer.resolveInstalledDirectory(result.installed.id, result.installed.version);
    expect(installDirectory).toBeDefined();
    for (const [name, content] of files) {
      expect(fs.readFileSync(path.join(installDirectory!, ...name.split('/')))).toEqual(content);
    }
    expect(installer.listInstalled(manifest.id)).toMatchObject([{ version: '1.0.0', active: true }]);
  });

  it('installs a directory package after rejecting symlinks and undeclared files', () => {
    const root = temporaryDirectory('metis-skill-directory-');
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    const fixture = packageFixture();
    for (const [name, content] of fixture.files) {
      fs.mkdirSync(path.dirname(path.join(source, ...name.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(source, ...name.split('/')), content);
    }
    fs.writeFileSync(path.join(source, 'metis-skill.json'), JSON.stringify(fixture.manifest));
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    expect(installer.installFromPackage(source).ok).toBe(true);

    const dirtySource = path.join(root, 'dirty-source');
    fs.cpSync(source, dirtySource, { recursive: true });
    fs.writeFileSync(path.join(dirtySource, 'undeclared.txt'), 'not declared');
    expect(installer.installFromPackage(dirtySource)).toMatchObject({ ok: false, code: 'file_mismatch' });
  });

  it.each([
    {
      label: 'path traversal',
      fixture: () => packageFixture({ extraEntries: [{ name: '../escape.txt', data: Buffer.from('escape') }] }),
      code: 'path_invalid',
    },
    {
      label: 'symbolic link entry',
      fixture: () => packageFixture({ extraEntries: [{ name: 'link', data: Buffer.from('target'), externalAttributes: 0o120777 << 16 }] }),
      code: 'symlink_rejected',
    },
    {
      label: 'manifest hash mismatch',
      fixture: () => packageFixture({ corruptDigest: true }),
      code: 'file_mismatch',
    },
    {
      label: 'undeclared file',
      fixture: () => packageFixture({ extraEntries: [{ name: 'extra.txt', data: Buffer.from('extra') }] }),
      code: 'file_mismatch',
    },
  ])('rejects $label without publishing files', ({ fixture, code }) => {
    const root = temporaryDirectory('metis-skill-reject-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    const result = installer.installFromPackage(writeArchive(root, fixture().archive));
    expect(result).toMatchObject({ ok: false, code });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('rejects duplicate case-folded paths', () => {
    const root = temporaryDirectory('metis-skill-duplicate-');
    const fixture = packageFixture({ extraEntries: [{ name: 'skill.md', data: Buffer.from('duplicate') }] });
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    expect(installer.installFromPackage(writeArchive(root, fixture.archive))).toMatchObject({ ok: false, code: 'duplicate_path' });
  });

  it.each([
    {
      label: 'encrypted entry',
      archive: () => packageFixture({ extraEntries: [{ name: 'encrypted.bin', data: Buffer.from('encrypted'), flags: 0x1 }] }).archive,
      code: 'archive_encrypted',
    },
    {
      label: 'compression bomb ratio',
      archive: () => packageFixture({ extraEntries: [{ name: 'bomb.bin', data: Buffer.alloc(100_000), method: 8 }] }).archive,
      code: 'compression_ratio_exceeded',
    },
    {
      label: 'missing manifest',
      archive: () => createStoredZip([{ name: 'SKILL.md', data: Buffer.from('# no manifest') }]),
      code: 'manifest_missing',
    },
    {
      label: 'ambiguous manifests',
      archive: () => {
        const fixture = packageFixture();
        return packageFixture({ extraEntries: [{ name: 'nested/metis-skill.json', data: Buffer.from(JSON.stringify(fixture.manifest)) }] }).archive;
      },
      code: 'manifest_ambiguous',
    },
  ])('rejects $label before publication', ({ archive, code }) => {
    const root = temporaryDirectory('metis-skill-archive-attack-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    expect(installer.installFromPackage(writeArchive(root, archive()))).toMatchObject({ ok: false, code });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('rolls back a published version when active pointer publication fails', () => {
    const root = temporaryDirectory('metis-skill-rollback-');
    const fixture = packageFixture();
    const store = path.join(root, 'store');
    const installer = new PersonalizationSkillInstaller(store);
    const packageRoot = path.join(store, 'skills', digest(fixture.manifest.id));
    fs.mkdirSync(path.join(packageRoot, 'active.json'), { recursive: true });

    const result = installer.installFromPackage(writeArchive(root, fixture.archive));
    expect(result).toMatchObject({ ok: false, code: 'publish_failed' });
    expect(fs.existsSync(path.join(packageRoot, 'versions', fixture.manifest.version))).toBe(false);
    expect(installer.listInstalled()).toEqual([]);
  });

  it('uses an exclusive per-skill lock to reject concurrent mutation without staging pollution', () => {
    const root = temporaryDirectory('metis-skill-lock-');
    const fixture = packageFixture();
    const store = path.join(root, 'store');
    const installer = new PersonalizationSkillInstaller(store);
    const packageRoot = path.join(store, 'skills', digest(fixture.manifest.id));
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, '.install.lock'), '{"pid":1}', { flag: 'wx' });

    const result = installer.installFromPackage(writeArchive(root, fixture.archive));
    expect(result).toMatchObject({ ok: false, code: 'install_conflict' });
    expect(installer.listInstalled()).toEqual([]);
    expect(fs.readdirSync(path.join(store, '.staging'))).toEqual([]);
  });

  it('recovers an exact dead-process install lock after restart without retaining staging residue', () => {
    const root = temporaryDirectory('metis-skill-stale-lock-');
    const fixture = packageFixture();
    const store = path.join(root, 'store');
    const installer = new PersonalizationSkillInstaller(store);
    const packageRoot = path.join(store, 'skills', digest(fixture.manifest.id));
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, '.install.lock'), JSON.stringify({
      format: 'metis-skill-install-lock',
      version: 1,
      pid: 2_147_483_647,
      createdAt: 1,
      nonce: '00000000-0000-4000-8000-000000000001',
    }), { flag: 'wx' });

    const result = installer.installFromPackage(writeArchive(root, fixture.archive));

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, '.install.lock'))).toBe(false);
    expect(fs.readdirSync(path.join(store, '.staging'))).toEqual([]);
  });

  it('keeps versions side by side, switches the active version, and uninstalls without touching the other version', () => {
    const root = temporaryDirectory('metis-skill-versions-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    const one = packageFixture({ version: '1.0.0' });
    const two = packageFixture({ version: '2.0.0' });
    expect(installer.installFromPackage(writeArchive(root, one.archive, 'one.zip')).ok).toBe(true);
    expect(installer.installFromPackage(writeArchive(root, two.archive, 'two.zip')).ok).toBe(true);
    expect(installer.listInstalled(one.manifest.id).map((entry) => [entry.version, entry.active])).toEqual([
      ['2.0.0', true],
      ['1.0.0', false],
    ]);
    expect(installer.setActiveVersion(one.manifest.id, '1.0.0').ok).toBe(true);
    expect(installer.uninstall(one.manifest.id, '1.0.0')).toEqual({ ok: true, removedVersions: ['1.0.0'] });
    expect(installer.getInstalled(one.manifest.id)?.version).toBe('2.0.0');
    expect(installer.installFromPackage(writeArchive(root, two.archive, 'two-again.zip'))).toMatchObject({ ok: false, code: 'already_installed' });
  });

  it('fails closed when installed payload or install metadata is tampered', () => {
    const root = temporaryDirectory('metis-skill-tamper-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    const fixture = packageFixture();
    const installed = installer.installFromPackage(writeArchive(root, fixture.archive));
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const installDirectory = installer.resolveInstalledDirectory(installed.installed.id, installed.installed.version);
    expect(installDirectory).toBeDefined();
    fs.writeFileSync(path.join(installDirectory!, 'SKILL.md'), 'tampered');
    expect(installer.getInstalled(fixture.manifest.id)).toBeUndefined();

    const versionTwo = packageFixture({ version: '2.0.0' });
    const installedTwo = installer.installFromPackage(writeArchive(root, versionTwo.archive, 'two.zip'));
    expect(installedTwo.ok).toBe(true);
    if (!installedTwo.ok) return;
    const versionTwoDirectory = installer.resolveInstalledDirectory(installedTwo.installed.id, installedTwo.installed.version);
    expect(versionTwoDirectory).toBeDefined();
    const recordPath = path.join(versionTwoDirectory!, 'metis-install.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, forgedTrusted: true }));
    expect(installer.getInstalled(versionTwo.manifest.id, '2.0.0')).toBeUndefined();
  });

  it('never imports a process execution primitive for retained third-party scripts', () => {
    const source = fs.readFileSync(path.resolve('electron/PersonalizationSkillInstaller.ts'), 'utf8');
    expect(source).not.toMatch(/node:child_process|\bexecFile(?:Sync)?\b|\bspawn(?:Sync)?\b/u);
  });
});

describe('PersonalizationSkillInstaller URL and GitHub boundary', () => {
  it('downloads a valid archive with digest provenance and no partial download files', async () => {
    const root = temporaryDirectory('metis-skill-url-');
    const fixture = packageFixture({ id: 'url:skills/evidence-synthesis' });
    const fetchStub: typeof fetch = async () => new Response(fixture.archive, {
      status: 200,
      headers: { 'content-type': 'application/zip', 'content-length': String(fixture.archive.length) },
    });
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      fetch: fetchStub,
      lookup: publicLookup,
      now: () => 5678,
    });
    const result = await installer.installFromUrl('https://example.com/skill.zip', {
      expectedArchiveSha256: digest(fixture.archive),
      expectedId: fixture.manifest.id,
      expectedVersion: fixture.manifest.version,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed.provenance).toMatchObject({
      sourceMode: 'url',
      sourceUrl: 'https://example.com/skill.zip',
      resolvedUrl: 'https://example.com/skill.zip',
      archiveSha256: digest(fixture.archive),
      installedAt: 5678,
    });
    expect(fs.readdirSync(path.join(root, 'store', '.staging'))).toEqual([]);
  });

  it('normalizes a GitHub repository and permits only the controlled GitHub redirect chain', async () => {
    const root = temporaryDirectory('metis-skill-github-');
    const fixture = packageFixture({ id: 'url:skills/github-skill', prefix: 'repository-main/' });
    const seen: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith('https://api.github.com/repos/owner/repository/zipball')) {
        return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/owner/repository/legacy.zip/main' } });
      }
      return new Response(fixture.archive, { status: 200, headers: { 'content-type': 'application/zip' } });
    };
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), { fetch: fetchStub, lookup: publicLookup });
    const result = await installer.installFromUrl('https://github.com/owner/repository');
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      'https://api.github.com/repos/owner/repository/zipball',
      'https://codeload.github.com/owner/repository/legacy.zip/main',
    ]);
    if (result.ok) expect(result.installed.provenance.redirectChain).toEqual(['https://codeload.github.com/owner/repository/legacy.zip/main']);
  });

  it.each([
    ['credential URL', 'https://user:secret@example.com/skill.zip', 'url_invalid'],
    ['localhost URL', 'http://localhost/skill.zip', 'url_invalid'],
    ['private literal URL', 'http://127.0.0.1/skill.zip', 'url_invalid'],
  ])('rejects %s before fetching', async (_label, url, code) => {
    const root = temporaryDirectory('metis-skill-url-reject-');
    let called = false;
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      fetch: (async () => { called = true; return new Response(); }) as typeof fetch,
      lookup: publicLookup,
    });
    await expect(installer.installFromUrl(url)).resolves.toMatchObject({ ok: false, code });
    expect(called).toBe(false);
  });

  it('rejects DNS rebinding to a private address', async () => {
    const root = temporaryDirectory('metis-skill-dns-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      fetch: (async () => new Response()) as typeof fetch,
      lookup: async () => [{ address: '10.0.0.7', family: 4 }],
    });
    await expect(installer.installFromUrl('https://example.com/skill.zip')).resolves.toMatchObject({ ok: false, code: 'private_network_rejected' });
  });

  it.each([
    'fec0::1',
    '2001:2::1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::7f00:1',
  ])('rejects reserved IPv6 DNS answer %s before fetching', async (address) => {
    const root = temporaryDirectory('metis-skill-ipv6-dns-');
    let fetched = false;
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      fetch: (async () => { fetched = true; return new Response(); }) as typeof fetch,
      lookup: async () => [{ address, family: 6 }],
    });

    await expect(installer.installFromUrl('https://example.com/skill.zip'))
      .resolves.toMatchObject({ ok: false, code: 'private_network_rejected' });
    expect(fetched).toBe(false);
  });

  it('rejects cross-host redirects, unsupported content types, and archive digest mismatch without installation pollution', async () => {
    const fixture = packageFixture({ id: 'url:skills/rejected' });

    const redirectRoot = temporaryDirectory('metis-skill-redirect-');
    const redirectInstaller = new PersonalizationSkillInstaller(path.join(redirectRoot, 'store'), {
      lookup: publicLookup,
      fetch: (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/skill.zip' } })) as typeof fetch,
    });
    await expect(redirectInstaller.installFromUrl('https://example.com/skill.zip')).resolves.toMatchObject({ ok: false, code: 'redirect_rejected' });

    const typeRoot = temporaryDirectory('metis-skill-type-');
    const typeInstaller = new PersonalizationSkillInstaller(path.join(typeRoot, 'store'), {
      lookup: publicLookup,
      fetch: (async () => new Response(fixture.archive, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
    });
    await expect(typeInstaller.installFromUrl('https://example.com/skill.zip')).resolves.toMatchObject({ ok: false, code: 'content_type_rejected' });

    const digestRoot = temporaryDirectory('metis-skill-digest-');
    const digestInstaller = new PersonalizationSkillInstaller(path.join(digestRoot, 'store'), {
      lookup: publicLookup,
      fetch: (async () => new Response(fixture.archive, { status: 200, headers: { 'content-type': 'application/zip' } })) as typeof fetch,
    });
    await expect(digestInstaller.installFromUrl('https://example.com/skill.zip', { expectedArchiveSha256: 'f'.repeat(64) }))
      .resolves.toMatchObject({ ok: false, code: 'digest_mismatch' });
    expect(digestInstaller.listInstalled()).toEqual([]);
  });

  it('enforces the streamed download limit even when content-length is absent', async () => {
    const root = temporaryDirectory('metis-skill-download-limit-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      lookup: publicLookup,
      maxArchiveBytes: 64,
      fetch: (async () => new Response(Buffer.alloc(65), { status: 200, headers: { 'content-type': 'application/zip' } })) as typeof fetch,
    });
    await expect(installer.installFromUrl('https://example.com/skill.zip')).resolves.toMatchObject({ ok: false, code: 'download_too_large' });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('applies a download timeout to both headers and body', async () => {
    const root = temporaryDirectory('metis-skill-timeout-');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      lookup: publicLookup,
      timeoutMs: 5,
      fetch: ((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch,
    });
    await expect(installer.installFromUrl('https://example.com/slow.zip')).resolves.toMatchObject({ ok: false, code: 'download_failed' });

    const bodyRoot = temporaryDirectory('metis-skill-body-timeout-');
    const bodyInstaller = new PersonalizationSkillInstaller(path.join(bodyRoot, 'store'), {
      lookup: publicLookup,
      timeoutMs: 5,
      fetch: (async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'application/zip' } })) as typeof fetch,
    });
    await expect(bodyInstaller.installFromUrl('https://example.com/slow-body.zip')).resolves.toMatchObject({ ok: false, code: 'download_failed' });
  });

  it('updates from recorded provenance while retaining the prior version and supports a full uninstall', async () => {
    const root = temporaryDirectory('metis-skill-update-');
    const one = packageFixture({ id: 'url:skills/updateable', version: '1.0.0' });
    const two = packageFixture({ id: 'url:skills/updateable', version: '1.1.0' });
    const archives = [one.archive, two.archive];
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'), {
      lookup: publicLookup,
      fetch: (async () => {
        const archive = archives.shift();
        return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } });
      }) as typeof fetch,
    });
    expect((await installer.installFromUrl('https://example.com/updateable.zip')).ok).toBe(true);
    expect((await installer.updateFromUrl(one.manifest.id)).ok).toBe(true);
    expect(installer.listInstalled(one.manifest.id).map((entry) => entry.version)).toEqual(['1.1.0', '1.0.0']);
    expect(installer.uninstall(one.manifest.id)).toEqual({ ok: true, removedVersions: ['1.1.0', '1.0.0'] });
    expect(installer.listInstalled(one.manifest.id)).toEqual([]);
  });
});
