import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('open-source release metadata', () => {
  it('ships the declared MIT license in source and packaged application inputs', () => {
    const pkg = JSON.parse(read('package.json')) as {
      private?: boolean;
      license?: string;
      build?: { files?: string[] };
    };
    const license = read('LICENSE');
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('MIT');
    expect(pkg.build?.files).toContain('LICENSE');
    expect(license).toContain('MIT License');
    expect(license).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('keeps every local README link resolvable', () => {
    const readme = read('README.md');
    const localTargets = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((target) => target !== '' && !/^(?:https?:|mailto:|#)/iu.test(target))
      .map((target) => decodeURIComponent(target.split('#')[0] ?? ''));
    expect(localTargets.length).toBeGreaterThan(0);
    expect(localTargets.filter((target) => !fs.existsSync(path.resolve(root, target)))).toEqual([]);
    // The rewritten README (b24a535) intentionally uses emoji in headings and
    // badges, so only link resolvability is asserted here.
  });

  it('runs integration, security, and documentation matrices in the public CI workflow', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain('tests/integration');
    expect(workflow).toContain('tests/security');
    expect(workflow).toContain('tests/docs');
    expect(workflow).toContain('npm run typecheck');
    // Lint runs as a legacy-baseline gate (no regression against
    // build/lint-baseline.json) — see scripts/lint-gate.mjs.
    expect(workflow).toContain('scripts/lint-gate.mjs');
    // Security advisories are a REPORT, not an engineering gate: the audit
    // step lives in a continue-on-error job so CVE findings never block
    // delivery, while still being visible on every push.
    expect(workflow).toContain('npm audit --omit=dev');
    expect(workflow).toContain('continue-on-error: true');
  });
});
