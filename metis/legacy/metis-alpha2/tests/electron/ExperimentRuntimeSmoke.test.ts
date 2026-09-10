import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('trusted Electron Node runtime smoke', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('executes the original Electron binary as Node with fixed environment', async () => {
    const executable = require('electron') as string;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-electron-node-smoke-'));
    roots.push(root);
    const script = path.join(root, 'smoke.js');
    fs.writeFileSync(
      script,
      "console.log('METIS_TRUSTED_NODE_RUNTIME|' + process.env.ELECTRON_RUN_AS_NODE);\n",
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = {};
    for (const key of process.platform === 'win32'
      ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
      : ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    environment.ELECTRON_RUN_AS_NODE = '1';

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          executable,
          ['--unhandled-rejections=strict', '--disable-proto=throw', script],
          { env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      },
    );
    expect(result).toEqual({
      code: 0,
      stdout: expect.stringContaining('METIS_TRUSTED_NODE_RUNTIME|1'),
      stderr: '',
    });
  }, 20_000);
});
