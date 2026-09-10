import { describe, expect, it } from 'vitest';
import {
  OutlineDocumentSchema,
  getPptThemeProfile,
  outlineContractPrompt,
} from '../../engine/pptx/ZoneOutlineContract.js';
import {
  auditZonePages,
  renderZoneOutline,
  ZONE_GRID,
} from '../../engine/pptx/ZoneLayoutEngine.js';

const OUTLINE = {
  title: '数字劳动研究进展汇报',
  speaker: '张三',
  chapters: [
    {
      name: '研究背景与问题提出',
      pages: [
        {
          title: '研究背景',
          zones: [
            { type: 'lead', text: '平台经济的扩张使 **数字劳动** 成为劳动社会学的核心议题，本研究系统梳理近五年的经验研究。' },
            {
              type: 'cards',
              cards: [
                {
                  head: '理论脉络',
                  items: [
                    { lead: '劳动过程', text: '从劳动过程理论出发，关注资本对劳动的控制与劳动者的主体性回应，构成研究的经典起点。' },
                    { lead: '生产政治', text: '车间政体与工厂 regime 的分析传统为平台用工研究提供了政治经济学视角。' },
                  ],
                },
                {
                  head: '经验现象',
                  items: [
                    { lead: '算法管理', text: '派单、评分与奖惩机制重塑了劳动过程的可见性与可计量性。' },
                  ],
                },
              ],
            },
          ],
        },
        {
          title: '研究问题',
          zones: [
            { type: 'lead', text: '基于上述背景，本研究将 **平台数字劳动** 的控制与协商机制作为核心问题，尝试在劳动过程理论传统与中国经验之间建立双向对话。' },
            { type: 'flow_chain', items: [
              { label: '现象识别', text: '梳理外卖骑手、网约车司机与内容创作者三类劳动的形态差异，界定数字劳动的边界与构成。' },
              { label: '机制分析', text: '拆解算法派单、评分奖惩与社交包装背后的控制逻辑，以及劳动者的协商策略。' },
              { label: '理论对话', text: '回到劳动过程理论与生产政治传统，检验既有概念在中国平台场景中的解释力与边界。' },
            ] },
          ],
        },
      ],
    },
    {
      name: '研究设计',
      pages: [
        {
          title: '推进计划',
          zones: [
            { type: 'lead', text: '本研究按 **三个月滚动推进**：先立框架、再取数据、后成文，每阶段设置可验收的中间产出，确保进度可控。' },
            { type: 'timeline', phases: [
              { month: '7月', theme: '文献与框架', tasks: ['完成文献综述初稿', '确定分析框架'] },
              { month: '8月', theme: '田野与数据', tasks: ['完成深度访谈', '平台数据采集'] },
              { month: '9月', theme: '写作与修改', tasks: ['形成完整初稿'] },
            ] },
            { type: 'chips', label: '方法组合', items: ['深度访谈', '参与式观察', '内容分析'], text: '三种方法互为补充，覆盖线上与线下劳动现场。' },
          ],
        },
        {
          title: '亮点清单',
          zones: [
            { type: 'badge_grid', cols: 3, items: [
              { title: '多平台比较', text: '覆盖外卖、网约车与内容创作三类平台劳动场景，增强结论外推能力。' },
              { title: '过程追踪', text: '对劳动者加入、日常运营与退出全流程进行追踪式访谈。' },
              { title: '理论对话', text: '与劳动过程理论及平台劳动研究进行系统对话。' },
              { title: '政策关联', text: '结合新就业形态劳动者权益保障政策，讨论研究的现实意义。' }
            ] },
          ],
        },
      ],
    },
  ],
  closing: { line1: '以上汇报，敬请批评指正', line2: '汇报人：张三　2026年9月' },
};

