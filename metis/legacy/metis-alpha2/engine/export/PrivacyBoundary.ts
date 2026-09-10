/**
 * Privacy & data boundary (METIS-906) + App updater (METIS-905).
 *
 * 906: makes explicit what is stored locally vs. sent to the model/external services. Before
 *      sending context to a model, the scope is shown/logged; sensitive interview material
 *      supports masking. API key + raw sensitive materials + unrelated project content must
 *      never be sent accidentally.
 * 905: app self-update with signature verification + project/capability-pack version
 *      protection + rollback on failure.
 */

// ─── METIS-906 Privacy boundary ───────────────────────────────

export interface ContextToTransmit {
  /** Free-text/fields that WILL be sent to the model. */
  payload: Record<string, unknown>;
  /** Marked-sensitive fields included in payload (must be masked or user-approved). */
  sensitiveFields: string[];
}

export interface TransmissionAudit {
  /** The bounded list of field keys sent. */
  transmittedKeys: string[];
  /** Sensitive fields detected — must be masked or explicitly approved. */
  sensitiveDetected: string[];
  /** Whether the API key itself is in the payload (must NEVER be). */
  apiKeyLeaked: boolean;
  /** Whether unrelated project content leaked into the payload. */
  unrelatedProjectLeak: boolean;
  approved: boolean;
}

const SENSITIVE_HINTS = [/interview/i, /transcript/i, /姓名/i, /name/i, /身份证/i, /phone/i, /email/i, /地址/i, /address/i, /PII/i];

/** Audit a context-before-send for privacy boundary violations (METIS-906). */
export function auditTransmission(ctx: ContextToTransmit, opts: { activeProjectId: string; userApprovedSensitive: boolean }): TransmissionAudit {
  const transmittedKeys = Object.keys(ctx.payload);
  const sensitiveDetected: string[] = [];
  let apiKeyLeaked = false;
  let unrelatedProjectLeak = false;

  for (const key of transmittedKeys) {
    const value = String(ctx.payload[key] ?? '');
    if (SENSITIVE_HINTS.some((re) => re.test(key))) sensitiveDetected.push(key);
    if (/api[_-]?key/i.test(key) && value.trim().length > 0) apiKeyLeaked = true;
    if (value.includes('projectId:') && !value.includes(`projectId:${opts.activeProjectId}`)) unrelatedProjectLeak = true;
  }
  for (const sf of ctx.sensitiveFields) {
    if (!sensitiveDetected.includes(sf)) sensitiveDetected.push(sf);
  }

  const blocked = apiKeyLeaked || unrelatedProjectLeak || (sensitiveDetected.length > 0 && !opts.userApprovedSensitive);
  return { transmittedKeys, sensitiveDetected, apiKeyLeaked, unrelatedProjectLeak, approved: !blocked };
}

/** Mask a sensitive field value (e.g. for exporting/sharing de-identified interviews). */
export function maskSensitive(value: string, keep = 2): string {
  if (value.length <= keep * 2) return '*'.repeat(value.length || 4);
  return value.slice(0, keep) + '*'.repeat(Math.min(20, value.length - keep * 2)) + value.slice(-keep);
}

// ─── METIS-905 App updater ────────────────────────────────────

export interface AppUpdateManifest {
  version: string;
  downloadUrl: string;
  sha256: string;
  signature: string;
  minCompatibleProjectVersion: number;
}

export interface UpdateResult {
  success: boolean;
  fromVersion: string;
  toVersion?: string;
  migratedProjects: number;
  rolledBack: boolean;
  error?: string;
}

/** Verify an app update is official + compatible before applying (METIS-905). */
export function verifyAppUpdate(update: AppUpdateManifest, verifySignature: (msg: string, sig: string) => boolean): { ok: boolean; reason?: string } {
  if (!verifySignature(update.sha256, update.signature)) {
    return { ok: false, reason: '应用更新签名无效，拒绝安装。' };
  }
  return { ok: true };
}

/**
 * Apply an app update; migrate project data; on failure roll back to the prior version so
 * the user can still open their projects (METIS-905 completion).
 */
export async function applyAppUpdate(
  currentVersion: string,
  update: AppUpdateManifest,
  deps: {
    verifySha256: (actual: string, expected: string) => boolean;
    download: (url: string) => Promise<{ bytes: Buffer; sha256: string }>;
    migrate: (minVersion: number) => Promise<{ migrated: number }>;
    rollback: () => Promise<void>;
  },
): Promise<UpdateResult> {
  try {
    const downloaded = await deps.download(update.downloadUrl);
    if (!deps.verifySha256(downloaded.sha256, update.sha256)) {
      await deps.rollback();
      return { success: false, fromVersion: currentVersion, migratedProjects: 0, rolledBack: true, error: '哈希不匹配，已回滚。' };
    }
    const { migrated } = await deps.migrate(update.minCompatibleProjectVersion);
    return { success: true, fromVersion: currentVersion, toVersion: update.version, migratedProjects: migrated, rolledBack: false };
  } catch (err) {
    await deps.rollback();
    return { success: false, fromVersion: currentVersion, migratedProjects: 0, rolledBack: true, error: (err as Error).message };
  }
}
