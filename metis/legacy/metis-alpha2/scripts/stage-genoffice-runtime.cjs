const { cpSync, existsSync, lstatSync, mkdirSync, rmSync } = require('node:fs');
// Optional component: the GenOffice source tree lives OUTSIDE this repo
// (../tools/genoffice). CI build jobs set METIS_SKIP_GENOFFICE=1 to validate
// compilation health without the sidecar/runtime staging; the packaged
// release chain (local / release.yml) stages it for real. The running app
// degrades gracefully when staged artifacts are absent (existing existsSync
// guards in main.ts).
if (process.env.METIS_SKIP_GENOFFICE === '1') {
  console.log('[genoffice] METIS_SKIP_GENOFFICE=1 - staging skipped');
  process.exit(0);
}

const path = require('node:path');

const APP_NAMES = ['docs', 'slides', 'sheets', 'pdf'];
const BUILTIN_MODULES = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'fs/promises',
  'http', 'https', 'module', 'net', 'os', 'path', 'readline', 'stream', 'timers',
  'tls', 'url', 'util', 'zlib',
]);

function assertDirectory(value, label) {
  const stat = lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`GenOffice ${label} must be a real directory: ${value}`);
}

function assertFile(value, label) {
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`GenOffice ${label} must be a real file: ${value}`);
}

function packageNameFromRequest(request) {
  if (request.startsWith('@')) return request.split('/').slice(0, 2).join('/');
  return request.split('/')[0];
}

function packageDirectory(nodeModulesRoot, request) {
  const packageName = packageNameFromRequest(request);
  const directory = path.join(nodeModulesRoot, ...packageName.split('/'));
  return existsSync(path.join(directory, 'package.json')) ? directory : null;
}

function packageDependencies(sourceNodeModulesRoot, targetNodeModulesRoot, packageDirectoryPath, copied) {
  const packageJsonPath = path.join(packageDirectoryPath, 'package.json');
  const packageJson = JSON.parse(require('node:fs').readFileSync(packageJsonPath, 'utf8'));
  const name = packageJson.name;
  if (typeof name !== 'string' || copied.has(name)) return;
  copied.add(name);
  const target = path.join(targetNodeModulesRoot, ...name.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(packageDirectoryPath, target, { recursive: true, dereference: true });
  for (const dependency of Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies })) {
    if (BUILTIN_MODULES.has(dependency) || dependency.startsWith('node:')) continue;
    const dependencyDirectory = packageDirectory(sourceNodeModulesRoot, dependency);
    if (dependencyDirectory) packageDependencies(sourceNodeModulesRoot, targetNodeModulesRoot, dependencyDirectory, copied);
  }
}

function copyDirectory(source, target, label) {
  assertDirectory(source, `${label} source`);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}

function removeDirectoryTolerant(value, label) {
  if (!existsSync(value)) return;
  try {
    rmSync(value, { recursive: true, force: true });
  } catch (error) {
    // Windows: a stale handle (AV scan, remote session, crash remnant) can hold
    // a file in the tree. The stage must stay idempotent instead of failing the
    // whole build — cpSync overwrites everything except the locked file itself.
    process.stdout.write(`[stage-genoffice-runtime] kept locked ${label}: ${String(error && error.code ? error.code : error)}\n`);
  }
}

function stageGenofficeRuntime({ sourceRoot, destinationRoot }) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  assertDirectory(source, 'source root');
  if (existsSync(destination)) {
    removeDirectoryTolerant(path.join(destination, 'apps'), 'apps');
    removeDirectoryTolerant(path.join(destination, 'node_modules'), 'node_modules');
    removeDirectoryTolerant(path.join(destination, 'package.json'), 'package.json');
  }
  mkdirSync(destination, { recursive: true });

  for (const appName of APP_NAMES) {
    const sourceOut = path.join(source, 'apps', appName, 'out');
    const targetOut = path.join(destination, 'apps', appName, 'out');
    copyDirectory(sourceOut, targetOut, `${appName} output`);
    for (const part of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
      assertFile(path.join(targetOut, part), `${appName} ${part}`);
    }
  }

  const sidecarName = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
  const sourceSidecar = path.join(source, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', sidecarName);
  assertFile(sourceSidecar, 'Sheets sidecar');
  const targetSidecar = path.join(destination, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', sidecarName);
  mkdirSync(path.dirname(targetSidecar), { recursive: true });
  cpSync(sourceSidecar, targetSidecar, { dereference: true });
  assertFile(targetSidecar, 'staged Sheets sidecar');

  const sourceElectron = path.join(source, 'node_modules', 'electron', 'dist');
  const targetElectron = path.join(destination, 'electron');
  const electronExecutable = process.platform === 'win32' ? 'electron.exe' : 'electron';
  if (existsSync(path.join(targetElectron, electronExecutable))) {
    // The staged Electron runtime already validates; a full re-copy would fail
    // on any file a stale handle keeps locked (e.g. default_app.asar). The
    // runtime only changes when the pinned Electron version changes.
    process.stdout.write('[stage-genoffice-runtime] Electron runtime already staged; skipping locked-tree recopy\n');
  } else {
    copyDirectory(sourceElectron, targetElectron, 'Electron runtime');
  }
  assertFile(path.join(targetElectron, electronExecutable), 'Electron executable');

  const seeds = ['electron-updater', 'zod', 'jszip', 'fast-xml-parser'];
  const copied = new Set();
  const sourceNodeModulesRoot = path.join(source, 'node_modules');
  const targetNodeModulesRoot = path.join(destination, 'node_modules');
  for (const seed of seeds) {
    const directory = packageDirectory(sourceNodeModulesRoot, seed);
    if (!directory) throw new Error(`GenOffice runtime dependency is missing: ${seed}`);
    packageDependencies(sourceNodeModulesRoot, targetNodeModulesRoot, directory, copied);
  }
  assertDirectory(targetNodeModulesRoot, 'staged dependency root');
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const sourceRoot = process.env.METIS_GENOFFICE_ROOT?.trim() || path.resolve(root, '..', 'tools', 'genoffice');
  const destinationRoot = path.join(root, 'dist-electron', 'genoffice');
  stageGenofficeRuntime({ sourceRoot, destinationRoot });
  process.stdout.write(`[stage-genoffice-runtime] ${sourceRoot} -> ${destinationRoot}\n`);
}

module.exports = { stageGenofficeRuntime };
