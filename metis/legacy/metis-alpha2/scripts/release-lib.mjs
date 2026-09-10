import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const projectRoot = resolve(import.meta.dirname, '..');
export const releaseRoot = resolve(projectRoot, 'release');
export const evidenceRoot = resolve(releaseRoot, 'evidence');
export const provenanceRoot = resolve(evidenceRoot, 'provenance');

export function fail(message) {
  throw new Error(message);
}

export function ensureInsideRoot(target, root = projectRoot) {
  const absolute = resolve(target);
  const rel = relative(resolve(root), absolute);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))) return absolute;
  fail(`Refusing path outside allowed root: ${absolute}`);
}

export function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(file) {
  return sha256Buffer(readFileSync(file));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function writeJson(file, value) {
  const safe = ensureInsideRoot(file);
  mkdirSync(dirname(safe), { recursive: true });
  writeFileSync(safe, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
}

export function readJson(file) {
  return JSON.parse(readFileSync(ensureInsideRoot(file), 'utf8'));
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    // On Windows, npm (and other batch wrappers) ship as .cmd files. Node cannot
    // spawn a .cmd directly without a shell and returns EINVAL, so route batch
    // commands through cmd.exe. Plain executables such as git are unaffected.
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command),
    ...options,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function git(args, options = {}) {
  return run('git', args, options).stdout.trim();
}

export function listGitSourceFiles() {
  const output = run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'buffer' }).stdout;
  return output.toString('utf8').split('\0').filter(Boolean).sort();
}

export function inventoryFiles(paths, { root = projectRoot, exclude = () => false } = {}) {
  const files = [];
  const visit = (target) => {
    const safe = ensureInsideRoot(target, root);
    if (!existsSync(safe)) fail(`Required path does not exist: ${safe}`);
    const stat = lstatSync(safe);
    const rel = relative(root, safe).split(sep).join('/');
    if (exclude(rel, stat)) return;
    if (stat.isSymbolicLink()) {
      fail(`Symbolic links are not allowed in release evidence input: ${rel}`);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(safe).sort()) visit(resolve(safe, entry));
      return;
    }
    if (!stat.isFile()) fail(`Unsupported filesystem entry in release input: ${rel}`);
    files.push({ path: rel, size: stat.size, sha256: sha256File(safe) });
  };
  for (const item of paths) visit(resolve(root, item));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function inventoryExplicitFiles(relativePaths) {
  const files = [];
  for (const rel of [...relativePaths].sort()) {
    const absolute = ensureInsideRoot(resolve(projectRoot, rel));
    if (!existsSync(absolute)) fail(`Source file disappeared during provenance capture: ${rel}`);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) fail(`Tracked release source must be a regular file: ${rel}`);
    files.push({ path: rel.split(sep).join('/'), size: stat.size, sha256: sha256File(absolute) });
  }
  return files;
}

export function inventoryDigest(files) {
  return sha256Buffer(Buffer.from(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join('\n'), 'utf8'));
}

export function manifestDigest(manifest) {
  return sha256Buffer(Buffer.from(stableJson(manifest), 'utf8'));
}

export function packageMetadata() {
  const pkg = readJson(resolve(projectRoot, 'package.json'));
  if (typeof pkg.version !== 'string' || pkg.version === '0.0.0' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    fail(`Release version must be a non-0.0.0 SemVer value; received ${JSON.stringify(pkg.version)}`);
  }
  return { name: pkg.name, version: pkg.version, appId: pkg.build?.appId, productName: pkg.build?.productName };
}

export function utcNow() {
  return new Date().toISOString();
}

export function artifactKind(fileName) {
  const lower = basename(fileName).toLowerCase();
  if (lower.endsWith('.msi')) return 'msi';
  if (lower.endsWith('.exe') && lower.includes('setup')) return 'nsis';
  return null;
}

export function artifactMatchesVersion(fileName, version, architecture = 'x64') {
  const kind = artifactKind(fileName);
  if (!kind || typeof version !== 'string' || typeof architecture !== 'string') return false;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedArchitecture = architecture.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const extension = kind === 'msi' ? 'msi' : 'exe';
  return new RegExp(`-${escapedVersion}-${escapedArchitecture}\\.${extension}$`, 'iu').test(basename(fileName));
}