describe('Zone 版式引擎（融入 wut-ppt 方法论）', () => {
  it('契约通过且渲染产出封面/目录/章节/正文/封底完整页面', () => {
    const outline = OutlineDocumentSchema.parse(OUTLINE);
    const rendered = renderZoneOutline({ outline, themeId: 'academic-blue' });
    expect(rendered.ok).toBe(true);
    // 2 章：封面 + 目录 + 2 章节页 + 4 正文页 + 封底 = 9 页
    expect(rendered.document?.pages.length).toBe(2 + 1 + 2 + 4);
    expect(rendered.document?.pages[0]?.pageType).toBe('cover');
    expect(rendered.document?.pages[2]?.pageType).toBe('section');
  });

  it('正文页满足高密度：每要点独立形状、页面文本量充足', () => {
    const rendered = renderZoneOutline({ outline: OUTLINE, themeId: 'academic-blue' });
    const content = rendered.document!.pages.filter((page) => page.pageType === 'content');
    for (const page of content) {
      const textChars = page.elements.reduce((sum, element) => sum + (typeof element.props.text === 'string' ? element.props.text.length : 0), 0);
      expect(textChars).toBeGreaterThanOrEqual(120);
      // 每个要点独立形状：卡片/徽章数量与源 zone 一致
      expect(page.elements.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('全部元素落在整数网格内且不越界', () => {
    const rendered = renderZoneOutline({ outline: OUTLINE, themeId: 'academic-blue' });
    for (const page of rendered.document!.pages) {
      for (const element of page.elements) {
        expect(Number.isInteger(element.x)).toBe(true);
        expect(Number.isInteger(element.y)).toBe(true);
        expect(Number.isInteger(element.width)).toBe(true);
        expect(Number.isInteger(element.height)).toBe(true);
        expect(element.x).toBeGreaterThanOrEqual(0);
        expect(element.y).toBeGreaterThanOrEqual(0);
        expect(element.x + element.width).toBeLessThanOrEqual(ZONE_GRID.width);
        expect(element.y + element.height).toBeLessThanOrEqual(ZONE_GRID.height);
      }
    }
  });

  it('机器自检通过（字号下限/密度/无占位符）', () => {
    const rendered = renderZoneOutline({ outline: OUTLINE, themeId: 'academic-blue' });
    const audit = auditZonePages(rendered.document!.pages);
    expect(audit.passed).toBe(true);
    expect(audit.pages.every((page) => page.minFontSize >= 12 || page.minFontSize === 0)).toBe(true);
  });

  it('内容过密的页面被等比压缩在网格内并给出密度问题', () => {
    const dense = JSON.parse(JSON.stringify(OUTLINE)) as typeof OUTLINE;
    const page = dense.chapters[0]!.pages[0]!;
    const longText = '很长的解释句'.repeat(60);
    (page.zones[1] as { cards: Array<{ head: string; items: Array<{ lead?: string; text: string }> }> }).cards[0]!.items.push(
      { lead: '超长要点', text: longText },
      { lead: '超长要点', text: longText },
    );
    const rendered = renderZoneOutline({ outline: dense, themeId: 'academic-blue' });
    for (const p of rendered.document!.pages) {
      for (const element of p.elements) {
        expect(element.y + element.height).toBeLessThanOrEqual(ZONE_GRID.height);
      }
    }
  });

  it('武理工主题预设可用且与通用主题隔离', () => {
    expect(getPptThemeProfile('wut').colors.primary).toBe('#00469A');
    expect(getPptThemeProfile('academic-blue').colors.primary).toBe('#1F4E79');
    const rendered = renderZoneOutline({ outline: OUTLINE, themeId: 'wut' });
    const titleElement = rendered.document!.pages[2]!.elements.find((element) => element.type === 'text');
    expect(titleElement).toBeDefined();
  });

  it('契约提示词包含 zone 目录与密度纪律', () => {
    const promptText = outlineContractPrompt(getPptThemeProfile('academic-blue'));
    expect(promptText).toContain('flow_chain');
    expect(promptText).toContain('禁止只给关键词');
  });
});
