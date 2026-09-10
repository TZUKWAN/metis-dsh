import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import {
  assertProvenanceManifest,
  assertReleaseGitState,
  githubRepositorySlug,
} from './release-provenance-lib.mjs';
import {
  artifactKind,
  artifactMatchesVersion,
  git,
  inventoryDigest,
  inventoryExplicitFiles,
  inventoryFiles,
  manifestDigest,
  packageMetadata,
  projectRoot,
  provenanceRoot,
  readJson,
  releaseRoot,
  run,
  sha256File,
  utcNow,
  writeJson,
  fail,
} from './release-lib.mjs';

const stage = process.argv[2];
const sourcePath = resolve(provenanceRoot, 'source-manifest.json');
const distPath = resolve(provenanceRoot, 'dist-manifest.json');
const packagePath = resolve(provenanceRoot, 'package-manifest.json');
const packageScanPath = resolve(releaseRoot, 'evidence', 'package-scan.json');
const releasePolicyPath = resolve(projectRoot, 'build', 'release-policy.json');

function currentGitState() {
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const originResult = run('git', ['remote', 'get-url', 'origin'], { allowFailure: true });
  const upstreamResult = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  const originSlug = originResult.status === 0 ? githubRepositorySlug(originResult.stdout.trim()) : null;
  const upstream = upstreamResult.status === 0 ? upstreamResult.stdout.trim() : null;
  const upstreamHead = upstream ? git(['rev-parse', `${upstream}^{commit}`]) : null;
  return {
    head,
    branch,
    clean: porcelain.length === 0,
    statusSha256: manifestDigest(porcelain),
    originRepository: originSlug,
    upstream,
    upstreamHead,
    headMatchesUpstream: upstreamHead === head,
  };
}

function buildEnvironment() {
  const pkg = readJson(resolve(projectRoot, 'package.json'));
  const npm = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
  return {
    node: process.version,
    nodeModulesAbi: process.versions.modules,
    npm: npm.stdout.trim(),
    electron: pkg.devDependencies?.electron ?? null,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
  };
}

