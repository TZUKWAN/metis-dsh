import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DELIVERABLE_PROFILES,
  DeliverableProfileSchema,
  getDeliverableProfile,
} from '../DeliverableProfile.js';

describe('DeliverableProfile contract', () => {
  it('ships exactly the five versioned academic deliverable profiles', () => {
    expect(BUILTIN_DELIVERABLE_PROFILES.map((profile) => profile.id)).toEqual([
      'core_cn',
      'sci',
      'domestic_thesis',
      'overseas_thesis',
      'research_report',
    ]);
    for (const profile of BUILTIN_DELIVERABLE_PROFILES) {
      expect(DeliverableProfileSchema.safeParse(profile).success).toBe(true);
      expect(profile.schemaVersion).toBe(1);
      expect(profile.profileVersion).toMatch(/^1\./u);
      expect(profile.structure.requiredSections.length).toBeGreaterThan(0);
      expect(profile.template.required).toBe(true);
      expect(profile.template.templateIds).toHaveLength(1);
      expect(profile.citation.requireStructuredAst).toBe(true);
      expect(profile.citation.requireLocator).toBe(true);
      expect(profile.citation.requireTriangulation).toBe(true);
      expect(profile.citation.requirePassport).toBe(true);
      expect(profile.citation.rejectRetracted).toBe(true);
      expect(profile.citation.requireJournalIntegrity).toBe(true);
      expect(profile.approval.releaseRequiresHuman).toBe(true);
    }
  });

  it('encodes venue/school distinctions instead of treating all papers alike', () => {
    expect(getDeliverableProfile('core_cn')?.venue.required).toBe(true);
    expect(getDeliverableProfile('sci')?.venue.required).toBe(true);
    expect(getDeliverableProfile('domestic_thesis')?.school.required).toBe(true);
    expect(getDeliverableProfile('overseas_thesis')?.school.required).toBe(true);
    expect(getDeliverableProfile('research_report')?.approval.requiredStages).toContain('release');
  });

  it('rejects a weakened profile that permits unverified citation truth', () => {
    const profile = structuredClone(BUILTIN_DELIVERABLE_PROFILES[0]!);
    profile.citation.requireTriangulation = false;
    expect(DeliverableProfileSchema.safeParse(profile).success).toBe(false);
  });
});
