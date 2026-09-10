import { describe, expect, it } from 'vitest';
import { evaluateAuthenticode, validateArtifactSet, validatePackageScan } from '../../scripts/verify-release-policy.mjs';
import { inventoryDigest } from '../../scripts/release-lib.mjs';

const metadata = { version: '1.2.3', productName: 'Metis Research Workbench', appId: 'com.metis.workbench' };
const windowsPolicy = { requiredArtifacts: ['nsis', 'msi'], requireAuthenticode: true, requireTimestamp: true };
const hash = 'a'.repeat(64);
const artifacts = [
  { path: 'release/Metis-Setup-1.2.3-x64.exe', size: 10, sha256: hash },
  { path: 'release/Metis-1.2.3-x64.msi', size: 20, sha256: hash },
];

describe('release policy verification', () => {
  it('rejects stale or incomplete scan evidence and binds the scanned ASAR digest', () => {
    const physicalTree = {
      listedEntries: 590,
      scannedFiles: 452,
      directories: 138,
      treeSha256: hash,
    };
    const installers = artifacts.map((artifact) => ({ ...artifact }));
    const valid = {
      schemaVersion: 3,
      sourceManifestSha256: hash,
      releasePolicySha256: hash,
      unpackedRoot: 'release/win-unpacked',
      scannedFiles: 12_806,
      scannedDirectories: 1_200,
      physicalTree,
      asarScan: { listedEntries: 13_416, scannedFiles: 12_354, directories: 1_062 },
      archive: { path: 'release/win-unpacked/resources/app.asar', size: 123, sha256: hash },
      installers: { files: installers, treeSha256: inventoryDigest(installers) },
      findings: [],
    };
    const expected = {
      unpackedRoot: 'release/win-unpacked',
      archivePath: 'release/win-unpacked/resources/app.asar',
      physicalTree,
      installers,
      sourceManifestSha256: hash,
      releasePolicySha256: hash,
    };
    const inspect = (file: string) => ({
      exists: true,
      isFile: true,
      size: file.endsWith('.msi') ? 20 : file.includes('Setup') ? 10 : 123,
      sha256: hash,
    });
    expect(validatePackageScan(valid, expected, inspect)).toEqual([]);
    expect(validatePackageScan({ ...valid, schemaVersion: 1 }, expected, inspect))
      .toContainEqual({ code: 'package_scan_schema_invalid' });
    expect(validatePackageScan({ ...valid, asarScan: { ...valid.asarScan, scannedFiles: 4 } }, expected, inspect))
      .toContainEqual({ code: 'package_scan_coverage_invalid' });
    expect(validatePackageScan(valid, expected, () => ({
      exists: true, isFile: true, size: 123, sha256: 'b'.repeat(64),
    }))).toContainEqual({ code: 'package_scan_archive_mismatch' });
    expect(validatePackageScan(valid, { ...expected, unpackedRoot: 'release/current-unpacked' }, inspect))
      .toContainEqual({ code: 'package_scan_unpacked_root_mismatch' });
    expect(validatePackageScan({ ...valid, unpackedRoot: '../old-unpacked' }, expected, inspect))
      .toContainEqual({ code: 'package_scan_unpacked_root_mismatch' });
    expect(validatePackageScan(valid, {
      ...expected,
      physicalTree: { ...physicalTree, treeSha256: 'b'.repeat(64) },
    }, inspect)).toContainEqual({ code: 'package_scan_tree_mismatch' });
    expect(validatePackageScan({
      ...valid,
      installers: { ...valid.installers, files: valid.installers.files.slice(0, 1) },
    }, expected, inspect)).toContainEqual({ code: 'package_scan_installer_manifest_mismatch' });
    expect(validatePackageScan({ ...valid, sourceManifestSha256: 'b'.repeat(64) }, expected, inspect))
      .toContainEqual({ code: 'package_scan_source_mismatch' });
    expect(validatePackageScan({ ...valid, releasePolicySha256: 'b'.repeat(64) }, expected, inspect))
      .toContainEqual({ code: 'package_scan_policy_mismatch' });
  });

  it('accepts an exact versioned x64 NSIS/MSI set with matching checksums', () => {
    const issues = validateArtifactSet(artifacts, windowsPolicy, metadata, (path: string) => ({
      exists: true,
      isFile: true,
      size: path.endsWith('.msi') ? 20 : 10,
      sha256: hash,
    }));
    expect(issues).toEqual([]);
  });

  it('rejects missing artifacts and checksum mismatches', () => {
    const issues = validateArtifactSet(artifacts.slice(0, 1), windowsPolicy, metadata, () => ({
      exists: true,
      isFile: true,
      size: 10,
      sha256: 'b'.repeat(64),
    }));
    expect(issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
      'artifact_checksum_mismatch',
      'required_artifact_missing',
      'unexpected_artifact_count',
    ]));
  });

  it('does not accept a longer prerelease version that merely shares the requested prefix', () => {
    const wrongVersion = artifacts.map((artifact) => ({
      ...artifact,
      path: artifact.path.replace('1.2.3', '1.2.30'),
    }));
    const issues = validateArtifactSet(wrongVersion, windowsPolicy, metadata, (path: string) => ({
      exists: true,
      isFile: true,
      size: path.endsWith('.msi') ? 20 : 10,
      sha256: hash,
    }));
    expect(issues.filter((issue: { code: string }) => issue.code === 'artifact_version_mismatch')).toHaveLength(2);
  });

  it('requires both a valid Authenticode signature and timestamp certificate', () => {
    const issues = evaluateAuthenticode([
      { path: artifacts[0].path, status: 'NotSigned', timestampSubject: null },
    ], windowsPolicy);
    expect(issues.map((issue: { code: string }) => issue.code)).toEqual(['authenticode_invalid', 'timestamp_missing']);
    expect(evaluateAuthenticode([
      { path: artifacts[0].path, status: 'Valid', timestampSubject: 'CN=Timestamp Authority' },
    ], windowsPolicy)).toEqual([]);
  });
});
