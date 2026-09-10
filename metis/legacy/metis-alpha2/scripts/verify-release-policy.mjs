import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactKind,
  artifactMatchesVersion,
  evidenceRoot,
  fail,
  inventoryDigest,
  packageMetadata,
  projectRoot,
  provenanceRoot,
  readJson,
  releaseRoot,
  run,
  sha256File,
  utcNow,
  writeJson,
} from './release-lib.mjs';
import { scanPackagedTree } from './release-package-scan-lib.mjs';

const policyPath = resolve(projectRoot, 'build', 'release-policy.json');
const packageManifestPath = resolve(provenanceRoot, 'package-manifest.json');
const scanPath = resolve(evidenceRoot, 'package-scan.json');
const licenseInventoryPath = resolve(evidenceRoot, 'compliance', 'license-inventory.json');
const sbomPath = resolve(evidenceRoot, 'compliance', 'sbom.cdx.json');
const verificationPath = resolve(evidenceRoot, 'release-verification.json');

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function evaluateAuthenticode(records, windowsPolicy) {
  const issues = [];
  for (const record of records) {
    if (windowsPolicy.requireAuthenticode && record.status !== 'Valid') {
      issues.push({ code: 'authenticode_invalid', artifact: record.path, status: record.status });
    }
    if (windowsPolicy.requireTimestamp && !record.timestampSubject) {
      issues.push({ code: 'timestamp_missing', artifact: record.path });
    }
  }
  return issues;
}

// Task 5 (§5/§6): update trust gate. A STABLE release (version without a
// prerelease tag) may never ship unsigned installers — the gate rejects it
// instead of trusting an unverifiable update. Alpha/prerelease releases may
// ship unsigned artifacts but are disclosed as UNSIGNED in the report.
export function releaseChannelFor(version) {
  const prerelease = String(version ?? '').split('-').slice(1).join('-');
  return prerelease.length > 0 ? 'alpha' : 'stable';
}

export function evaluateUpdateTrust(metadata, windowsPolicy, signatures) {
  const channel = releaseChannelFor(metadata.version);
  const allSigned = (signatures ?? []).every((record) => record.status === 'Valid');
  const issues = [];
  const notices = [];
  if (channel === 'stable' && !allSigned) {
    issues.push({
      code: 'stable_unsigned_update_blocked',
      detail: 'Stable releases must ship Authenticode-signed installers; set windows.requireAuthenticode and sign the artifacts (see docs/UPDATE_TRUST_MODEL.md).',
    });
  }
  if (channel === 'alpha' && !allSigned && windowsPolicy.requireAuthenticode !== true) {
    notices.push({
      code: 'unsigned_alpha_release',
      detail: 'UNSIGNED ALPHA — NOT RELEASE SAFE. Artifacts are unsigned; in-app updates disclose this state and stable keeps install blocked until a certificate exists.',
    });
  }
  return { channel, allSigned, issues, notices };
}

export function validateArtifactSet(artifacts, windowsPolicy, metadata, inspectFile) {
  const issues = [];
  const requiredKinds = new Set(windowsPolicy.requiredArtifacts || []);
  const seenKinds = new Set();
  for (const artifact of artifacts) {
    const kind = artifactKind(artifact.path);
    if (kind) seenKinds.add(kind);
    if (!artifactMatchesVersion(artifact.path, metadata.version)) {
      issues.push({ code: 'artifact_version_mismatch', artifact: artifact.path });
    }
    if (!artifact.path.toLowerCase().includes('-x64.')) {
      issues.push({ code: 'artifact_architecture_mismatch', artifact: artifact.path });
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !isSha256(artifact.sha256)) {
      issues.push({ code: 'artifact_manifest_invalid', artifact: artifact.path });
      continue;
    }
    const actual = inspectFile(artifact.path);
    if (!actual.exists || !actual.isFile) {
      issues.push({ code: 'artifact_missing', artifact: artifact.path });
    } else if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
      issues.push({ code: 'artifact_checksum_mismatch', artifact: artifact.path });
    }
  }
  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind)) issues.push({ code: 'required_artifact_missing', kind });
  }
  if (artifacts.length !== requiredKinds.size) {
    issues.push({ code: 'unexpected_artifact_count', expected: requiredKinds.size, actual: artifacts.length });
  }
  return issues;
}

