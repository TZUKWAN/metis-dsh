import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageScripts {
  scripts: Record<string, string>;
  build: { extraResources?: Array<{ from?: string; to?: string }> };
}

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageScripts;

describe('Electron lifecycle scripts', () => {
  it('keeps native rebuild explicit and starts without rebuilding on every launch', () => {
    expect(packageJson.scripts['rebuild:electron']).toContain('-o better-sqlite3');
    expect(packageJson.scripts['rebuild:electron']).not.toContain('-w better-sqlite3');
    expect(packageJson.scripts.start).toBe('electron .');
    expect(packageJson.scripts['dev:electron']).not.toContain('rebuild:electron');
    expect(packageJson.scripts['acceptance:layout']).toContain('scripts/run-electron-layout-acceptance.py');
    expect(packageJson.scripts['acceptance:layout']).toContain('logs/layout-acceptance-current');
    expect(packageJson.scripts['acceptance:commercial']).toBe('node scripts/generate-commercial-acceptance.mjs');
  });

  it('runs every TypeScript gate before producing Electron build artifacts', () => {
    expect(packageJson.scripts.typecheck).toContain('tsconfig.app.json');
    expect(packageJson.scripts.typecheck).toContain('tsconfig.engine.json');
    expect(packageJson.scripts.typecheck).toContain('electron/tsconfig.json');
    expect(packageJson.scripts['build:electron']).toContain('npm run typecheck');
  });

  it('packages the self-contained GenOffice runtime as an extra resource', () => {
    expect(packageJson.scripts['build:electron']).toContain('stage-genoffice-runtime.cjs');
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'dist-electron/genoffice', to: 'genoffice' }),
    ]));
  });
});
