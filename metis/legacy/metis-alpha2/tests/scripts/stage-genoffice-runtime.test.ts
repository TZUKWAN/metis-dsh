import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('stage-genoffice-runtime', () => {
  it('stages all four built hosts and the spreadsheet sidecar into the package resource tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-genoffice-stage-test-'));
    const sourceRoot = path.join(root, 'genoffice-source');
    const destinationRoot = path.join(root, 'genoffice-staged');
    try {
      for (const appName of ['docs', 'slides', 'sheets', 'pdf']) {
        fs.mkdirSync(path.join(sourceRoot, 'apps', appName, 'out', 'main'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'apps', appName, 'out', 'preload'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'apps', appName, 'out', 'renderer'), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'apps', appName, 'out', 'main', 'index.js'), `${appName}-main`);
        fs.writeFileSync(path.join(sourceRoot, 'apps', appName, 'out', 'preload', 'index.js'), `${appName}-preload`);
        fs.writeFileSync(path.join(sourceRoot, 'apps', appName, 'out', 'renderer', 'index.html'), `${appName}-renderer`);
      }
      const sidecar = path.join(sourceRoot, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', 'xlsx-sidecar.exe');
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      fs.writeFileSync(sidecar, 'real-sidecar-path');
      fs.mkdirSync(path.join(sourceRoot, 'node_modules', 'electron', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), 'real-electron-runtime');
      for (const packageName of ['electron-updater', 'zod', 'jszip', 'fast-xml-parser']) {
        const packageDirectory = path.join(sourceRoot, 'node_modules', ...packageName.split('/'));
        fs.mkdirSync(packageDirectory, { recursive: true });
        fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }));
      }

      const { stageGenofficeRuntime } = require('../../scripts/stage-genoffice-runtime.cjs') as {
        stageGenofficeRuntime: (input: { sourceRoot: string; destinationRoot: string }) => void;
      };
      stageGenofficeRuntime({ sourceRoot, destinationRoot });

      for (const appName of ['docs', 'slides', 'sheets', 'pdf']) {
        expect(fs.existsSync(path.join(destinationRoot, 'apps', appName, 'out', 'main', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(destinationRoot, 'apps', appName, 'out', 'preload', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(destinationRoot, 'apps', appName, 'out', 'renderer', 'index.html'))).toBe(true);
      }
      expect(fs.readFileSync(path.join(destinationRoot, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', 'xlsx-sidecar.exe'), 'utf8')).toBe('real-sidecar-path');
      expect(fs.existsSync(path.join(destinationRoot, 'node_modules', 'electron-updater', 'package.json'))).toBe(true);
      expect(fs.readFileSync(path.join(destinationRoot, 'electron', 'electron.exe'), 'utf8')).toBe('real-electron-runtime');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