function sameFileInventory(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((file, index) => file?.path === right[index]?.path
      && file?.size === right[index]?.size && file?.sha256 === right[index]?.sha256);
}

export function validatePackageScan(scan, expected, inspectFile) {
  const issues = [];
  if (!scan || scan.schemaVersion !== 3) return [{ code: 'package_scan_schema_invalid' }];
  if (!isSha256(scan.sourceManifestSha256)
    || scan.sourceManifestSha256 !== expected?.sourceManifestSha256) {
    issues.push({ code: 'package_scan_source_mismatch' });
  }
  if (!isSha256(scan.releasePolicySha256)
    || scan.releasePolicySha256 !== expected?.releasePolicySha256) {
    issues.push({ code: 'package_scan_policy_mismatch' });
  }
  if (!Array.isArray(scan.findings) || scan.findings.length > 0) {
    issues.push({ code: 'package_scan_failed', findingCount: scan.findings?.length ?? null });
  }
  const asarScan = scan.asarScan;
  const physicalTree = scan.physicalTree;
  if (!asarScan || !Number.isSafeInteger(asarScan.listedEntries) || asarScan.listedEntries <= 0
    || !Number.isSafeInteger(asarScan.scannedFiles) || asarScan.scannedFiles <= 0
    || !Number.isSafeInteger(asarScan.directories) || asarScan.directories < 0
    || asarScan.listedEntries !== asarScan.scannedFiles + asarScan.directories
    || !physicalTree || !Number.isSafeInteger(physicalTree.listedEntries) || physicalTree.listedEntries <= 0
    || !Number.isSafeInteger(physicalTree.scannedFiles) || physicalTree.scannedFiles <= 0
    || !Number.isSafeInteger(physicalTree.directories) || physicalTree.directories < 0
    || physicalTree.listedEntries !== physicalTree.scannedFiles + physicalTree.directories
    || !isSha256(physicalTree.treeSha256)
    || scan.scannedFiles !== asarScan.scannedFiles + physicalTree.scannedFiles
    || scan.scannedDirectories !== asarScan.directories + physicalTree.directories) {
    issues.push({ code: 'package_scan_coverage_invalid' });
  }
  if (!expected || scan.unpackedRoot !== expected.unpackedRoot) {
    issues.push({ code: 'package_scan_unpacked_root_mismatch' });
  }
  if (!expected?.physicalTree || !physicalTree
    || physicalTree.listedEntries !== expected.physicalTree.listedEntries
    || physicalTree.scannedFiles !== expected.physicalTree.scannedFiles
    || physicalTree.directories !== expected.physicalTree.directories
    || physicalTree.treeSha256 !== expected.physicalTree.treeSha256) {
    issues.push({ code: 'package_scan_tree_mismatch' });
  }
  const archive = scan.archive;
  if (!archive || archive.path !== expected?.archivePath || !Number.isSafeInteger(archive.size)
    || archive.size <= 0 || !isSha256(archive.sha256)) {
    issues.push({ code: 'package_scan_archive_manifest_invalid' });
  } else {
    const actual = inspectFile(archive.path);
    if (!actual.exists || !actual.isFile || actual.size !== archive.size || actual.sha256 !== archive.sha256) {
      issues.push({ code: 'package_scan_archive_mismatch' });
    }
  }
  const scannedInstallers = scan.installers;
  const installerFiles = scannedInstallers?.files;
  if (!scannedInstallers || !sameFileInventory(installerFiles, expected?.installers)
    || !isSha256(scannedInstallers.treeSha256)
    || scannedInstallers.treeSha256 !== inventoryDigest(installerFiles ?? [])) {
    issues.push({ code: 'package_scan_installer_manifest_mismatch' });
  } else {
    for (const installer of installerFiles) {
      const actual = inspectFile(installer.path);
      if (!actual.exists || !actual.isFile || actual.size !== installer.size || actual.sha256 !== installer.sha256) {
        issues.push({ code: 'package_scan_installer_mismatch', artifact: installer.path });
      }
    }
  }
  return issues;
}

