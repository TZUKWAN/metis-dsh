const { rmSync } = require('node:fs');
const { resolve, relative } = require('node:path');

const projectRoot = resolve(__dirname, '..');
const generatedDirectories = ['dist', 'dist-electron'];

for (const directory of generatedDirectories) {
  const target = resolve(projectRoot, directory);
  const relativeTarget = relative(projectRoot, target);
  if (relativeTarget !== directory) {
    throw new Error(`Refusing to remove unexpected path: ${target}`);
  }
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (error) {
    // Windows: a stale handle (AV scan, crash remnant, another session) can
    // keep one file in the tree locked. Tolerate and continue — tsc/vite
    // overwrite their own outputs and stage-genoffice-runtime skips an
    // already-staged Electron runtime, so a locked remnant cannot corrupt the
    // build; the stale tree lingers only until the foreign handle dies.
    // (Same philosophy as removeDirectoryTolerant in stage-genoffice-runtime.)
    process.stdout.write(`[clean-build] kept locked ${directory}: ${String(error && error.code ? error.code : error)}\n`);
  }
}
