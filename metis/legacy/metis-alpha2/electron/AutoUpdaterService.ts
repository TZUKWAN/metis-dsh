/**
 * AutoUpdaterService — channel-aware background update lifecycle.
 *
 * Update trust model (see electron/UpdateChannelPolicy.ts):
 *   dev    — in-app updates disabled entirely.
 *   alpha  — background check + auto-download; a user-initiated install of an
 *            UNSIGNED artifact is allowed but the unsigned state is disclosed
 *            in every update event and in the update status (DEV ONLY / NOT
 *            RELEASE SAFE).
 *   stable — check without auto-download; after download the artifact's
 *            Authenticode signature is verified at runtime and install is
 *            allowed only when it is valid. Unsigned or unverifiable stable
 *            updates are never installed (fail-safe) and the reason is
 *            surfaced as an 'install-blocked' event.
 *
 * All failures degrade to "check failed" style events and never block startup.
 * Constructed with no options (legacy) the service behaves as the alpha
 * channel without feed override, preserving the historical behavior.
 */

import { EventEmitter } from 'node:events';

import {
  UPDATE_PUBLISH_TARGET,
  UPDATE_TRUST_POLICY,
  isSignatureAcceptable,
  resolveUpdateChannel,
  type SignatureAcceptance,
  type UpdateChannel,
  type UpdateTrustPolicy,
} from './UpdateChannelPolicy.js';

export type AutoUpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; channel?: UpdateChannel }
  | { type: 'not-available'; channel?: UpdateChannel }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string; trust?: UpdateTrustState }
  | { type: 'install-blocked'; version?: string; reason: string }
  | { type: 'disabled'; reason: string }
  | { type: 'error'; message: string };

export interface UpdateTrustState {
  channel: UpdateChannel;
  trustLabel: string;
  /** null = not verified yet or verification unavailable. */
  signed: boolean | null;
  signatureStatus: string | null;
  signerSubject: string | null;
  installAllowed: boolean;
  installBlockReason: string | null;
}

/**
 * Thin wrapper around electron-updater so tests can inject a fake updater.
 * All members beyond the original four are optional so legacy fakes keep
 * compiling; where a member is missing the service degrades conservatively
 * (e.g. stable falls back to checkForUpdatesAndNotify only when
 * checkForUpdates is unavailable).
 */
export interface AutoUpdaterLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdatesAndNotify(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  checkForUpdates?(): Promise<unknown>;
  setFeedURL?(feed: { provider: string; owner: string; repo: string; releaseType: string }): void;
  autoDownload?: boolean;
}

export type SignatureVerifier = (filePath: string) => Promise<SignatureAcceptance>;

export interface AutoUpdaterServiceOptions {
  updaterFactory?: () => AutoUpdaterLike;
  /** Explicit channel; when omitted it is resolved from isPackaged/appVersion, defaulting to legacy alpha behavior when neither is given. */
  channel?: UpdateChannel;
  isPackaged?: boolean;
  appVersion?: string;
  envChannelOverride?: string | null;
  /** Runtime Authenticode verification; when absent, stable downloads can never be proven signed (fail-safe: install blocked). */
  verifySignature?: SignatureVerifier | null;
  policy?: UpdateTrustPolicy;
}

interface DownloadTrust {
  version: string | null;
  filePath: string | null;
  state: 'pending-verification' | 'verified' | 'failed' | 'unverified';
  verification: SignatureAcceptance | null;
  installAllowed: boolean;
  installBlockReason: string | null;
}

function trustStateFor(channel: UpdateChannel, policy: UpdateTrustPolicy, download: DownloadTrust | null): UpdateTrustState {
  const channelPolicy = policy.channels[channel];
  const signed = download?.state === 'verified'
    ? download.verification?.verified === true
    : download && download.state !== 'pending-verification' ? false : null;
  return {
    channel,
    trustLabel: channelPolicy.trustLabel,
    signed,
    signatureStatus: download?.verification?.status ?? null,
    signerSubject: download?.verification?.signerSubject ?? null,
    installAllowed: download?.installAllowed ?? channelPolicy.allowUnsignedInstall,
    installBlockReason: download?.installBlockReason ?? null,
  };
}

