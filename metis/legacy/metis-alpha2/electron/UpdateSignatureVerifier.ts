/**
 * UpdateSignatureVerifier — runtime Authenticode verification of a downloaded
 * update artifact on Windows.
 *
 * electron-updater's own Windows signature check is disabled while
 * verifyUpdateCodeSignature is false (current alpha reality), so this module
 * provides the explicit verification step that the update trust policy gates
 * on. Verification runs PowerShell's Get-AuthenticodeSignature against the
 * downloaded installer and is strictly fail-safe: any failure to run, parse,
 * or finish within the timeout reports verified:false — never an optimistic
 * default.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export interface SignatureVerification {
  verified: boolean;
  /** Authenticode status text, e.g. 'Valid' | 'NotSigned' | 'HashMismatch'. */
  status: string | null;
  signerSubject: string | null;
  error: string | null;
}

export type SpawnLike = typeof nodeSpawn;

export interface VerifyOptions {
  timeoutMs?: number;
  spawnImpl?: SpawnLike;
}

function buildPowerShellCommand(filePath: string): string {
  const escaped = filePath.replace(/'/g, "''");
  return [
    `$sig = Get-AuthenticodeSignature -LiteralPath '${escaped}';`,
    `[pscustomobject]@{ status = [string]$sig.Status;`,
    `subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null } }`,
    `| ConvertTo-Json -Compress`,
  ].join(' ');
}

function failure(error: string): SignatureVerification {
  return { verified: false, status: null, signerSubject: null, error };
}

export function verifyAuthenticodeSignature(filePath: string, options: VerifyOptions = {}): Promise<SignatureVerification> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolveResult) => {
    if (process.platform !== 'win32') {
      resolveResult(failure('unsupported-platform'));
      return;
    }
    if (!filePath) {
      resolveResult(failure('missing-artifact-path'));
      return;
    }
    let child;
    try {
      child = spawnImpl('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-NoLogo',
        '-Command',
        buildPowerShellCommand(filePath),
      ], { windowsHide: true });
    } catch (err) {
      resolveResult(failure(`spawn-failed: ${(err as Error)?.message ?? String(err)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: SignatureVerification) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already exited — the timeout result below still applies.
      }
      finish(failure('signature-verification-timeout'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish(failure(`spawn-failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(failure(`powershell-exit-${code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { status?: string; subject?: string | null };
        const status = typeof parsed.status === 'string' ? parsed.status : null;
        const subject = typeof parsed.subject === 'string' ? parsed.subject : null;
        finish({
          verified: status === 'Valid',
          status,
          signerSubject: subject,
          error: status === 'Valid' ? null : `authenticode-${status ?? 'unknown'}`,
        });
      } catch (err) {
        finish(failure(`unparseable-signature-output: ${(err as Error).message}`));
      }
    });
  });
}