function sourceInventory() {
  const files = inventoryExplicitFiles(git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  return { files, treeSha256: inventoryDigest(files) };
}

function requireCleanSource() {
  const state = currentGitState();
  return assertReleaseGitState(state);
}

function verifySource(source) {
  const metadata = packageMetadata();
  const gitState = requireCleanSource();
  const current = sourceInventory();
  if (manifestDigest(source.product) !== manifestDigest(metadata)) fail('Package metadata changed after source manifest generation.');
  if (source.expectedTag !== `v${metadata.version}`) fail('Expected release tag does not match the package version.');
  if (source.git.head !== gitState.head || source.git.branch !== gitState.branch) fail('Git HEAD or branch changed after source manifest generation.');
  if (source.git.originRepository !== gitState.originRepository
    || source.git.upstream !== gitState.upstream
    || source.git.upstreamHead !== gitState.upstreamHead
    || source.git.headMatchesUpstream !== true) {
    fail('Git origin/upstream provenance changed after source manifest generation.');
  }
  if (manifestDigest(source.buildEnvironment) !== manifestDigest(buildEnvironment())) {
    fail('Build environment changed after source manifest generation.');
  }
  if (source.source.treeSha256 !== current.treeSha256) fail('Current source bytes do not match the source provenance manifest.');
  return current;
}

function distInventory() {
  const files = inventoryFiles(['dist', 'dist-electron'], {
    exclude: (rel) => rel.endsWith('.map') || rel.includes('/.cache/'),
  });
  if (files.length === 0) fail('No dist files were found.');
  return { files, treeSha256: inventoryDigest(files) };
}

function packageInventory(version) {
  const files = inventoryFiles(['release'], {
    exclude: (rel, stat) => stat.isDirectory() && rel === 'release/evidence',
  }).filter((file) => artifactKind(file.path));
  const artifacts = files.filter((file) => artifactMatchesVersion(file.path, version));
  const kinds = new Set(artifacts.map((file) => artifactKind(file.path)));
  if (artifacts.length !== 2 || !kinds.has('nsis') || !kinds.has('msi')) {
    fail(`Expected exactly one versioned NSIS EXE and one MSI for ${version}; found ${artifacts.map((item) => item.path).join(', ') || 'none'}.`);
  }
  return { files: artifacts, treeSha256: inventoryDigest(artifacts) };
}

if (stage === 'source') {
  const metadata = packageMetadata();
  const gitState = requireCleanSource();
  const source = sourceInventory();
  const manifest = {
    schemaVersion: 1,
    stage: 'current-source',
    generatedAt: utcNow(),
    product: metadata,
    git: gitState,
    expectedTag: `v${metadata.version}`,
    buildEnvironment: buildEnvironment(),
    source,
  };
  writeJson(sourcePath, { ...manifest, manifestSha256: manifestDigest(manifest) });
  console.log(`Source manifest written: ${sourcePath}`);
} else if (stage === 'dist') {
  if (!existsSync(sourcePath)) fail('Source manifest is required before dist provenance.');
  const source = assertProvenanceManifest(readJson(sourcePath), 'current-source');
  verifySource(source);
  const dist = distInventory();
  const manifest = {
    schemaVersion: 1,
    stage: 'dist',
    generatedAt: utcNow(),
    product: source.product,
    sourceManifestSha256: sha256File(sourcePath),
    sourceTreeSha256: source.source.treeSha256,
    dist,
  };
  writeJson(distPath, { ...manifest, manifestSha256: manifestDigest(manifest) });
  console.log(`Dist manifest written: ${distPath}`);
} else if (stage === 'package') {
  if (!existsSync(sourcePath) || !existsSync(distPath) || !existsSync(packageScanPath)) {
    fail('Source, dist, and package scan manifests are required before package provenance.');
  }
  const source = assertProvenanceManifest(readJson(sourcePath), 'current-source');
  const dist = assertProvenanceManifest(readJson(distPath), 'dist');
  const packageScan = readJson(packageScanPath);
  if (packageScan.schemaVersion !== 3 || !packageScan.physicalTree?.treeSha256
    || !packageScan.archive?.sha256 || !packageScan.installers?.treeSha256) {
    fail('Package scan manifest is incomplete or stale.');
  }
  if (packageScan.sourceManifestSha256 !== sha256File(sourcePath)) {
    fail('Package scan is not bound to the current source manifest.');
  }
  if (packageScan.releasePolicySha256 !== sha256File(releasePolicyPath)) {
    fail('Package scan is not bound to the current release policy.');
  }
  verifySource(source);
  const currentDist = distInventory();
  if (currentDist.treeSha256 !== dist.dist.treeSha256) fail('Dist bytes changed after the dist manifest was generated.');
  if (dist.sourceManifestSha256 !== sha256File(sourcePath)) fail('Dist manifest is not bound to the current source manifest file.');
  const packages = packageInventory(source.product.version);
  if (packageScan.installers.treeSha256 !== packages.treeSha256) {
    fail('Package scan installer inventory does not match the package artifacts.');
  }
  const manifest = {
    schemaVersion: 1,
    stage: 'package',
    generatedAt: utcNow(),
    product: source.product,
    sourceManifestSha256: sha256File(sourcePath),
    sourceTreeSha256: source.source.treeSha256,
    distManifestSha256: sha256File(distPath),
    distTreeSha256: dist.dist.treeSha256,
    packageScanManifestSha256: sha256File(packageScanPath),
    scannedPhysicalTreeSha256: packageScan.physicalTree.treeSha256,
    scannedArchiveSha256: packageScan.archive.sha256,
    scannedInstallerTreeSha256: packageScan.installers.treeSha256,
    packages,
  };
  writeJson(packagePath, { ...manifest, manifestSha256: manifestDigest(manifest) });
  console.log(`Package manifest written: ${packagePath}`);
} else if (stage === 'verify') {
  for (const required of [sourcePath, distPath, packagePath, packageScanPath]) if (!existsSync(required)) fail(`Missing provenance manifest: ${required}`);
  const source = assertProvenanceManifest(readJson(sourcePath), 'current-source');
  const dist = assertProvenanceManifest(readJson(distPath), 'dist');
  const packaged = assertProvenanceManifest(readJson(packagePath), 'package');
  const packageScan = readJson(packageScanPath);
  verifySource(source);
  if (dist.sourceManifestSha256 !== sha256File(sourcePath)) fail('Dist provenance source link is invalid.');
  if (packaged.sourceManifestSha256 !== sha256File(sourcePath)) fail('Package provenance source link is invalid.');
  if (packaged.distManifestSha256 !== sha256File(distPath)) fail('Package provenance dist link is invalid.');
  if (packaged.packageScanManifestSha256 !== sha256File(packageScanPath)) fail('Package provenance scan link is invalid.');
  if (packageScan.sourceManifestSha256 !== sha256File(sourcePath)) fail('Package scan source link is invalid.');
  if (packageScan.releasePolicySha256 !== sha256File(releasePolicyPath)) fail('Package scan policy link is invalid.');
  if (packaged.scannedPhysicalTreeSha256 !== packageScan.physicalTree?.treeSha256
    || packaged.scannedArchiveSha256 !== packageScan.archive?.sha256
    || packaged.scannedInstallerTreeSha256 !== packageScan.installers?.treeSha256) {
    fail('Package provenance scan summary is invalid.');
  }
  const currentDist = distInventory();
  if (currentDist.treeSha256 !== packaged.distTreeSha256) fail('Current dist bytes do not match package provenance.');
  const currentPackages = packageInventory(source.product.version);
  if (packageScan.installers?.treeSha256 !== currentPackages.treeSha256) fail('Package scan installer link is invalid.');
  if (currentPackages.treeSha256 !== packaged.packages.treeSha256) fail('Current installer bytes do not match package provenance.');
  console.log('Source, dist, and package provenance links are intact.');
} else {
  fail('Usage: node scripts/release-provenance.mjs <source|dist|package|verify>');
}
