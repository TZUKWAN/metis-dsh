import { describe, it, expect } from 'vitest';
import { getSectionGuide, SECTION_GUIDE_SECTIONS } from '../SectionGuide.js';
import { STAGE_ORDER } from '../WritingPipeline.js';

describe('SectionGuide', () => {
  it('returns guidance for all supported sections', () => {
    for (const section of SECTION_GUIDE_SECTIONS) {
      const guide = getSectionGuide(section);
      expect(guide).toContain('##');
      expect(guide).toContain('Checklist');
      expect(guide.length).toBeGreaterThan(100);
    }
  });

  it('handles alternate casing and spacing', () => {
    expect(getSectionGuide('Related Work')).toContain('Related Work Checklist');
    expect(getSectionGuide('RELATED_WORK')).toContain('Related Work Checklist');
    expect(getSectionGuide('related work')).toContain('Related Work Checklist');
  });

  it('returns a generic checklist for unknown sections', () => {
    const guide = getSectionGuide('acknowledgments');
    expect(guide).toContain('Academic Writing Checklist');
    expect(guide).toContain(SECTION_GUIDE_SECTIONS.join(', '));
  });

  it('includes actionable constraints for the abstract', () => {
    const guide = getSectionGuide('abstract');
    expect(guide).toContain('150–250 words');
    expect(guide).toContain('No citations');
  });

  it('includes contribution guidance for the introduction', () => {
    const guide = getSectionGuide('introduction');
    expect(guide).toContain('Contributions');
    expect(guide).toContain('numbered list');
  });

  // --- Round 302: align SectionGuide with the WritingPipeline stages ---

  it('covers every pipeline stage so section_guide never falls through to default', () => {
    // Every gated pipeline stage must have a dedicated guide. The first stage
    // (outline) and the last stage (polish) are the ones most likely to be
    // missed, so this guards the bug fixed in round 302.
    for (const stage of STAGE_ORDER) {
      const guide = getSectionGuide(stage);
      expect(guide, `stage "${stage}" should have a dedicated guide`).not.toContain(
        'Academic Writing Checklist',
      );
      expect(guide, `stage "${stage}" should have a heading`).toContain('##');
      expect(guide, `stage "${stage}" should look like a checklist`).toContain('Checklist');
    }
  });

  it('returns an outline guide with research question and contributions', () => {
    const guide = getSectionGuide('outline');
    expect(guide).toContain('Outline Checklist');
    expect(guide).toContain('Research question');
    expect(guide).toContain('Contributions');
    expect(guide).toContain('Section overview');
  });

  it('returns a polish guide with AI-Tell scan and disclosure', () => {
    const guide = getSectionGuide('polish');
    expect(guide).toContain('Polish Checklist');
    expect(guide).toContain('AI-Tell');
    expect(guide).toContain('AI disclosure');
    expect(guide).toContain('citation');
  });
});
