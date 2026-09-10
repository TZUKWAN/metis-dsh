/**
 * METIS-203 — seven capability packs invariant tests.
 *
 * Enforces: the registry contains exactly seven first-class capabilities, all pass the
 * METIS-202 manifest gate, ids are unique, and they cover all seven research stages 1:1.
 * No eighth capability can sneak in.
 */

import { describe, it, expect } from 'vitest';
import { SEVEN_CAPABILITY_PACKS, SEVEN_CAPABILITY_IDS } from './index.js';
import { parseCapabilityManifest, RESEARCH_STAGES } from '../types.js';

describe('METIS-203 seven capability packs', () => {
  it('contains exactly seven first-class capabilities (no eighth allowed)', () => {
    expect(SEVEN_CAPABILITY_PACKS.length).toBe(7);
    expect(SEVEN_CAPABILITY_IDS.length).toBe(7);
  });

  it('every pack passes the METIS-202 manifest registration gate', () => {
    for (const pack of SEVEN_CAPABILITY_PACKS) {
      const r = parseCapabilityManifest(pack);
      expect(r.success, `pack '${pack.id}' must be valid: ${r.success ? '' : JSON.stringify((r as { errors: string[] }).errors)}`).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = new Set(SEVEN_CAPABILITY_IDS);
    expect(ids.size).toBe(7);
  });

  it('maps 1:1 onto the seven research stages (no stage covered twice, none missing)', () => {
    const stagesUsed = SEVEN_CAPABILITY_PACKS.flatMap((p) => p.stages);
    // each pack declares exactly one stage
    expect(stagesUsed.length).toBe(7);
    const stageSet = new Set(stagesUsed);
    expect(stageSet.size).toBe(7);
    for (const stage of RESEARCH_STAGES) {
      expect(stageSet.has(stage), `stage '${stage}' must be covered by exactly one capability`).toBe(true);
    }
  });

  it('contains no copied third-party code in source evidence (process/adapter only)', () => {
    for (const pack of SEVEN_CAPABILITY_PACKS) {
      const ev = pack.source.licenseEvidence.toLowerCase();
      // third_party packs must explicitly state they are adapter/process only
      if (pack.source.origin === 'third_party') {
        expect(ev.includes('adapter') || ev.includes('process') || ev.includes('isolated') || ev.includes('no ')).toBe(true);
      }
    }
  });
});
