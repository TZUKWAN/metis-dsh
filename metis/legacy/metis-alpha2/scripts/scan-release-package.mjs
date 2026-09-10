import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import {
  artifactKind,
  artifactMatchesVersion,
  evidenceRoot,
  fail,
  inventoryDigest,
  packageMetadata,
  projectRoot,
  releaseRoot,
  sha256File,
  utcNow,
  writeJson,
} from './release-lib.mjs';
import {
  missingRequiredAsarEntries,
  scanAsarArchive,
  scanPackagedTree,
} from './release-package-scan-lib.mjs';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(test|tests|__tests__|fixtures|examples?|coverage|\.github)(\/|$)/i,
  /(^|\/)(?:test|spec)\.(?:js|cjs|mjs|ts|tsx|mts|cts)$/i,
  /\.(?:pfx|p12|pem|key|cer|crt|map|tsbuildinfo)$/i,
  /(^|\/)(?:docs\/.*(?:audit|handoff)|\.codex|artifacts\/acceptance)(\/|$)/i,
  /(^|\/)package-lock\.json$/i,
  /\.(?:ts|tsx|mts|cts)$/i,
];
const secretPatterns = [
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
];
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.xml', '.yml', '.yaml', '.ini', '.cfg']);
const reportPath = resolve(evidenceRoot, 'package-scan.json');
if (existsSync(reportPath)) unlinkSync(reportPath);
const sourceManifestPath = resolve(evidenceRoot, 'provenance', 'source-manifest.json');
const releasePolicyPath = resolve(projectRoot, 'build', 'release-policy.json');
if (!existsSync(sourceManifestPath) || !existsSync(releasePolicyPath)) {
  fail('Current source provenance and release policy are required before package scanning.');
}

const unpackedRoots = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
  .map((entry) => resolve(releaseRoot, entry.name));
if (unpackedRoots.length !== 1) fail(`Expected exactly one unpacked Windows application directory; found ${unpackedRoots.length}.`);

const findings = [];
let scannedFiles = 0;
let scannedDirectories = 0;
function inspectPath(relativePath) {
  const normalized = relativePath.split(sep).join('/').replace(/^\/+/, '');
  for (const pattern of forbiddenPaths) {
    if (pattern.test(normalized)) findings.push({ severity: 'block', kind: 'development-or-secret-path', path: normalized, rule: String(pattern) });
  }
  return normalized;
}
function inspect(relativePath, bufferProvider, size) {
  const normalized = inspectPath(relativePath);
  scannedFiles += 1;
  if (size > MAX_TEXT_BYTES || !textExtensions.has(extname(normalized).toLowerCase())) return;
  const text = bufferProvider().toString('utf8');
  for (const { id, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ severity: 'block', kind: 'secret-content', path: normalized, rule: id });
  }
}

const unpacked = unpackedRoots[0];
let physicalTree;
try {
  physicalTree = scanPackagedTree(
    unpacked,
    ({ normalizedPath, read, size }) => inspect(normalizedPath, read, size),
    ({ normalizedPath }) => {
      scannedDirectories += 1;
      inspectPath(normalizedPath);
    },
  );
} catch (error) {
  fail(`Unpacked application scan failed: ${error instanceof Error ? error.message : String(error)}`);
}
const archive = resolve(unpacked, 'resources', 'app.asar');
if (!existsSync(archive)) fail(`Packaged app archive is missing: ${archive}`);
const archiveStat = lstatSync(archive);
if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) fail(`Packaged app archive is unsafe: ${archive}`);
let asarScan;
const asarEntries = [];
try {
  asarScan = scanAsarArchive(
    archive,
    ({ normalizedPath, read, size }) => {
      asarEntries.push(normalizedPath);
      inspect(`app.asar/${normalizedPath}`, read, size);
    },
    ({ normalizedPath }) => {
      scannedDirectories += 1;
      inspectPath(`app.asar/${normalizedPath}`);
    },
  );
} catch (error) {
  fail(`ASAR package scan failed: ${error instanceof Error ? error.message : String(error)}`);
}
for (const missing of missingRequiredAsarEntries(asarEntries)) {
  findings.push({ severity: 'block', kind: 'required-file-missing', path: `app.asar/${missing}`, rule: 'required-asar-entry' });
}

const metadata = packageMetadata();
const installerFiles = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && artifactKind(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) => {
    const absolute = resolve(releaseRoot, entry.name);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Unsafe Windows installer: ${absolute}`);
    return {
      path: relative(projectRoot, absolute).split(sep).join('/'),
      size: stat.size,
      sha256: sha256File(absolute),
    };
  });
const installerKinds = new Set(installerFiles.map((file) => artifactKind(file.path)));
if (installerFiles.length !== 2 || !installerKinds.has('nsis') || !installerKinds.has('msi')
  || installerFiles.some((file) => !artifactMatchesVersion(file.path, metadata.version))) {
  fail(`Expected exactly one current-version NSIS and MSI installer; found ${installerFiles.map((file) => file.path).join(', ') || 'none'}.`);
}

const report = {
  schemaVersion: 3,
  generatedAt: utcNow(),
  sourceManifestSha256: sha256File(sourceManifestPath),
  releasePolicySha256: sha256File(releasePolicyPath),
  unpackedRoot: relative(projectRoot, unpacked).split(sep).join('/'),
  scannedFiles,
  scannedDirectories,
  physicalTree,
  asarScan,
  archive: {
    path: relative(projectRoot, archive).split(sep).join('/'),
    size: archiveStat.size,
    sha256: sha256File(archive),
  },
  installers: {
    files: installerFiles,
    treeSha256: inventoryDigest(installerFiles),
  },
  findings,
};
writeJson(reportPath, report);
if (findings.length > 0) fail(`Release package scan rejected ${findings.length} finding(s). See release/evidence/package-scan.json.`);
console.log(`Release package scan passed for ${scannedFiles} entries.`);