export function readAuthenticode(artifacts) {
  const quotedPaths = artifacts.map((artifact) => {
    const absolute = resolve(projectRoot, artifact.path);
    return `'${absolute.replaceAll("'", "''")}'`;
  }).join(',');
  const script = [
    `$paths=@(${quotedPaths})`,
    '$rows=@(foreach($path in $paths){',
    '  $signature=Get-AuthenticodeSignature -LiteralPath $path',
    '  $signerSubject=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{$null}',
    '  $signerThumbprint=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Thumbprint}else{$null}',
    '  $timestampSubject=if($signature.TimeStamperCertificate){[string]$signature.TimeStamperCertificate.Subject}else{$null}',
    '  [pscustomobject]@{',
    '    status=[string]$signature.Status',
    '    signerSubject=$signerSubject',
    '    signerThumbprint=$signerThumbprint',
    '    timestampSubject=$timestampSubject',
    '  }',
    '})',
    '$rows | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const parsed = JSON.parse(result.stdout || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((record, index) => ({
    path: artifacts[index]?.path ?? null,
    status: typeof record?.status === 'string' ? record.status : 'Unknown',
    signerSubject: typeof record?.signerSubject === 'string' ? record.signerSubject : null,
    signerThumbprint: typeof record?.signerThumbprint === 'string' ? record.signerThumbprint : null,
    timestampSubject: typeof record?.timestampSubject === 'string' ? record.timestampSubject : null,
  }));
}

function validatePolicy(policy, metadata) {
  if (policy?.schemaVersion !== 1 || policy?.product !== metadata.productName) fail('Release policy product/schema does not match package metadata.');
  if (policy?.appId !== metadata.appId) fail('Release policy appId does not match package metadata.');
  if (!Array.isArray(policy?.windows?.requiredArtifacts) || policy.windows.requiredArtifacts.length === 0) fail('Release policy has no required Windows artifacts.');
  if (policy.release?.allowDirtySource !== false) fail('Release policy must reject dirty source.');
}

