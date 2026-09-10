import { z } from 'zod';

/**
 * Zone 版式大纲契约（2026-09-01 融入 wut-ppt 方法论，刘总批准方案）：
 * 内容与版式分离——模型只产出大纲 JSON（章节/页/zone），版式质量由
 * ZoneLayoutEngine 的确定性渲染与 ZoneValidator 的机器自检保证。
 *
 * 网格与单位：PptElement 32×18 整数网格（与 OutcomeRuntimeContract 一致）。
 */

// ─── 主题配置（ThemeProfile） ──────────────────────────────────

export const PptThemeProfileSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  colors: z.strictObject({
    primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    emphasis: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    text: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    textMuted: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    cardBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    tagBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    line: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    primaryDeep: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    primaryLight: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }),
  font: z.strictObject({
    family: z.string().min(1).max(64),
  }),
  fontSizes: z.strictObject({
    pageTitle: z.number().min(14).max(40),
    band: z.number().min(11).max(24),
    lead: z.number().min(11).max(24),
    cardHead: z.number().min(11).max(24),
    body: z.number().min(12),
    conclusion: z.number().min(11).max(24),
  }),
  density: z.strictObject({
    pageCharsMin: z.number().int().min(100).default(300),
    pageCharsMax: z.number().int().min(200).max(1200).default(600),
    pointTextMin: z.number().int().min(10).max(60).default(30),
    pointTextMax: z.number().int().min(20).max(120).default(65),
  }),
  brand: z.strictObject({
    footerBar: z.boolean(),
    footerText: z.string().max(64).default(''),
  }).default({ footerBar: false, footerText: '' }),
});
export type PptThemeProfile = z.infer<typeof PptThemeProfileSchema>;

/** 内置主题预设。武理工版保留为可选预设（通用版本使用其余主题）。 */
export const PPT_THEME_PROFILES: readonly PptThemeProfile[] = [
  {
    id: 'academic-blue',
    name: '学术蓝（通用）',
    colors: {
      primary: '#1F4E79', accent: '#D9A521', emphasis: '#C0392B',
      text: '#262626', textMuted: '#595959', cardBg: '#F4F7FB', tagBg: '#EAF1F9',
      line: '#D9D9D9', primaryDeep: '#16395A', primaryLight: '#3D6FB0',
    },
    font: { family: '微软雅黑' },
    fontSizes: { pageTitle: 24, band: 14, lead: 13, cardHead: 13, body: 12, conclusion: 12.5 },
    density: { pageCharsMin: 300, pageCharsMax: 600, pointTextMin: 30, pointTextMax: 65 },
    brand: { footerBar: true, footerText: '' },
  },
  {
    id: 'gov-red',
    name: '政务红（通用）',
    colors: {
      primary: '#A61B29', accent: '#D9A521', emphasis: '#1F4E79',
      text: '#262626', textMuted: '#595959', cardBg: '#FBF5F4', tagBg: '#F6E8E7',
      line: '#D9D9D9', primaryDeep: '#7C1420', primaryLight: '#C4564F',
    },
    font: { family: '微软雅黑' },
    fontSizes: { pageTitle: 24, band: 14, lead: 13, cardHead: 13, body: 12, conclusion: 12.5 },
    density: { pageCharsMin: 300, pageCharsMax: 600, pointTextMin: 30, pointTextMax: 65 },
    brand: { footerBar: true, footerText: '' },
  },
  {
    id: 'tech-slate',
    name: '科技深空（通用）',
    colors: {
      primary: '#0F6FC6', accent: '#00B7C3', emphasis: '#F5A623',
      text: '#262626', textMuted: '#5A6572', cardBg: '#F1F7FC', tagBg: '#E1EFFA',
      line: '#D5DEE7', primaryDeep: '#0A4E8C', primaryLight: '#3D9BE9',
    },
    font: { family: '微软雅黑' },
    fontSizes: { pageTitle: 24, band: 14, lead: 13, cardHead: 13, body: 12, conclusion: 12.5 },
    density: { pageCharsMin: 300, pageCharsMax: 600, pointTextMin: 30, pointTextMax: 65 },
    brand: { footerBar: false, footerText: '' },
  },
  {
    id: 'minimal-mono',
    name: '极简黑白（通用）',
    colors: {
      primary: '#2B2B2B', accent: '#8A8A8A', emphasis: '#B03A2E',
      text: '#262626', textMuted: '#6E6E6E', cardBg: '#F7F7F7', tagBg: '#ECECEC',
      line: '#D9D9D9', primaryDeep: '#111111', primaryLight: '#5E5E5E',
    },
    font: { family: '微软雅黑' },
    fontSizes: { pageTitle: 24, band: 14, lead: 13, cardHead: 13, body: 12, conclusion: 12.5 },
    density: { pageCharsMin: 300, pageCharsMax: 600, pointTextMin: 30, pointTextMax: 65 },
    brand: { footerBar: false, footerText: '' },
  },
  {
    id: 'wut',
    name: '武汉理工（校徽蓝三件套）',
    colors: {
      primary: '#00469A', accent: '#FBC540', emphasis: '#C00000',
      text: '#262626', textMuted: '#595959', cardBg: '#F4F7FB', tagBg: '#EAF1F9',
      line: '#D9D9D9', primaryDeep: '#003371', primaryLight: '#3D6FB0',
    },
    font: { family: '微软雅黑' },
    fontSizes: { pageTitle: 24, band: 14, lead: 13, cardHead: 13, body: 12, conclusion: 12.5 },
    density: { pageCharsMin: 300, pageCharsMax: 600, pointTextMin: 30, pointTextMax: 65 },
    brand: { footerBar: true, footerText: '' },
  },
];

