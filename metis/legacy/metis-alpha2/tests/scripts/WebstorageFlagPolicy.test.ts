/**
 * --no-webstorage injection policy: the flag must reach workers only where it
 * is both needed and legal (Node >=25). Injecting it on Node 22 CI runners
 * used to kill every worker at spawn ("--no-webstorage is not allowed in
 * NODE_OPTIONS") and hang the whole job for 30 minutes.
 */
import { describe, expect, it } from 'vitest';
import { shouldInjectNoWebstorage } from '../../scripts/lib/webstorage-flag-policy.mjs';

describe('--no-webstorage injection policy', () => {
  it('injects on Node >=25 where the Web Storage global exists', () => {
    expect(shouldInjectNoWebstorage('25.6.0', {})).toBe(true);
    expect(shouldInjectNoWebstorage('26.1.2', {})).toBe(true);
  });

  it('never injects on Node 22 CI runners (flag is rejected there)', () => {
    expect(shouldInjectNoWebstorage('22.23.2', {})).toBe(false);
    expect(shouldInjectNoWebstorage('22.0.0', {})).toBe(false);
  });

  it('never injects on older LTS lines either', () => {
    expect(shouldInjectNoWebstorage('20.18.0', {})).toBe(false);
    expect(shouldInjectNoWebstorage('18.0.0', {})).toBe(false);
  });

  it('respects the Electron built-in Node override', () => {
    expect(shouldInjectNoWebstorage('25.6.0', { METIS_ELECTRON_NODE: '1' })).toBe(false);
  });

  it('treats unparseable versions conservatively (no injection)', () => {
    expect(shouldInjectNoWebstorage('', {})).toBe(false);
    expect(shouldInjectNoWebstorage('abc', {})).toBe(false);
  });
});
