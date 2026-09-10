/**
 * UpdateChannelPolicy — release channel resolution and the frozen update
 * trust policy for METIS.
 *
 * Channels:
 *   dev    — unpackaged runs. In-app auto-update is disabled entirely; updates
 *            come from the developer workflow.
 *   alpha  — packaged prerelease versions (e.g. 0.1.0-alpha.3). Artifacts are
 *            currently NOT Authenticode-signed. Auto-download is allowed and a
 *            user-initiated install of an unsigned artifact is allowed, but the
 *            unsigned state must be disclosed in the update status (DEV ONLY /
 *            NOT RELEASE SAFE).
 *   stable — packaged non-prerelease versions. A stable update may only be
 *            installed when its Authenticode signature is valid. Unsigned or
 *            unverifiable stable updates are never silently installed
 *            (fail-safe): install is blocked and the reason is surfaced.
 *
 * The policy below is the runtime source of truth. build/update-trust-policy.json
 * mirrors it for release tooling; tests/electron/UpdateChannelPolicy.test.ts
 * asserts the two stay in sync. When a Windows code-signing certificate is
 * provisioned: set expectedSignerSubject in BOTH places, configure the
 * electron-builder signing env (CSC_LINK / CSC_KEY_PASSWORD), and flip
 * build/release-policy.json requireAuthenticode to true.
 */

export type UpdateChannel = 'dev' | 'alpha' | 'stable';

export interface SignatureAcceptance {
  verified: boolean;
  status: string | null;
  signerSubject: string | null;
  /** Machine-readable failure reason when verification could not be completed; absent/null when the signature check itself ran clean. */
  error?: string | null;
}

export interface UpdateTrustPolicy {
  schemaVersion: number;
  channels: Record<UpdateChannel, {
    autoDownload: boolean;
    requireSignature: boolean;
    allowUnsignedInstall: boolean;
    discloseUnsigned: boolean;
    trustLabel: string;
  }>;
  /** Certificate subject that stable artifacts must be signed by; null until a certificate exists (any valid Authenticode is then accepted). */
  expectedSignerSubject: string | null;
}

export const UPDATE_PUBLISH_TARGET = {
  provider: 'github',
  owner: 'TZUKWAN',
  repo: 'metis-in-social-science',
} as const;

export const UPDATE_TRUST_POLICY: UpdateTrustPolicy = {
  schemaVersion: 1,
  channels: {
    dev: {
      autoDownload: false,
      requireSignature: false,
      allowUnsignedInstall: true,
      discloseUnsigned: false,
      trustLabel: 'DEV ONLY — in-app updates disabled',
    },
    alpha: {
      autoDownload: true,
      requireSignature: false,
      allowUnsignedInstall: true,
      discloseUnsigned: true,
      trustLabel: 'UNSIGNED ALPHA — NOT RELEASE SAFE',
    },
    stable: {
      autoDownload: false,
      requireSignature: true,
      allowUnsignedInstall: false,
      discloseUnsigned: true,
      trustLabel: 'STABLE — SIGNATURE REQUIRED (RELEASE SAFE)',
    },
  },
  expectedSignerSubject: null,
};

const CHANNEL_VALUES: readonly UpdateChannel[] = ['dev', 'alpha', 'stable'];

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (CHANNEL_VALUES as readonly string[]).includes(value);
}

export interface ResolveChannelInput {
  isPackaged: boolean;
  appVersion: string;
  /** METIS_UPDATE_CHANNEL environment override; invalid values are ignored. */
  envOverride?: string | null;
}

/**
 * Resolve the effective update channel. Environment override wins (used by
 * harnesses to exercise a specific trust path), then packaging state, then the
 * version prerelease tag: packaged versions with a prerelease segment are
 * alpha, packaged versions without one are stable.
 */
export function resolveUpdateChannel(input: ResolveChannelInput): UpdateChannel {
  if (isUpdateChannel(input.envOverride)) return input.envOverride;
  if (!input.isPackaged) return 'dev';
  const version = input.appVersion ?? '';
  const prerelease = version.split('-').slice(1).join('-');
  return prerelease.length > 0 ? 'alpha' : 'stable';
}

/**
 * Whether an artifact signature satisfies the channel policy. With no expected
 * signer subject configured (no certificate yet) any valid Authenticode
 * signature is accepted; once a subject is configured it must be contained in
 * the signer subject chain.
 */
export function isSignatureAcceptable(policy: UpdateTrustPolicy, verification: SignatureAcceptance): boolean {
  if (!verification.verified) return false;
  const expected = policy.expectedSignerSubject;
  if (!expected) return true;
  return typeof verification.signerSubject === 'string'
    && verification.signerSubject.includes(expected);
}