export function getPptThemeProfile(id: string | undefined): PptThemeProfile {
  return PPT_THEME_PROFILES.find((theme) => theme.id === id) ?? PPT_THEME_PROFILES[0]!;
}

// ─── Zone 大纲契约 ─────────────────────────────────────────────

/** 文本标记：**文字**→主色加粗强调；[[文字]]→强调色加粗（仅结论/关键数字）。渲染引擎解析。 */
export const MARK_BOLD = /\*\*([^*]+)\*\*/gu;
export const MARK_EMPHASIS = /\[\[([^\]]+)\]\]/gu;

const RichTextSchema = z.string().min(1).max(600);

const PointSchema = z.strictObject({
  lead: z.string().min(2).max(40).describe('四字左右引导语'),
  text: RichTextSchema.describe('完整解释句'),
});
const PointInputSchema = z.union([PointSchema, RichTextSchema.transform((text) => ({ lead: '', text }))]);

export const ZoneSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('lead'),
    text: RichTextSchema.describe('页首导语段：一段完整判断，蓝竖线+整段'),
  }),
  z.strictObject({
    type: z.literal('cards'),
    cards: z.array(z.strictObject({
      head: z.string().min(2).max(30),
      items: z.array(PointInputSchema).min(1).max(4),
    })).min(1).max(4).describe('2-4 列多维并列，每列一 head；每个要点独立卡（引导语+完整解释句）'),
  }),
  z.strictObject({
    type: z.literal('flow_chain'),
    items: z.array(z.strictObject({
      label: z.string().min(2).max(24),
      text: z.string().max(300).optional(),
    })).min(2).max(5).describe('CHEVRON 箭头递进链；带 text 时下方对齐详情卡'),
  }),
  z.strictObject({
    type: z.literal('timeline'),
    phases: z.array(z.strictObject({
      month: z.string().min(1).max(12),
      theme: z.string().min(2).max(30),
      tasks: z.array(z.string().min(4).max(80)).min(1).max(3),
    })).min(2).max(4).describe('时间轴分阶段安排'),
  }),
  z.strictObject({
    type: z.literal('badge_grid'),
    cols: z.number().int().min(2).max(4).default(3),
    items: z.array(z.strictObject({
      title: z.string().min(2).max(24),
      text: RichTextSchema,
    })).min(2).max(9).describe('徽章网格：序号圆徽+标题+解释的亮点清单'),
  }),
  z.strictObject({
    type: z.literal('chips'),
    label: z.string().min(2).max(30),
    items: z.array(z.string().min(2).max(16)).min(2).max(8),
    text: z.string().max(400).optional().describe('可选补充说明段'),
  }),
]);
export type Zone = z.infer<typeof ZoneSchema>;

