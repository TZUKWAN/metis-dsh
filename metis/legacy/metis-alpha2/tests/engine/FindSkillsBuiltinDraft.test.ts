import { describe, expect, it } from 'vitest';
import { PersonalizationDefinitionSchema } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { buildFindSkillsSeed } from '../../engine/personalization/FindSkillsBuiltinDraft.js';

describe('find-skills builtin meta skill seed（刘总 2026-09 预装）', () => {
  it('provides a strict, enabled builtin skill with the protected builtin namespace', () => {
    const seed = buildFindSkillsSeed();
    expect(seed).toHaveLength(1);
    const skill = seed[0]!;
    expect(PersonalizationDefinitionSchema.safeParse(skill).success).toBe(true);
    expect(skill).toMatchObject({
      id: 'builtin:skills/find-skills',
      kind: 'skill',
      enabled: true,
      sourceMode: 'markdown',
    });
    expect(skill.provenance.origin).toBe('builtin');
    expect(skill.id.startsWith('builtin:')).toBe(true);
  });

  it('documents only real METIS install channels and honest capability boundaries', () => {
    const skill = buildFindSkillsSeed()[0]!;
    if (skill.kind !== 'skill') throw new Error('expected a skill definition');
    // 用途注明：搜索并安装技能的元技能。
    expect(skill.description).toContain('元技能');
    // 只指向 METIS 真实通道：SkillsMP 市场、SkillHub 网站入口、按网址受控安装。
    expect(skill.markdown).toContain('SkillsMP');
    expect(skill.markdown).toContain('SkillHub');
    expect(skill.markdown).toContain('按网址安装');
    // 如实呈现 SkillHub 无公开搜索 API 的边界，不伪造安装能力。
    expect(skill.markdown).toContain('暂无公开搜索 API');
    expect(skill.markdown).not.toContain('npx skills');
  });

  it('returns independent copies so callers cannot mutate future seeds', () => {
    const first = buildFindSkillsSeed()[0]!;
    if (first.kind !== 'skill') throw new Error('expected a skill definition');
    first.tags.push('mutated');
    const second = buildFindSkillsSeed()[0]!;
    expect(second.tags).not.toContain('mutated');
  });
});