export function main() {
  if (existsSync(verificationPath)) unlinkSync(verificationPath);
  for (const required of [policyPath, packageManifestPath, scanPath, licenseInventoryPath, sbomPath]) {
    if (!existsSync(required)) fail(`Missing release verification input: ${required}`);
  }
  const metadata = packageMetadata();
  const policy = readJson(policyPath);
  validatePolicy(policy, metadata);

  run(process.execPath, [resolve(projectRoot, 'scripts', 'release-provenance.mjs'), 'verify']);
  const packaged = readJson(packageManifestPath);
  const scan = readJson(scanPath);
  const licenses = readJson(licenseInventoryPath);
  const sbom = readJson(sbomPath);
  const issues = [];

  const unpackedRoots = readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'));
  if (unpackedRoots.length !== 1) fail(`Expected exactly one current unpacked application; found ${unpackedRoots.length}.`);
  const unpackedAbsolute = resolve(releaseRoot, unpackedRoots[0].name);
  const unpackedRelative = relative(projectRoot, unpackedAbsolute).split(sep).join('/');
  const physicalTree = scanPackagedTree(unpackedAbsolute);
  const expectedScan = {
    unpackedRoot: unpackedRelative,
    archivePath: `${unpackedRelative}/resources/app.asar`,
    physicalTree,
    installers: packaged?.packages?.files ?? [],
    sourceManifestSha256: packaged?.sourceManifestSha256,
    releasePolicySha256: sha256File(policyPath),
  };

  issues.push(...validatePackageScan(scan, expectedScan, (relativePath) => {
    const absolute = resolve(projectRoot, relativePath);
    if (!existsSync(absolute)) return { exists: false, isFile: false, size: 0, sha256: null };
    const stat = lstatSync(absolute);
    return {
      exists: true,
      isFile: stat.isFile() && !stat.isSymbolicLink(),
      size: stat.size,
      sha256: stat.isFile() ? sha256File(absolute) : null,
    };
  }));
  if (!Array.isArray(licenses.packages) || licenses.packages.length === 0) issues.push({ code: 'license_inventory_empty' });
  if (policy.release?.allowMissingLicenses === false) {
    for (const item of licenses.packages || []) {
      if (typeof item.license !== 'string' || item.license.trim() === '' || /^(unknown|unlicensed|none)$/i.test(item.license.trim())) {
        issues.push({ code: 'license_missing', package: `${item.name}@${item.version}` });
      }
    }
  }
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0) issues.push({ code: 'sbom_invalid' });

  const artifacts = packaged?.packages?.files || [];
  issues.push(...validateArtifactSet(artifacts, policy.windows, metadata, (relativePath) => {
    const absolute = resolve(projectRoot, relativePath);
    if (!existsSync(absolute)) return { exists: false, isFile: false, size: 0, sha256: null };
    const stat = lstatSync(absolute);
    return { exists: true, isFile: stat.isFile() && !stat.isSymbolicLink(), size: stat.size, sha256: stat.isFile() ? sha256File(absolute) : null };
  }));

  const signatures = readAuthenticode(artifacts);
  issues.push(...evaluateAuthenticode(signatures, policy.windows));
  const updateTrust = evaluateUpdateTrust(metadata, policy.windows, signatures);
  issues.push(...updateTrust.issues);
  const report = {
    schemaVersion: 1,
    generatedAt: utcNow(),
    product: metadata,
    policy: {
      requireAuthenticode: policy.windows.requireAuthenticode,
      requireTimestamp: policy.windows.requireTimestamp,
      requireSha256Checksums: policy.windows.requireSha256Checksums,
    },
    artifacts: artifacts.map((artifact) => ({
      kind: artifactKind(artifact.path),
      fileName: basename(artifact.path),
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    signatures,
    updateTrust: {
      channel: updateTrust.channel,
      allSigned: updateTrust.allSigned,
      notices: updateTrust.notices,
      trustLabel: updateTrust.channel === 'stable'
        ? (updateTrust.allSigned ? 'SIGNED / RELEASE SAFE' : 'UNSIGNED STABLE — BLOCKED BY GATE')
        : (updateTrust.allSigned ? 'SIGNED (alpha)' : 'UNSIGNED ALPHA — DEV ONLY / NOT RELEASE SAFE'),
    },
    packageScan: {
      scannedFiles: scan.scannedFiles,
      scannedDirectories: scan.scannedDirectories,
      asarScannedFiles: scan.asarScan?.scannedFiles ?? null,
      sourceManifestSha256: scan.sourceManifestSha256 ?? null,
      releasePolicySha256: scan.releasePolicySha256 ?? null,
      physicalTreeSha256: scan.physicalTree?.treeSha256 ?? null,
      archiveSha256: scan.archive?.sha256 ?? null,
      installerTreeSha256: scan.installers?.treeSha256 ?? null,
      findings: Array.isArray(scan.findings) ? scan.findings.length : null,
    },
    compliance: { packages: licenses.packages.length, sbomComponents: sbom.components.length },
    issues,
    passed: issues.length === 0,
  };
  writeJson(verificationPath, report);
  if (issues.length > 0) fail(`Release verification rejected ${issues.length} issue(s). See ${verificationPath}.`);
  console.log(`Release policy verification passed for ${artifacts.length} Windows installers.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