export const OutlinePageSchema = z.strictObject({
  title: z.string().min(2).max(40),
  zones: z.array(ZoneSchema).min(1).max(4),
});
export type OutlinePage = z.infer<typeof OutlinePageSchema>;

export const OutlineChapterSchema = z.strictObject({
  name: z.string().min(2).max(40),
  pages: z.array(OutlinePageSchema).min(1).max(12),
});
export type OutlineChapter = z.infer<typeof OutlineChapterSchema>;

export const OutlineDocumentSchema = z.strictObject({
  title: z.string().min(2).max(60),
  speaker: z.string().max(40).default(''),
  chapters: z.array(OutlineChapterSchema).min(1).max(5),
  closing: z.strictObject({
    line1: z.string().max(60).default('以上汇报，敬请批评指正'),
    line2: z.string().max(60).default(''),
  }).default({ line1: '以上汇报，敬请批评指正', line2: '' }),
});
export type OutlineDocument = z.infer<typeof OutlineDocumentSchema>;

/** zone 契约的提示词描述（注入生成 prompt；模型按此产出大纲 JSON）。 */
export function outlineContractPrompt(theme: PptThemeProfile): string {
  const zoneDocs = [
    '{"type":"lead","text":"页首导语段：一段完整判断（60-120字），含 **主色加粗** 关键概念"}',
    '{"type":"cards","cards":[{"head":"维度名(2-4列)","items":[{"lead":"四字引导语","text":"完整解释句30-65字，含 **加粗强调**"}]}]}',
    '{"type":"flow_chain","items":[{"label":"阶段名(≤12字)","text":"可选详情(≤60字)"}]}',
    '{"type":"timeline","phases":[{"month":"7月","theme":"阶段主题(≤15字)","tasks":["任务句1","任务句2"]}]}',
    '{"type":"badge_grid","cols":3,"items":[{"title":"标题(≤12字)","text":"解释句30-60字"}]}',
    '{"type":"chips","label":"标签组名","items":["标签1","标签2"],"text":"可选补充段"}',
  ];
  return [
    '## 大纲 JSON 契约（zone 版式体系）',
    '顶层：{"title":"封面主标题","speaker":"汇报人","chapters":[{"name":"章节名","pages":[{"title":"页面标题","zones":[zone 列表]}]}],"closing":{"line1":"以上汇报，敬请批评指正","line2":"汇报人：xxx"}}',
    '封面/目录/章节页/封底由引擎自动生成，只写正文页 zones。章节 1-5 个，每章 1-6 页。',
    '每页 zones 从上到下堆叠，1-4 个；引擎自动填满整页。zone 六种：',
    ...zoneDocs.map((doc) => `  ${doc}`),
    '选型配方：现状背景=lead+cards；问题诊断=cards(2-3列)；措施并列=cards 或 badge_grid；',
    '演进/阶段=flow_chain；推进计划=timeline；映射关系可用 cards 多列；清单亮点=badge_grid。',
    `要点范式：{"lead":"四字引导语","text":"完整解释句${theme.density.pointTextMin}-${theme.density.pointTextMax}字"}——禁止只给关键词。`,
    `每页正文 ${theme.density.pageCharsMin}-${theme.density.pageCharsMax} 字，全文覆盖源材料要点。`,
    `强调标记：**文字**=主色加粗（概念）；[[文字]]=强调色加粗（仅关键数字/结论）。`,
  ].join('\n');
}
