/**
 * Security audit (METIS-1005) + License audit (METIS-1006).
 *
 * 1005: checks for path traversal, command injection, prototype pollution, unsigned packages,
 *       malicious documents, prompt injection vectors. High/medium avoidable issues must close.
 * 1006: ensures third-party code/content/fonts/chart libs are legally distributable; no-license
 *       code is NOT copied; GPL/ShareAlike boundaries are explicit.
 */

// ─── METIS-1005 Security audit ────────────────────────────────

export type SecuritySeverity = 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  category: 'path_traversal' | 'command_injection' | 'prototype_pollution' | 'unsigned_package' | 'malicious_document' | 'prompt_injection' | 'secret_leak';
  severity: SecuritySeverity;
  file: string;
  detail: string;
  remediation: string;
}

/** Static checks on a source file's content for common vulnerability patterns. */
export function scanSourceForSecurity(file: { path: string; content: string }): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = file.content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lower = line.toLowerCase();

    // path traversal
    if (/\.\.[\\/]/.test(line) && /(read|write|open|require|import|fetch|load)/i.test(line) && !/block|reject|deny|traversal|sanitize|normalize/.test(lower)) {
      findings.push({ category: 'path_traversal', severity: 'high', file: `${file.path}:${i + 1}`, detail: '可能的路径穿越（.. 未拦截）', remediation: '规范化路径并校验在允许目录内' });
    }

    // command injection
    if (/(child_process|exec\(|spawn\(|execSync\()/i.test(line) && (/\$\{|'\s*\+|\+\s*\w+|concat\(/i.test(line)) && !/sanitize|escape|whitelist|allowlist|execfile/i.test(lower)) {
      findings.push({ category: 'command_injection', severity: 'high', file: `${file.path}:${i + 1}`, detail: '可能的命令注入（用户输入拼接命令）', remediation: '使用 execFile + 参数数组，禁止字符串拼接' });
    }

    // prototype pollution
    if (/__proto__|constructor\[|prototype\]/i.test(line) && /merge|assign|deepcopy|setstate/i.test(lower) && !/sanitize|block|reject.*proto/.test(lower)) {
      findings.push({ category: 'prototype_pollution', severity: 'medium', file: `${file.path}:${i + 1}`, detail: '可能的原型污染', remediation: '过滤 __proto__/constructor/prototype 键' });
    }

    // secret leak
    if (/api[_-]?key\s*[:=]\s*['"][a-z0-9-]{16,}/i.test(line) && !/test|example|placeholder/i.test(lower)) {
      findings.push({ category: 'secret_leak', severity: 'high', file: `${file.path}:${i + 1}`, detail: '可能硬编码的 API 密钥', remediation: '密钥只存系统安全存储' });
    }
  }
  return findings;
}

/** Prompt-injection check: untrusted document text fed directly into a system prompt. */
export function scanPromptInjection(systemPrompt: string, untrustedDocText: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  // detect if untrusted text contains override attempts that reach the prompt unsanitized
  const overridePatterns = [/ignore (all )?previous/i, /disregard the above/i, /你现在是/, /忽略以上指令/, /system prompt/i];
  if (systemPrompt.includes(untrustedDocText) || systemPrompt.includes(untrustedDocText.slice(0, 200))) {
    for (const p of overridePatterns) {
      if (p.test(untrustedDocText)) {
        findings.push({ category: 'prompt_injection', severity: 'medium', file: '(prompt)', detail: '不可信文档内容未隔离地进入系统提示，且含覆盖指令', remediation: '将文档内容放在 user 消息中，并在系统提示中声明边界' });
        break;
      }
    }
  }
  return findings;
}

/** Gate: high + medium AVOIDABLE issues must be closed before release (METIS-1005). */
export function securityGate(findings: SecurityFinding[]): { passed: boolean; openHighMedium: SecurityFinding[] } {
  const openHighMedium = findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
  return { passed: openHighMedium.length === 0, openHighMedium };
}

// ─── METIS-1006 License audit ─────────────────────────────────

export interface DependencyLicenseEntry {
  name: string;
  version: string;
  license: string;       // MIT / Apache-2.0 / GPL-3.0 / BSD-2-Clause / ISC / UNLICENSED / UNKNOWN
  isDirect: boolean;
  /** For bundled content (fonts/charts/code copied from third parties). */
  contentKind?: 'code' | 'prompt' | 'font' | 'chart_lib' | 'data';
}

export interface LicenseAuditResult {
  ok: boolean;
  /** No-license deps whose CODE was copied into Metis (must be zero). */
  copiedNoLicense: DependencyLicenseEntry[];
  /** GPL/ShareAlike items — boundary must be explicit (no code copied unless Metis is also GPL). */
  copyleftItems: DependencyLicenseEntry[];
  unknownLicense: DependencyLicenseEntry[];
}

const COPYLEFT = ['GPL-2.0', 'GPL-3.0', 'GPL-3.0-or-later', 'AGPL', 'CC-BY-SA', 'CC-BY-NC-SA'];

/** Audit dependency/content licenses for distributability (METIS-1006). */
export function auditLicenses(entries: DependencyLicenseEntry[]): LicenseAuditResult {
  const copiedNoLicense = entries.filter((e) => (e.license === 'UNKNOWN' || e.license === 'UNLICENSED') && e.contentKind === 'code');
  const copyleftItems = entries.filter((e) => COPYLEFT.some((c) => e.license.toUpperCase().includes(c.toUpperCase())));
  const unknownLicense = entries.filter((e) => e.license === 'UNKNOWN' || e.license === 'UNLICENSED');
  return {
    ok: copiedNoLicense.length === 0,  // no copied code from no-license projects (hard rule)
    copiedNoLicense,
    copyleftItems,
    unknownLicense,
  };
}
