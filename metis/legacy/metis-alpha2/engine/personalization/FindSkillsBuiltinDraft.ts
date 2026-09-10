import { PersonalizationDefinitionSchema } from '../runtime/PersonalizationRuntimeContract.js';
import type { PersonalizationDefinition } from '../runtime/PersonalizationRuntimeContract.js';

const DRAFT_TIME = 1_900_030_000_000;

/**
 * find-skills 元技能（刘总 2026-09 要求预装）。
 *
 * 用途：当用户问「有没有做 X 的技能」「帮我找一个 X 技能」时，引导模型
 * 先在 METIS 场景中心 → 技能 页检索并安装现成技能，而不是从零现编。
 * 内容参考开放技能生态的 find-skills（skills.sh/vercel-labs）并改写为
 * METIS 真实可用的安装通道（SkillsMP 市场搜索、SkillHub 网站、按网址安装），
 * 不虚构任何 METIS 不存在的安装能力。
 */
const FIND_SKILLS_MARKDOWN = [
  '# find-skills：搜索并安装技能',
  '',
  '## 用途',
  '',
  '帮助用户从开放技能生态发现、评估并安装现成技能，避免重复造轮子。',
  '',
  '## 何时使用',
  '',
  '- 用户问「怎么做 X」，而 X 是可能已有现成技能的常见任务；',
  '- 用户直接说「找一个 X 技能」「有没有 X 技能」；',
  '- 用户希望扩展 METIS 在某领域（设计、测试、数据分析、部署等）的能力。',
  '',
  '## 检索与安装通道（METIS 真实可用）',
  '',
  '1. 场景中心 → 技能 → 「搜索并安装在线技能」：默认 SkillsMP 市场源，按关键词搜索，',
  '   预览 SKILL.md 后一键「验证并安装」（走受控 skill_url 安装，来源记录不可伪造）。',
  '2. SkillHub（https://www.skillhub.cn/）：该站暂无公开搜索 API，场景中心提供',
  '   「打开 SkillHub 网站」入口；在网站找到技能后复制其 GitHub 仓库地址，',
  '   回到技能页用「按网址安装」完成受控安装。',
  '3. 已知技能包地址时：技能页「安装技能」区支持 ZIP 包、本地文件夹与 URL / GitHub 地址安装。',
  '',
  '## 判断规则',
  '',
  '1. IF 用户需求可能已有现成技能 THEN 先建议检索市场/SkillHub，不要直接手写新技能。',
  '2. IF 找到候选技能 THEN 先展示其 SKILL.md 要点（用途、激活条件、限制）让用户确认，再安装。',
  '3. IF 安装来源无法验证（无公开 API、需登录）THEN 如实说明能力边界，给出网站入口与按网址安装路径，DO NOT 伪造搜索结果或安装状态。',
  '4. IF 已安装技能可满足需求 THEN 引导在场景工作流步骤中绑定该技能（入库 ≠ 自动注入上下文）。',
  '5. DO NOT 修改或删除内置技能；需要定制时先创建可编辑副本。',
].join('\n');

/** Returns the always-on find-skills builtin skill definition (no tool gating). */
export function buildFindSkillsSeed(): PersonalizationDefinition[] {
  const skill = {
    contractVersion: 1 as const,
    id: 'builtin:skills/find-skills',
    kind: 'skill' as const,
    name: 'find-skills（搜索并安装技能）',
    description: '元技能：当任务可能已有现成技能时，引导通过 METIS 技能市场（SkillsMP）、SkillHub 网站或按网址受控安装，而不是从零现编。',
    enabled: true,
    tags: ['meta', 'skills', 'marketplace'],
    revision: 1,
    provenance: {
      origin: 'builtin' as const,
      author: 'Metis',
      version: '1.0.0',
      license: 'Apache-2.0',
      sourceUrl: 'https://www.skills.sh/vercel-labs/skills/find-skills',
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: DRAFT_TIME,
      updatedAt: DRAFT_TIME,
    },
    sourceMode: 'markdown' as const,
    markdown: FIND_SKILLS_MARKDOWN,
    systemPrompt: FIND_SKILLS_MARKDOWN,
    toolIds: [],
    mcpIds: [],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
  return [PersonalizationDefinitionSchema.parse(skill)];
}
