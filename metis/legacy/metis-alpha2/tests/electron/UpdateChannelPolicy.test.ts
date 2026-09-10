/**
 * Update trust model tests — channel resolution, policy sync with the JSON
 * mirror, runtime Authenticode verification parsing, and the channel-aware
 * AutoUpdaterService install gate (stable must never install unsigned).
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

import {
  UPDATE_PUBLISH_TARGET,
  UPDATE_TRUST_POLICY,
  isSignatureAcceptable,
  resolveUpdateChannel,
} from '../../electron/UpdateChannelPolicy.js';
import { verifyAuthenticodeSignature, type SpawnLike } from '../../electron/UpdateSignatureVerifier.js';
import { AutoUpdaterService, type AutoUpdaterLike, type AutoUpdateEvent } from '../../electron/AutoUpdaterService.js';

const ROOT = resolve(__dirname, '../..');

describe('resolveUpdateChannel', () => {
  it('treats unpackaged runs as dev', () => {
    expect(resolveUpdateChannel({ isPackaged: false, appVersion: '1.0.0' })).toBe('dev');
    expect(resolveUpdateChannel({ isPackaged: false, appVersion: '0.1.0-alpha.3' })).toBe('dev');
  });

  it('classifies packaged prerelease versions as alpha and plain versions as stable', () => {
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '0.1.0-alpha.3' })).toBe('alpha');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '0.2.0-beta.1' })).toBe('alpha');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '1.0.0-rc.1' })).toBe('alpha');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '1.0.0' })).toBe('stable');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '0.1.0' })).toBe('stable');
  });

  it('honors a valid environment override and ignores invalid ones', () => {
    expect(resolveUpdateChannel({ isPackaged: false, appVersion: '1.0.0', envOverride: 'stable' })).toBe('stable');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '1.0.0', envOverride: 'alpha' })).toBe('alpha');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '1.0.0', envOverride: 'nightly' })).toBe('stable');
    expect(resolveUpdateChannel({ isPackaged: true, appVersion: '1.0.0', envOverride: '' })).toBe('stable');
  });
});

describe('UPDATE_TRUST_POLICY', () => {
  it('stable never allows unsigned install and never auto-downloads; alpha discloses unsigned state', () => {
    expect(UPDATE_TRUST_POLICY.channels.stable.requireSignature).toBe(true);
    expect(UPDATE_TRUST_POLICY.channels.stable.allowUnsignedInstall).toBe(false);
    expect(UPDATE_TRUST_POLICY.channels.stable.autoDownload).toBe(false);
    expect(UPDATE_TRUST_POLICY.channels.alpha.discloseUnsigned).toBe(true);
    expect(UPDATE_TRUST_POLICY.channels.alpha.trustLabel).toMatch(/UNSIGNED/);
    expect(UPDATE_TRUST_POLICY.channels.alpha.trustLabel).toMatch(/NOT RELEASE SAFE/);
    expect(UPDATE_TRUST_POLICY.channels.dev.trustLabel).toMatch(/DEV ONLY/);
  });

  it('stays in sync with build/update-trust-policy.json', () => {
    const mirror = JSON.parse(readFileSync(resolve(ROOT, 'build/update-trust-policy.json'), 'utf8')) as {
      schemaVersion: number;
      publishTarget: typeof UPDATE_PUBLISH_TARGET;
      channels: typeof UPDATE_TRUST_POLICY.channels;
      expectedSignerSubject: string | null;
    };
    expect(mirror.schemaVersion).toBe(UPDATE_TRUST_POLICY.schemaVersion);
    expect(mirror.channels).toEqual(UPDATE_TRUST_POLICY.channels);
    expect(mirror.expectedSignerSubject).toEqual(UPDATE_TRUST_POLICY.expectedSignerSubject);
    expect(mirror.publishTarget).toEqual(UPDATE_PUBLISH_TARGET);
  });

  it('publish target matches package.json build.publish', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      build: { publish: Array<{ provider: string; owner: string; repo: string }> };
    };
    const publish = pkg.build.publish[0];
    expect(publish.provider).toBe(UPDATE_PUBLISH_TARGET.provider);
    expect(publish.owner).toBe(UPDATE_PUBLISH_TARGET.owner);
    expect(publish.repo).toBe(UPDATE_PUBLISH_TARGET.repo);
  });
});

describe('isSignatureAcceptable', () => {
  it('rejects unverified signatures regardless of subject', () => {
    expect(isSignatureAcceptable(UPDATE_TRUST_POLICY, { verified: false, status: 'NotSigned', signerSubject: null })).toBe(false);
    expect(isSignatureAcceptable(UPDATE_TRUST_POLICY, { verified: false, status: 'HashMismatch', signerSubject: 'CN=Metis' })).toBe(false);
  });

  it('accepts any valid signature while no signer subject is configured', () => {
    expect(UPDATE_TRUST_POLICY.expectedSignerSubject).toBeNull();
    expect(isSignatureAcceptable(UPDATE_TRUST_POLICY, { verified: true, status: 'Valid', signerSubject: 'CN=Anyone' })).toBe(true);
  });

  it('requires the configured signer subject once one exists', () => {
    const pinned = { ...UPDATE_TRUST_POLICY, expectedSignerSubject: 'CN=Metis Research' };
    expect(isSignatureAcceptable(pinned, { verified: true, status: 'Valid', signerSubject: 'CN=Metis Research, O=Metis' })).toBe(true);
    expect(isSignatureAcceptable(pinned, { verified: true, status: 'Valid', signerSubject: 'CN=Somebody Else' })).toBe(false);
    expect(isSignatureAcceptable(pinned, { verified: true, status: 'Valid', signerSubject: null })).toBe(false);
  });
});

// ── Runtime Authenticode verification (PowerShell fake) ──────────────────────

function fakeSpawn(script: { code: number; stdout?: string; stderr?: string; neverClose?: boolean }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void; killed: boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    if (!script.neverClose) {
      setTimeout(() => {
        if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
        if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
        child.emit('close', script.code);
      }, 0);
    }
    return child;
  }) as unknown as SpawnLike;
  return { spawnImpl, calls };
}

const onWindows = process.platform === 'win32';

describe('verifyAuthenticodeSignature', () => {
  it.runIf(onWindows)('reports a Valid Authenticode status as verified with the signer subject', async () => {
    const { spawnImpl, calls } = fakeSpawn({ code: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Metis Research, O=Metis' }) });
    const result = await verifyAuthenticodeSignature('C:\\Users\\x\\AppData\\Local\\metis-updater\\Setup.exe', { spawnImpl });
    expect(result).toEqual({ verified: true, status: 'Valid', signerSubject: 'CN=Metis Research, O=Metis', error: null });
    expect(calls[0].cmd).toBe('powershell.exe');
    expect(calls[0].args).toContain('-NonInteractive');
    expect(calls[0].args.join(' ')).toContain("Get-AuthenticodeSignature -LiteralPath 'C:\\Users\\x\\AppData\\Local\\metis-updater\\Setup.exe'");
  });

  it.runIf(onWindows)('reports NotSigned as unverified (fail-safe) with the status preserved', async () => {
    const { spawnImpl } = fakeSpawn({ code: 0, stdout: JSON.stringify({ status: 'NotSigned', subject: null }) });
    const result = await verifyAuthenticodeSignature('C:\\tmp\\Setup.exe', { spawnImpl });
    expect(result.verified).toBe(false);
    expect(result.status).toBe('NotSigned');
    expect(result.error).toBe('authenticode-NotSigned');
  });

  it.runIf(onWindows)('escapes single quotes in the artifact path for PowerShell', async () => {
    const { spawnImpl, calls } = fakeSpawn({ code: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=X' }) });
    await verifyAuthenticodeSignature("C:\\It's Here\\Setup.exe", { spawnImpl });
    expect(calls[0].args.join(' ')).toContain("-LiteralPath 'C:\\It''s Here\\Setup.exe'");
  });

  it.runIf(onWindows)('treats a non-zero PowerShell exit, unparseable output, and timeout as unverified', async () => {
    const exitFail = await verifyAuthenticodeSignature('C:\\tmp\\Setup.exe', { spawnImpl: fakeSpawn({ code: 1, stderr: 'boom' }).spawnImpl });
    expect(exitFail.verified).toBe(false);
    expect(exitFail.error).toMatch(/powershell-exit-1/);

    const garbage = await verifyAuthenticodeSignature('C:\\tmp\\Setup.exe', { spawnImpl: fakeSpawn({ code: 0, stdout: 'not json' }).spawnImpl });
    expect(garbage.verified).toBe(false);
    expect(garbage.error).toMatch(/unparseable-signature-output/);

    const hang = fakeSpawn({ code: 0, neverClose: true });
    const timedOut = await verifyAuthenticodeSignature('C:\\tmp\\Setup.exe', { spawnImpl: hang.spawnImpl, timeoutMs: 20 });
    expect(timedOut.verified).toBe(false);
    expect(timedOut.error).toBe('signature-verification-timeout');
  });

  it.runIf(onWindows)('rejects an empty artifact path without spawning anything', async () => {
    const { spawnImpl, calls } = fakeSpawn({ code: 0 });
    const result = await verifyAuthenticodeSignature('', { spawnImpl });
    expect(result).toEqual({ verified: false, status: null, signerSubject: null, error: 'missing-artifact-path' });
    expect(calls).toHaveLength(0);
  });
});

// ── Channel-aware AutoUpdaterService ─────────────────────────────────────────

function fakeUpdater(extra: Partial<AutoUpdaterLike> = {}) {
  const handlers = new Map<string, Array<(...args: never[]) => void>>();
  const updater = {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return undefined;
    }),
    emit(event: string, ...args: never[]) {
      (handlers.get(event) ?? []).forEach((fn) => fn(...args));
    },
    checkForUpdatesAndNotify: vi.fn(async () => {}),
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    autoDownload: true,
    ...extra,
  };
  return updater as typeof updater & AutoUpdaterLike;
}

function collect(service: AutoUpdaterService) {
  const events: AutoUpdateEvent[] = [];
  service.on('event', (e: AutoUpdateEvent) => events.push(e));
  return events;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AutoUpdaterService channel trust gate', () => {
  it('dev channel disables in-app updates without touching the updater', () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({ updaterFactory: () => updater, channel: 'dev' });
    const events = collect(service);
    service.init();
    expect(events).toEqual([{ type: 'disabled', reason: UPDATE_TRUST_POLICY.channels.dev.trustLabel }]);
    expect(updater.on).not.toHaveBeenCalled();
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('legacy construction without channel information keeps alpha behavior', () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService(() => updater);
    service.init();
    expect(service.channel).toBe('alpha');
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
  });

  it('resolves the channel from packaging state and version when no explicit channel is given', () => {
    expect(new AutoUpdaterService({ isPackaged: false, appVersion: '1.0.0' }).channel).toBe('dev');
    expect(new AutoUpdaterService({ isPackaged: true, appVersion: '0.1.0-alpha.3' }).channel).toBe('alpha');
    expect(new AutoUpdaterService({ isPackaged: true, appVersion: '1.0.0' }).channel).toBe('stable');
    expect(new AutoUpdaterService({ isPackaged: true, appVersion: '1.0.0', envChannelOverride: 'alpha' }).channel).toBe('alpha');
  });

  it('alpha switches the feed to GitHub prereleases, auto-downloads, and allows install while disclosing UNSIGNED', async () => {
    const updater = fakeUpdater();
    const verify = vi.fn(async () => ({ verified: false, status: 'NotSigned', signerSubject: null }));
    const service = new AutoUpdaterService({ updaterFactory: () => updater, channel: 'alpha', verifySignature: verify });
    const events = collect(service);
    service.init();
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github', owner: UPDATE_PUBLISH_TARGET.owner, repo: UPDATE_PUBLISH_TARGET.repo, releaseType: 'prerelease',
    });
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(updater.autoDownload).toBe(true);

    updater.emit('update-downloaded', { version: '0.1.0-alpha.4', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    await flush();
    const downloaded = events.filter((e) => e.type === 'downloaded');
    expect(downloaded.length).toBeGreaterThanOrEqual(1);
    const trust = service.getTrustState();
    expect(trust.channel).toBe('alpha');
    expect(trust.installAllowed).toBe(true);
    expect(trust.signed).toBe(false);
    expect(trust.signatureStatus).toBe('NotSigned');
    expect(trust.trustLabel).toMatch(/UNSIGNED/);
    expect(verify).toHaveBeenCalledWith('C:\\tmp\\Setup.exe');

    expect(service.quitAndInstall()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('stable disables auto-download and checks without notify-download', () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({ updaterFactory: () => updater, channel: 'stable', verifySignature: async () => ({ verified: true, status: 'Valid', signerSubject: 'CN=X' }) });
    service.init();
    expect(updater.autoDownload).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it('stable BLOCKS install of an unsigned download and emits install-blocked (never calls quitAndInstall)', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({
      updaterFactory: () => updater,
      channel: 'stable',
      verifySignature: async () => ({ verified: false, status: 'NotSigned', signerSubject: null, error: 'authenticode-NotSigned' }),
    });
    const events = collect(service);
    service.init();
    updater.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    await flush();

    const trust = service.getTrustState();
    expect(trust.installAllowed).toBe(false);
    expect(trust.signed).toBe(false);
    expect(trust.installBlockReason).toBe('authenticode-NotSigned');

    expect(service.quitAndInstall()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'install-blocked', version: '1.1.0', reason: 'authenticode-NotSigned' });
  });

  it('stable blocks install while verification is still pending (no optimistic install)', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({
      updaterFactory: () => updater,
      channel: 'stable',
      verifySignature: () => new Promise(() => { /* never resolves */ }),
    });
    const events = collect(service);
    service.init();
    updater.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    expect(service.getTrustState().signed).toBeNull();
    expect(service.quitAndInstall()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'install-blocked', version: '1.1.0', reason: 'signature-verification-pending' });
  });

  it('stable blocks install when no signature verifier is available', () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({ updaterFactory: () => updater, channel: 'stable' });
    service.init();
    updater.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    expect(service.getTrustState().installBlockReason).toBe('signature-verifier-unavailable');
    expect(service.quitAndInstall()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('stable installs when the Authenticode signature is valid', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({
      updaterFactory: () => updater,
      channel: 'stable',
      verifySignature: async () => ({ verified: true, status: 'Valid', signerSubject: 'CN=Metis Research' }),
    });
    service.init();
    updater.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    await flush();
    const trust = service.getTrustState();
    expect(trust.signed).toBe(true);
    expect(trust.installAllowed).toBe(true);
    expect(trust.signerSubject).toBe('CN=Metis Research');
    expect(service.quitAndInstall()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('stable rejects a valid signature from the wrong signer once a subject is pinned', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({
      updaterFactory: () => updater,
      channel: 'stable',
      policy: { ...UPDATE_TRUST_POLICY, expectedSignerSubject: 'CN=Metis Research' },
      verifySignature: async () => ({ verified: true, status: 'Valid', signerSubject: 'CN=Impostor' }),
    });
    service.init();
    updater.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    await flush();
    expect(service.getTrustState().installAllowed).toBe(false);
    expect(service.quitAndInstall()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('stable treats a verifier exception as unverified and blocks install', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService({
      updaterFactory: () => updater,
      channel: 'stable',
      verifySignature: async () => { throw new Error('powershell missing'); },
    });
    service.init();
    updater.emit('update-downloaded', { version: '1.1.0', downloadedFile: 'C:\\tmp\\Setup.exe' } as never);
    await flush();
    const trust = service.getTrustState();
    expect(trust.installAllowed).toBe(false);
    expect(trust.installBlockReason).toMatch(/signature-verification-error: powershell missing/);
    expect(service.quitAndInstall()).toBe(false);
  });
});