export class AutoUpdaterService extends EventEmitter {
  #updater: AutoUpdaterLike | null = null;
  #downloaded = false;
  #channel: UpdateChannel;
  #policy: UpdateTrustPolicy;
  #verifySignature: SignatureVerifier | null;
  #downloadTrust: DownloadTrust | null = null;

  constructor(options?: (() => AutoUpdaterLike) | AutoUpdaterServiceOptions) {
    super();
    const opts: AutoUpdaterServiceOptions = typeof options === 'function' ? { updaterFactory: options } : (options ?? {});
    this.#policy = opts.policy ?? UPDATE_TRUST_POLICY;
    if (opts.channel) {
      this.#channel = opts.channel;
    } else if (opts.isPackaged !== undefined || opts.appVersion !== undefined || opts.envChannelOverride) {
      this.#channel = resolveUpdateChannel({
        isPackaged: opts.isPackaged ?? true,
        appVersion: opts.appVersion ?? '0.0.0',
        envOverride: opts.envChannelOverride ?? null,
      });
    } else {
      // Legacy construction with no channel information: keep historical
      // (alpha) behavior so existing wiring and tests are unchanged.
      this.#channel = 'alpha';
    }
    this.#verifySignature = opts.verifySignature ?? null;
    this.#updaterFactory = opts.updaterFactory;
  }

  #updaterFactory: (() => AutoUpdaterLike) | undefined;

  get channel(): UpdateChannel {
    return this.#channel;
  }

  getTrustState(): UpdateTrustState {
    return trustStateFor(this.#channel, this.#policy, this.#downloadTrust);
  }

  private getUpdater(): AutoUpdaterLike | null {
    if (this.#updater) return this.#updater;
    try {
      if (this.#updaterFactory) {
        this.#updater = this.#updaterFactory();
      } else {
        // electron-updater is a CommonJS module; require it in the main process.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { autoUpdater } = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
        this.#updater = autoUpdater;
      }
      return this.#updater;
    } catch {
      return null;
    }
  }

  /** Start listening and check for updates in the background. */
  init(): void {
    if (this.#channel === 'dev') {
      this.emit('event', { type: 'disabled', reason: this.#policy.channels.dev.trustLabel });
      return;
    }
    const updater = this.getUpdater();
    if (!updater) {
      // Never emit the special 'error' event (throws when unlistened); use the
      // unified 'event' channel.
      this.emit('event', { type: 'error', message: 'electron-updater unavailable' });
      return;
    }
    if (this.#channel === 'alpha' && typeof updater.setFeedURL === 'function') {
      // Alpha builds are published as GitHub prereleases; the default packaged
      // feed (releaseType: release) would never offer them.
      try {
        updater.setFeedURL({
          provider: UPDATE_PUBLISH_TARGET.provider,
          owner: UPDATE_PUBLISH_TARGET.owner,
          repo: UPDATE_PUBLISH_TARGET.repo,
          releaseType: 'prerelease',
        });
      } catch (err) {
        this.emit('event', { type: 'error', message: `feed override failed: ${(err as Error)?.message ?? 'unknown'}` });
      }
    }
    updater.on('checking-for-update', () => this.emit('event', { type: 'checking' }));
    updater.on('update-available', (info: { version?: string }) => {
      this.emit('event', { type: 'available', version: info?.version ?? 'unknown', channel: this.#channel });
    });
    updater.on('update-not-available', () => this.emit('event', { type: 'not-available', channel: this.#channel }));
    updater.on('download-progress', (progress: { percent?: number }) => {
      this.emit('event', { type: 'downloading', percent: progress?.percent ?? 0 });
    });
    updater.on('update-downloaded', (info: { version?: string; downloadedFile?: string }) => {
      this.#downloaded = true;
      const version = info?.version ?? 'unknown';
      this.#beginTrustVerification(version, info?.downloadedFile ?? null);
      this.emit('event', { type: 'downloaded', version, trust: this.getTrustState() });
    });
    updater.on('error', (err: Error) => {
      this.emit('event', { type: 'error', message: err?.message ?? 'update error' });
    });

    const channelPolicy = this.#policy.channels[this.#channel];
    if (!channelPolicy.autoDownload) {
      // Defense in depth: even if a fallback path ever triggers a combined
      // check+notify call, the updater itself must not auto-download on a
      // channel whose artifacts require signature gating.
      updater.autoDownload = false;
    }
    if (!channelPolicy.autoDownload && typeof updater.checkForUpdates === 'function') {
      // Stable: check and surface availability, but never auto-download.
      void updater.checkForUpdates().catch(() => {
        this.emit('event', { type: 'error', message: 'update check failed' });
      });
      return;
    }
    // Background check; never awaited (must not block startup).
    void updater.checkForUpdatesAndNotify().catch(() => {
      this.emit('event', { type: 'error', message: 'update check failed' });
    });
  }

  /** Verify the downloaded artifact per the channel trust policy (fail-safe). */
  #beginTrustVerification(version: string, filePath: string | null): void {
    const channelPolicy = this.#policy.channels[this.#channel];
    const base: DownloadTrust = {
      version,
      filePath,
      state: 'pending-verification',
      verification: null,
      installAllowed: false,
      installBlockReason: 'signature-verification-pending',
    };
    this.#downloadTrust = base;
    if (this.#channel === 'alpha' && !channelPolicy.requireSignature) {
      // Alpha: installable without a signature, but still verify opportunistically.
      base.installAllowed = true;
      base.installBlockReason = null;
    }
    if (!this.#verifySignature) {
      if (base.installAllowed) {
        base.state = 'unverified';
      } else {
        base.state = 'failed';
        base.installBlockReason = 'signature-verifier-unavailable';
      }
      return;
    }
    void this.#verifySignature(filePath ?? '')
      .then((verification) => {
        base.verification = verification;
        const acceptable = isSignatureAcceptable(this.#policy, verification);
        if (acceptable) {
          base.state = 'verified';
          base.installAllowed = true;
          base.installBlockReason = null;
        } else if (channelPolicy.requireSignature) {
          base.state = 'failed';
          base.installAllowed = false;
          base.installBlockReason = verification.error ?? 'signature-invalid';
        } else {
          // Alpha with an invalid/absent signature stays installable but is
          // disclosed as unsigned.
          base.state = 'unverified';
          base.installAllowed = true;
          base.installBlockReason = null;
        }
        this.emit('event', { type: 'downloaded', version, trust: this.getTrustState() });
      })
      .catch((err: unknown) => {
        base.state = 'failed';
        base.verification = { verified: false, status: null, signerSubject: null };
        if (channelPolicy.requireSignature) {
          base.installAllowed = false;
          base.installBlockReason = `signature-verification-error: ${(err as Error)?.message ?? String(err)}`;
        } else {
          base.installAllowed = true;
          base.installBlockReason = null;
        }
      });
  }

  /** Download the update in the background (safe to call after available). */
  async download(): Promise<void> {
    const updater = this.getUpdater();
    if (!updater || this.#downloaded) return;
    await updater.downloadUpdate().catch(() => { /* handled by events */ });
  }

  /**
   * Install the downloaded update and restart the app. Returns false (and
   * emits 'install-blocked') when the channel trust policy forbids installing
   * this artifact — notably unsigned stable updates.
   */
  quitAndInstall(): boolean {
    const trust = this.getTrustState();
    if (!trust.installAllowed) {
      this.emit('event', {
        type: 'install-blocked',
        version: this.#downloadTrust?.version ?? undefined,
        reason: trust.installBlockReason ?? 'install-forbidden-by-update-trust-policy',
      });
      return false;
    }
    this.getUpdater()?.quitAndInstall();
    return true;
  }
}
