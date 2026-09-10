import { describe, it, expect } from 'vitest';
import { SkillRegistry, registerDefaultSkills, DEFAULT_SKILLS } from './SkillRegistry.js';
import { ACADEMIC_TOOL_SPECS } from '../tools/builtin/academic-tools.js';
import { getFileToolSpecs } from '../tools/builtin/file-tools.js';
import { getSearchToolSpecs } from '../tools/builtin/search-tools.js';
import { getShellToolSpecs } from '../tools/builtin/shell-tools.js';
import { getResearchToolSpecs } from '../tools/builtin/research-tools.js';
import { PLUGIN_TOOLS } from '../tools/builtin/PluginMarketplace.js';
import { getEvidenceToolSpecs } from '../tools/builtin/evidence-tools.js';
import { WRITING_TOOL_SPECS } from '../tools/builtin/writing-tools.js';
import { JOURNAL_CATALOG_TOOL_SPECS } from '../tools/builtin/journal-catalog-tools.js';
import { STATISTICS_TOOL_SPECS } from '../tools/builtin/statistics-tools.js';
import { NOTES_TOOL_SPECS } from '../tools/builtin/notes-tools.js';

describe('SkillRegistry', () => {
  it('registers default skills without duplicates', () => {
    const registry = new SkillRegistry();
    registerDefaultSkills(registry);
    const ids = registry.list().map((s) => s.id);
    expect(ids).toContain('literature-review');
    expect(ids).toContain('paper-reading');
    expect(ids).toContain('paper-review');
    expect(ids).toContain('socratic-plan');
    expect(ids).toContain('citation-check');
    expect(ids).toContain('systematic-review');
    expect(ids).toContain('writing-quality');
    expect(ids).toContain('paper-writing');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('throws when registering a duplicate skill', () => {
    const registry = new SkillRegistry();
    const skill = DEFAULT_SKILLS.find((s) => s.id === 'paper-reading')!;
    registry.register(skill);
    expect(() => registry.register(skill)).toThrow(/already registered/);
  });

  it('searches skills by tag and description', () => {
    const registry = new SkillRegistry();
    registerDefaultSkills(registry);
    const results = registry.search('peer-review');
    expect(results.some((s) => s.id === 'paper-review')).toBe(true);
  });

  it('builds a prompt for a skill', () => {
    const registry = new SkillRegistry();
    registerDefaultSkills(registry);
    const prompt = registry.buildPrompt('paper-review', 'Review this paper.', 'Paper: Attention Is All You Need');
    expect(prompt).toContain('Paper Review');
    expect(prompt).toContain('Attention Is All You Need');
    expect(prompt).toContain('Overall Recommendation');
  });

  it('only allows tools that are registered builtins', () => {
    const allSpecs = [
      ...ACADEMIC_TOOL_SPECS,
      ...getFileToolSpecs(),
      ...getSearchToolSpecs(),
      ...getShellToolSpecs(),
      ...getResearchToolSpecs(),
      ...PLUGIN_TOOLS,
      ...getEvidenceToolSpecs(),
      // 任务7(2026-09-05):与注册面(buildRuntimeRegistry)对齐——写作/期刊目录等工具同属内置。
      ...WRITING_TOOL_SPECS,
      ...JOURNAL_CATALOG_TOOL_SPECS,
      ...STATISTICS_TOOL_SPECS,
      ...NOTES_TOOL_SPECS,
    ];
    const registeredNames = new Set(allSpecs.map((spec) => spec.name));
    for (const skill of DEFAULT_SKILLS) {
      if (!skill.allowedTools) continue;
      for (const toolName of skill.allowedTools) {
        expect(registeredNames.has(toolName)).toBe(true);
      }
    }
  });

  it('does not list duplicate tools in any skill', () => {
    for (const skill of DEFAULT_SKILLS) {
      if (!skill.allowedTools) continue;
      expect(new Set(skill.allowedTools).size).toBe(skill.allowedTools.length);
    }
  });

  it('includes local-library tooling in literature review skills', () => {
    const libraryTools = ['search_library', 'find_library_duplicates', 'delete_library_duplicates', 'library_stats', 'export_library', 'import_papers'];
    for (const skillId of ['literature-review', 'systematic-review']) {
      const skill = DEFAULT_SKILLS.find((s) => s.id === skillId);
      expect(skill).toBeDefined();
      for (const tool of libraryTools) {
        expect(skill!.allowedTools).toContain(tool);
      }
    }
  });
});
