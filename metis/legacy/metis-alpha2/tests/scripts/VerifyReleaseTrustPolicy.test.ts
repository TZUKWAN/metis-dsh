/**
 * Release update-trust gate tests — stable releases must never pass the
 * release policy verification with unsigned installers; alpha releases pass
 * with an explicit UNSIGNED disclosure.
 */
import { describe, expect, it } from 'vitest';
import { evaluateUpdateTrust, releaseChannelFor } from '../../scripts/verify-release-policy.mjs';

const windowsPolicy = { requireAuthenticode: false, requireTimestamp: false, requireSha256Checksums: true };
const unsigned = [{ path: 'release4/a.exe', status: 'NotSigned' }, { path: 'release4/b.msi', status: 'NotSigned' }];
const signed = [{ path: 'release4/a.exe', status: 'Valid' }, { path: 'release4/b.msi', status: 'Valid' }];

describe('releaseChannelFor', () => {
  it('classifies prerelease versions as alpha and plain versions as stable', () => {
    expect(releaseChannelFor('0.1.0-alpha.3')).toBe('alpha');
    expect(releaseChannelFor('0.1.0-alpha.2')).toBe('alpha');
    expect(releaseChannelFor('1.0.0-rc.1')).toBe('alpha');
    expect(releaseChannelFor('1.0.0')).toBe('stable');
  });
});

describe('evaluateUpdateTrust', () => {
  it('rejects an unsigned STABLE release even though allowUnsignedArtifacts is true', () => {
    const result = evaluateUpdateTrust({ version: '1.0.0', productName: 'Metis Research Workbench' }, windowsPolicy, unsigned);
    expect(result.channel).toBe('stable');
    expect(result.allSigned).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('stable_unsigned_update_blocked');
  });

  it('accepts a signed STABLE release with no trust issues', () => {
    const result = evaluateUpdateTrust({ version: '1.0.0' }, windowsPolicy, signed);
    expect(result.channel).toBe('stable');
    expect(result.allSigned).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it('allows an unsigned ALPHA release but records the unsigned disclosure', () => {
    const result = evaluateUpdateTrust({ version: '0.1.0-alpha.3' }, windowsPolicy, unsigned);
    expect(result.channel).toBe('alpha');
    expect(result.issues).toEqual([]);
    expect(result.notices.map((n) => n.code)).toContain('unsigned_alpha_release');
    expect(result.notices[0].detail).toMatch(/NOT RELEASE SAFE/);
  });

  it('reports signed alpha without disclosures', () => {
    const result = evaluateUpdateTrust({ version: '0.2.0-alpha.1' }, windowsPolicy, signed);
    expect(result.issues).toEqual([]);
    expect(result.notices).toEqual([]);
  });
});
