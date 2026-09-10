/**
 * Skill reachability regression test.
 *
 * Guards against the class of bug found in round 316/317: a tool wired into a
 * skill's allowedTools must (a) be a real registered ToolSpec and (b) actually
 * appear in the intended skill (not a similarly-named sibling skill).
 *
 * This test runs in the normal vitest suite (not just an e2e script) so CI
 * catches skill-wiring regressions before merge.
 *
 * Round 318.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SKILLS } from '../../engine/skills/SkillRegistry.js';
import { ACADEMIC_TOOL_SPECS } from '../../engine/tools/builtin/academic-tools.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Build the complete set of registered tool names by scanning every builtin
// source file (academic + file + search + shell + research + evidence + tools
// + plugin). This is the source of truth for "is this a real tool?".
function buildAllRegisteredToolNames(): Set<string> {
  const names = new Set<string>();
  const builtinDir = path.resolve('engine/tools/builtin');
  if (fs.existsSync(builtinDir)) {
    for (const f of fs.readdirSync(builtinDir)) {
      if (!f.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(builtinDir, f), 'utf-8');
      for (const m of content.matchAll(/name:\s*'([a-z_]+)'/g)) {
        names.add(m[1]!);
      }
    }
  }
  return names;
}

const ALL_REGISTERED = buildAllRegisteredToolNames();
const SKILL_MAP = new Map(DEFAULT_SKILLS.map((s) => [s.id, s]));

describe('Skill reachability (round 318 regression guard)', () => {
  it('every skill allowedTools entry references a real registered tool', () => {
    const ghosts: Array<{ skill: string; tool: string }> = [];
    for (const skill of DEFAULT_SKILLS) {
      for (const tool of skill.allowedTools) {
        if (!ALL_REGISTERED.has(tool)) {
          ghosts.push({ skill: skill.id, tool });
        }
      }
    }
    expect(ghosts, `phantom allowedTools (registered nowhere):\n${ghosts.map((g) => `  ${g.skill}: ${g.tool}`).join('\n')}`).toEqual([]);
  });

  it('round-316 wired tools are reachable from their intended skills', () => {
    const expectations: Array<{ tool: string; skills: string[] }> = [
      { tool: 'import_by_arxiv', skills: ['literature-review', 'systematic-review'] },
      { tool: 'import_by_doi', skills: ['literature-review', 'systematic-review'] },
      { tool: 'recommend_papers', skills: ['literature-review', 'systematic-review'] },
      { tool: 'retraction_watch_update', skills: ['claim-audit'] },
      { tool: 'retraction_watch_lookup', skills: ['claim-audit'] },
      { tool: 'retraction_watch_stats', skills: ['claim-audit'] },
      { tool: 'journal_integrity_update', skills: ['claim-audit'] },
      { tool: 'journal_integrity_lookup', skills: ['claim-audit'] },
      { tool: 'journal_integrity_stats', skills: ['claim-audit'] },
      { tool: 'section_audit', skills: ['claim-audit', 'paper-writing'] },
      { tool: 'project_meta_update', skills: ['systematic-review'] },
      { tool: 'claim_to_findings', skills: ['claim-audit'] },
      { tool: 'figure_reference_check', skills: ['claim-audit'] },
    ];

    for (const { tool, skills } of expectations) {
      for (const skillId of skills) {
        const skill = SKILL_MAP.get(skillId);
        expect(skill, `skill "${skillId}" must exist`).toBeDefined();
        expect(
          skill!.allowedTools.includes(tool),
          `tool "${tool}" must be in skill "${skillId}" allowedTools`,
        ).toBe(true);
      }
    }
  });

  it('round-316 wired tools are NOT inappropriately absent from claim-audit', () => {
    // The round-317 bug: tools landed in citation-check instead of claim-audit.
    // Guard that claim-audit specifically has the integrity tools.
    const claimAudit = SKILL_MAP.get('claim-audit');
    expect(claimAudit).toBeDefined();
    const must = [
      'retraction_watch_update', 'retraction_watch_lookup', 'retraction_watch_stats',
      'journal_integrity_update', 'journal_integrity_lookup', 'journal_integrity_stats',
      'section_audit', 'claim_to_findings', 'figure_reference_check',
    ];
    for (const t of must) {
      expect(claimAudit!.allowedTools, `claim-audit must include ${t}`).toContain(t);
    }
  });

  it('earlier-round tools have no regression (still wired)', () => {
    const checks: Array<[string, string]> = [
      ['literature-review', 'literature_triage'],
      ['literature-review', 'research_state'],
      ['literature-review', 'research_summary'],
      ['systematic-review', 'findings_add'],
      ['systematic-review', 'findings_export'],
      ['systematic-review', 'experiment_to_findings'],
      ['paper-review', 'review_save'],
      ['paper-review', 'review_list'],
      ['paper-writing', 'section_guide'],
    ];
    for (const [skillId, tool] of checks) {
      const skill = SKILL_MAP.get(skillId);
      expect(skill, `skill ${skillId} exists`).toBeDefined();
      expect(skill!.allowedTools, `${skillId} must still include ${tool}`).toContain(tool);
    }
  });

  it('each round-316 wired tool is a real registered spec', () => {
    const wired = [
      'import_by_arxiv', 'import_by_doi', 'recommend_papers',
      'retraction_watch_update', 'retraction_watch_lookup', 'retraction_watch_stats',
      'journal_integrity_update', 'journal_integrity_lookup', 'journal_integrity_stats',
      'section_audit', 'project_meta_update',
    ];
    for (const t of wired) {
      expect(ALL_REGISTERED.has(t), `${t} must be a registered tool`).toBe(true);
    }
  });

  it('allowedTools distinct count reflects the active tool catalog', () => {
    const distinct = new Set<string>();
    for (const s of DEFAULT_SKILLS) for (const t of s.allowedTools) distinct.add(t);
    expect(distinct.size).toBeGreaterThanOrEqual(75);
  });

  it('academic tool specs are all uniquely named', () => {
    const names = ACADEMIC_TOOL_SPECS.map((s) => s.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate academic tool names: ${dupes.join(', ')}`).toEqual([]);
  });

  it('claim-audit and citation-check are distinct skills (guard the round-317 confusion)', () => {
    // Round 317 bug: an Edit matched citation-check instead of claim-audit.
    // Ensure both exist as separate skills so future edits can't silently swap.
    expect(SKILL_MAP.has('claim-audit')).toBe(true);
    expect(SKILL_MAP.has('citation-check')).toBe(true);
    expect(SKILL_MAP.get('claim-audit')).not.toBe(SKILL_MAP.get('citation-check'));
  });
});
