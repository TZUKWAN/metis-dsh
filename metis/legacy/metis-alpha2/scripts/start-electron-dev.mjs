import { spawn } from 'node:child_process';
import process from 'node:process';
import electronPath from 'electron';

const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

if (typeof electronPath !== 'string' || electronPath.length === 0) {
  throw new Error('The local Electron executable could not be resolved. Run npm install first.');
}

const child = spawn(electronPath, ['.'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
  stdio: 'inherit',
  windowsHide: false,
});

child.once('error', (error) => {
  console.error('[dev:electron] Failed to start Electron:', error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[dev:electron] Electron exited from signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
