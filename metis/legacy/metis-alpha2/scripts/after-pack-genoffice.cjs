/*
 * afterPack hook: copies the staged GenOffice node_modules into the packaged
 * resources/genoffice. electron-builder's extraResources glob engine drops the
 * top-level node_modules directory regardless of the configured filter, so the
 * copy is done here deterministically and verified.
 */
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'dist-electron', 'genoffice', 'node_modules');
  const destination = path.join(context.appOutDir, 'resources', 'genoffice', 'node_modules');
  if (!fs.existsSync(path.join(source, 'jszip', 'package.json'))) {
    throw new Error(`genoffice_staged_node_modules_missing:${source}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  const copied = fs.readdirSync(destination);
  if (!fs.existsSync(path.join(destination, 'jszip', 'package.json'))) {
    throw new Error('genoffice_packaged_node_modules_copy_failed');
  }
  // The GenOffice apps compile to CommonJS. Without a nearby package.json the
  // CJS entry would resolve against the workspace "type": "module" and crash;
  // the wrapper directory below pins its own "type": "module" for the ESM
  // METIS wrapper, and Node always uses the nearest package.json.
  fs.writeFileSync(path.join(context.appOutDir, 'resources', 'genoffice', 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`, 'utf8');
  // Ship the standalone wrapper outside app.asar. The compiled Electron bundle
  // is ESM, so the neighbouring package.json pins "type": "module" and removes
  // any ambiguity from package.json lookups while walking up from the packaged
  // layout. The wrapper's compiled sibling modules ship next to it.
  const wrapperDirectory = path.join(context.appOutDir, 'resources', 'genoffice', 'wrapper');
  const wrapperModules = [
    'genofficeStandaloneWrapper.js',
    'genofficeStandaloneArgs.js',
    'genofficeStandaloneProtocol.js',
    'genofficeStandaloneReadiness.js',
    'genofficeStandaloneCompatibility.js',
  ];
  fs.mkdirSync(wrapperDirectory, { recursive: true });
  for (const moduleName of wrapperModules) {
    const moduleSource = path.join(root, 'dist-electron', 'electron', moduleName);
    if (!fs.existsSync(moduleSource)) throw new Error(`genoffice_wrapper_module_missing:${moduleSource}`);
    fs.copyFileSync(moduleSource, path.join(wrapperDirectory, moduleName));
  }
  fs.writeFileSync(path.join(wrapperDirectory, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`, 'utf8');
  // The Sheets workbook flow resolves its sidecar relative to the wrapper
  // directory (identical to the dev staging layout), so mirror it here.
  const sidecarSource = path.join(root, 'dist-electron', 'electron', 'native', 'xlsx-engine', 'target', 'release', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar');
  const sidecarDestination = path.join(wrapperDirectory, 'native', 'xlsx-engine', 'target', 'release', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar');
  if (!fs.existsSync(sidecarSource)) throw new Error(`genoffice_sidecar_missing:${sidecarSource}`);
  fs.mkdirSync(path.dirname(sidecarDestination), { recursive: true });
  fs.copyFileSync(sidecarSource, sidecarDestination);
  process.stdout.write(`[after-pack-genoffice] copied ${copied.length} runtime packages, the wrapper modules and the sheets sidecar\n`);
};
