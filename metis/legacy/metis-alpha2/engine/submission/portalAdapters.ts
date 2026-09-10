/**
 * Portal Adapters — 投稿门户平台适配器（纯领域逻辑，无 Electron 依赖，可单测）。
 *
 * 职责：
 *  - detectPlatform：基于 URL 关键字与页面文本特征确定性识别投稿平台；
 *  - buildFillPlan：把页面枚举到的表单字段与系统已知稿件事实匹配成填单计划。
 *
 * 诚实边界（不可放宽）：
 *  - 平台字段知识来自各平台公开投稿流程的通行惯例（ScholarOne 的
 *    title/abstract 分步表单、Editorial Manager 的菜单式流程、OJS 的多步
 *    wizard），不是平台官方文档保证——适配器只提供「已知字段候选 +
 *    选择器猜测」，识别不到就降级 generic，不假装识别成功；
 *  - 匹配不到事实的字段一律 needsUser = true，系统不编造值；
 *  - attestation / legal / financial / external_auth / final_submit 级别
 *    永远只进计划、value 恒空、绝不进 auto；
 *  - file 字段只绑定已冻结投稿包文件，且 input[type=file] 不可脚本赋值，
 *    上传动作永远留给人类。
 */

import {
  PORTAL_ACTION_SAFETY_LEVELS,
  type PortalActionSafetyLevel,
  type PortalFieldAction,
  type PortalFormField,
  type PortalFormFieldKind,
  type PortalManuscriptFacts,
  type PortalPackageFileRef,
  type PortalPlatform,
} from './SubmissionPortalContract.js';

// ─── 平台检测（纯函数，可解释特征） ────────────────────────────

/**
 * ScholarOne Manuscripts（原 Manuscript Central）：
 * 典型域名为 mc01./mc04.manuscriptcentral.com，或站点/页面直接出现 ScholarOne 字样。
 */
const SCHOLARONE_URL = /scholarone|manuscriptcentral|^https?:\/\/mc\d*\./iu;
const SCHOLARONE_TEXT = /scholarone|manuscript central/iu;
/** Editorial Manager：Aries Systems 统一域名 editorialmanager.com。 */
const EDITORIAL_MANAGER_URL = /editorialmanager/iu;
const EDITORIAL_MANAGER_TEXT = /editorial manager/iu;
/**
 * OJS（Open Journal Systems）：URL 特征取 OJS 标准投稿指南路径 /about/submissions
 * 或投稿向导 /submission/wizard；页面特征取页脚/标题常见的 “Open Journal Systems” 署名。
 * 不对裸 'ojs' 三个字母做 URL 匹配——误判面太大。
 */
const OJS_URL = /\/about\/submissions|\/submission\/wizard/iu;
const OJS_TEXT = /open journal systems/iu;

/**
 * 投稿平台检测：URL 正则优先（域名/路径是强信号），页面文本特征兜底；
 * 都不命中 → generic（宁可以通用策略慢处理，不误判平台）。
 */
export function detectPlatform(url: string, page?: { title?: string; text?: string }): PortalPlatform {
  const haystackText = `${page?.title ?? ''}\n${page?.text ?? ''}`.slice(0, 20_000);
  if (SCHOLARONE_URL.test(url) || SCHOLARONE_TEXT.test(haystackText)) return 'scholarone';
  if (EDITORIAL_MANAGER_URL.test(url) || EDITORIAL_MANAGER_TEXT.test(haystackText)) return 'editorial_manager';
  if (OJS_URL.test(url) || OJS_TEXT.test(haystackText)) return 'ojs';
  return 'generic';
}

// ─── 高风险特征分级（label/key 命中 → 人类专属级别） ───────────

/**
 * 按字段 label/key 文本把字段归入安全级别；返回 null 表示无高风险特征，
 * 可继续按事实匹配走 auto/review。attestation 及以上永远只进计划不执行。
 */
const HAZARD_LEVEL_PATTERNS: Array<{ safetyLevel: PortalActionSafetyLevel; pattern: RegExp; reason: string }> = [
  {
    safetyLevel: 'attestation',
    pattern: /(?:not|never)\s+(?:been\s+)?(?:submitted|published)\s+elsewhere|exclusiv\w+|originality|conflict of interest|ethics|agree|certify|confirm that|一稿多投|利益冲突|伦理/iu,
    reason: '声明类内容只有作者本人有资格确认，系统不代勾、不代写。',
  },
  {
    safetyLevel: 'legal',
    pattern: /copyright|licen[cs]e|transfer agreement|版权|许可协议|转让协议/iu,
    reason: '版权与许可协议属法律行为，必须由权利人本人签署。',
  },
  {
    safetyLevel: 'financial',
    pattern: /article processing charge|\bAPC\b|payment|publication fee|invoice|版面费|支付|发票/iu,
    reason: '涉及资金操作，系统不触碰任何支付表单。',
  },
  {
    safetyLevel: 'external_auth',
    pattern: /captcha|verification code|two[- ]factor|2fa|验证码/iu,
    reason: '验证码设计上就是「证明你是人」，禁止任何自动绕过。',
  },
];

/**
 * 字段级安全分级：checkbox/radio 只要语义像声明一律 attestation（声明复选框
 * 是最常见的 attestation 载体）；其余按 label/key 文本命中高风险特征。
 * 返回 null = 无高风险特征，可按事实匹配走 auto/review。
 */
export function classifyFieldSafetyLevel(field: Pick<PortalFormField, 'key' | 'label' | 'kind'>): PortalActionSafetyLevel | null {
  const haystack = `${field.label}\n${field.key}`.slice(0, 2_000);
  for (const hazard of HAZARD_LEVEL_PATTERNS) {
    hazard.pattern.lastIndex = 0;
    if (hazard.pattern.test(haystack)) return hazard.safetyLevel;
  }
  // 声明/协议类复选框兜底：勾选即声明，凡是「需要勾选确认」的字段默认 attestation。
  if ((field.kind === 'checkbox' || field.kind === 'radio') && /confirm|agree|certify|declar|acknowledg|确认|同意|声明/iu.test(haystack)) {
    return 'attestation';
  }
  return null;
}

/** 高风险特征命中时取固定 reason（供 buildFillPlan 写进计划项）。 */
export function hazardReason(safetyLevel: PortalActionSafetyLevel): string {
  return HAZARD_LEVEL_PATTERNS.find((hazard) => hazard.safetyLevel === safetyLevel)?.reason
    ?? '该级别属人类专属操作，系统只进计划不执行。';
}

// ─── 平台字段知识（公开投稿流程通行惯例，非官方文档保证） ──────

/** 可自动/半自动填充的事实键。 */
export type PortalFactKey = 'title' | 'abstract' | 'keywords' | 'article_type';

/** 一个平台对某类事实字段的「候选识别」知识：label 特征 + 选择器猜测。 */
export interface PortalAdapterFieldSpec {
  factKey: PortalFactKey;
  kind: PortalFormFieldKind;
  /** 字段 label/key 命中任一即视为该事实候选。 */
  labelPatterns: RegExp[];
  /** 平台通行 DOM 惯例的选择器猜测（枚举拿不到选择器时兜底）。 */
  selectorHints: string[];
  /** 匹配成功后的默认安全级别（select 类映射门户特有选项，一律 review）。 */
  safetyLevel: 'auto' | 'review';
  note: string;
}

/**
 * 各平台字段知识。来源说明：均为平台公开投稿流程的通行惯例总结
 * （ScholarOne 分步表单含 Title & Abstract 步骤；Editorial Manager 菜单式流程
 * 的 Enter Metadata 步骤；OJS 3.x 五步 wizard 的第 3 步 Enter Metadata），
 * 具体期刊实例可自定义字段名，识别不到由 generic 兜底。
 */
export const PORTAL_ADAPTER_KNOWLEDGE: Record<PortalPlatform, PortalAdapterFieldSpec[]> = {
  scholarone: [
    {
      factKey: 'title',
      kind: 'text',
      labelPatterns: [/^title\b/iu, /\btitle of (?:your )?manuscript/iu, /manuscript title/iu],
      selectorHints: ['input[name*="title" i]', '#title'],
      safetyLevel: 'auto',
      note: 'ScholarOne「Title & Abstract」步骤的标题输入框。',
    },
    {
      factKey: 'abstract',
      kind: 'textarea',
      labelPatterns: [/^abstract\b/iu, /manuscript abstract/iu],
      selectorHints: ['textarea[name*="abstract" i]', '#abstract'],
      safetyLevel: 'auto',
      note: 'ScholarOne「Title & Abstract」步骤的摘要文本域。',
    },
    {
      factKey: 'keywords',
      kind: 'text',
      labelPatterns: [/key ?words?/iu],
      selectorHints: ['input[name*="keyword" i]'],
      safetyLevel: 'auto',
      note: 'ScholarOne 关键词输入框（多半逐条添加，自动填逗号分隔串后须用户核对）。',
    },
    {
      factKey: 'article_type',
      kind: 'select',
      labelPatterns: [/article type/iu, /manuscript type/iu, /paper type/iu],
      selectorHints: ['select[name*="type" i]'],
      safetyLevel: 'review',
      note: 'ScholarOne 文章类型下拉框，选项为期刊自定义，须用户确认映射。',
    },
  ],
  editorial_manager: [
    {
      factKey: 'title',
      kind: 'text',
      labelPatterns: [/^title\b/iu, /manuscript title/iu, /full title/iu],
      selectorHints: ['input[name*="title" i]', '#title'],
      safetyLevel: 'auto',
      note: 'Editorial Manager 菜单式流程「Enter Title」步骤。',
    },
    {
      factKey: 'abstract',
      kind: 'textarea',
      labelPatterns: [/^abstract\b/iu],
      selectorHints: ['textarea[name*="abstract" i]'],
      safetyLevel: 'auto',
      note: 'Editorial Manager「Enter Abstract」步骤的摘要文本域。',
    },
    {
      factKey: 'keywords',
      kind: 'text',
      labelPatterns: [/key ?words?/iu],
      selectorHints: ['input[name*="keyword" i]'],
      safetyLevel: 'auto',
      note: 'Editorial Manager「Enter Keywords」步骤。',
    },
    {
      factKey: 'article_type',
      kind: 'select',
      labelPatterns: [/article type/iu, /manuscript type/iu, /select (?:article|manuscript) type/iu],
      selectorHints: ['select[name*="arttype" i]', 'select[name*="type" i]'],
      safetyLevel: 'review',
      note: 'Editorial Manager「Select Article Type」下拉框，选项为期刊自定义。',
    },
  ],
  ojs: [
    {
      factKey: 'title',
      kind: 'text',
      labelPatterns: [/^title\b/iu, /manuscript title/iu],
      selectorHints: ['input[name*="title" i]', '#title'],
      safetyLevel: 'auto',
      note: 'OJS 3.x 五步 wizard 第 3 步「Enter Metadata」的标题输入框。',
    },
    {
      factKey: 'abstract',
      kind: 'textarea',
      labelPatterns: [/^abstract\b/iu],
      selectorHints: ['textarea[name*="abstract" i]', '#abstract'],
      safetyLevel: 'auto',
      note: 'OJS 第 3 步「Enter Metadata」的摘要文本域（常为富文本 iframe，命中不了如实 not_found）。',
    },
    {
      factKey: 'keywords',
      kind: 'text',
      labelPatterns: [/key ?words?/iu],
      selectorHints: ['input[name*="keyword" i]'],
      safetyLevel: 'auto',
      note: 'OJS 关键词（tag 组件常见，自动填值后须用户核对）。',
    },
    {
      factKey: 'article_type',
      kind: 'select',
      labelPatterns: [/section/iu, /article type/iu],
      selectorHints: ['select[name*="sectionId" i]'],
      safetyLevel: 'review',
      note: 'OJS 第 1 步的 Section 选择（期刊栏目自定义），须用户确认。',
    },
  ],
  generic: [
    {
      factKey: 'title',
      kind: 'text',
      labelPatterns: [/^title\b/iu, /manuscript title/iu, /稿件标题|论文标题/iu],
      selectorHints: ['input[name*="title" i]'],
      safetyLevel: 'auto',
      note: '通用标签启发：标题输入框。',
    },
    {
      factKey: 'abstract',
      kind: 'textarea',
      labelPatterns: [/^abstract\b/iu, /摘要/iu],
      selectorHints: ['textarea[name*="abstract" i]'],
      safetyLevel: 'auto',
      note: '通用标签启发：摘要文本域。',
    },
    {
      factKey: 'keywords',
      kind: 'text',
      labelPatterns: [/key ?words?/iu, /关键词/iu],
      selectorHints: ['input[name*="keyword" i]'],
      safetyLevel: 'auto',
      note: '通用标签启发：关键词输入框。',
    },
    {
      factKey: 'article_type',
      kind: 'select',
      labelPatterns: [/article type/iu, /manuscript type/iu, /文章类型/iu],
      selectorHints: ['select[name*="type" i]'],
      safetyLevel: 'review',
      note: '通用标签启发：文章类型下拉框，选项为门户自定义，须用户确认。',
    },
  ],
};

/** 作者事实字段（姓名/单位/基金）——系统不预填、不编造，只放 review 级提醒位。 */
const AUTHOR_FACT_HINT = /author(?:s| information)?|affiliation|funding|作者|单位|基金/iu;

// ─── 填单计划生成 ─────────────────────────────────────────────

/** 事实键 → PortalManuscriptFacts 取值。 */
function factValue(factKey: PortalFactKey, facts: PortalManuscriptFacts): string {
  switch (factKey) {
    case 'title': return facts.title.trim();
    case 'abstract': return facts.abstract.trim();
    case 'keywords': return facts.keywords.map((keyword) => keyword.trim()).filter(Boolean).join(', ');
    case 'article_type': return facts.articleType.trim();
  }
}

/** 平台知识（+ generic 兜底）中匹配该字段的事实候选。 */
function matchFieldSpec(field: PortalFormField, platform: PortalPlatform): PortalAdapterFieldSpec | undefined {
  const haystack = `${field.label}\n${field.key}`;
  const specs = [...PORTAL_ADAPTER_KNOWLEDGE[platform], ...(platform === 'generic' ? [] : PORTAL_ADAPTER_KNOWLEDGE.generic)];
  return specs.find((spec) => {
    if (spec.kind !== field.kind && !(spec.kind === 'text' && field.kind === 'textarea') && !(spec.kind === 'textarea' && field.kind === 'text')) {
      return false;
    }
    return spec.labelPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(haystack);
    });
  });
}

/** file 字段 → 已冻结投稿包文件：按标签语义优先匹配类型，否则取主文档。 */
function matchPackageFile(field: PortalFormField, packageFiles: PortalPackageFileRef[]): PortalPackageFileRef | undefined {
  if (packageFiles.length === 0) return undefined;
  const haystack = `${field.label}\n${field.key}`;
  const TYPE_HINTS: Array<{ pattern: RegExp; types: string[] }> = [
    { pattern: /cover ?letter/iu, types: ['cover_letter'] },
    { pattern: /title page/iu, types: ['title_page'] },
    { pattern: /supplement/iu, types: ['supplementary'] },
    { pattern: /blind|anonym/iu, types: ['blinded_manuscript'] },
    { pattern: /manuscript|main (?:document|file)|正文|稿件文件/iu, types: ['main_manuscript', 'blinded_manuscript'] },
  ];
  for (const hint of TYPE_HINTS) {
    if (!hint.pattern.test(haystack)) continue;
    const hit = packageFiles.find((file) => hint.types.includes(file.type));
    if (hit) return hit;
  }
  return packageFiles.find((file) => file.type === 'main_manuscript') ?? packageFiles[0];
}

/**
 * 由字段枚举 + 系统已知事实生成填单计划（纯函数，不做任何浏览器写操作）：
 *  - 高风险特征（声明/法律/财务/验证码）→ 对应级别，value 恒空，needsUser；
 *  - 命中事实候选且事实非空 → spec 默认级别（text/textarea auto，select review）带值；
 *  - 命中事实候选但事实为空（如摘要未存）→ needsUser，不编造；
 *  - file 字段 → 绑定已冻结投稿包文件（review 级，上传永远人工）；无已冻结文件 → needsUser；
 *  - 作者事实字段 → review 级提醒位，value 恒空；
 *  - 其余未识别字段 → needsUser 占位，如实告知「未识别」。
 */
export function buildFillPlan(
  fields: PortalFormField[],
  facts: PortalManuscriptFacts,
  platform: PortalPlatform,
  options: { packageFiles?: PortalPackageFileRef[] } = {},
): PortalFieldAction[] {
  const packageFiles = options.packageFiles ?? [];
  const actions: PortalFieldAction[] = [];
  const usedFacts = new Set<PortalFactKey>();

  for (const field of fields) {
    const base = { label: field.label, selector: field.selectorHint, fieldKind: field.kind };

    // 1. 高风险特征 → 人类专属级别，value 恒空。
    const hazard = classifyFieldSafetyLevel(field);
    if (hazard) {
      actions.push({
        ...base,
        fieldKey: `field_${field.key}`,
        value: '',
        safetyLevel: hazard,
        needsUser: true,
        packageFileId: null,
        reason: hazardReason(hazard),
      });
      continue;
    }

    // 2. file 字段：只绑已冻结投稿包文件；上传动作永远人工。
    if (field.kind === 'file') {
      const bound = matchPackageFile(field, packageFiles);
      actions.push({
        ...base,
        fieldKey: `field_${field.key}`,
        value: '',
        safetyLevel: 'review',
        needsUser: !bound,
        packageFileId: bound?.id ?? null,
        reason: bound
          ? `绑定已冻结投稿包文件「${bound.filename || bound.type}」（${bound.id}）；input[type=file] 不可脚本赋值，请用户在浏览器里亲自选择该文件上传。`
          : '文件上传字段，但当前没有已冻结投稿包文件可绑定；请先冻结投稿包，再由用户亲自上传。',
      });
      continue;
    }

    // 3. 事实候选匹配。
    const spec = matchFieldSpec(field, platform);
    if (spec) {
      // 同一事实只填一次（页面常有重复字段，取首个匹配）。
      const value = usedFacts.has(spec.factKey) ? '' : factValue(spec.factKey, facts);
      if (value) {
        usedFacts.add(spec.factKey);
        actions.push({
          ...base,
          fieldKey: `field_${field.key}`,
          value,
          safetyLevel: spec.safetyLevel,
          needsUser: false,
          packageFileId: null,
          reason: `系统已知事实（${spec.factKey}）经${platform === 'generic' ? '通用标签启发' : `${platform} 平台惯例`}匹配；${spec.note}`,
        });
      } else {
        actions.push({
          ...base,
          fieldKey: `field_${field.key}`,
          value: '',
          safetyLevel: spec.safetyLevel,
          needsUser: true,
          packageFileId: null,
          reason: usedFacts.has(spec.factKey)
            ? `重复字段：事实「${spec.factKey}」已绑定到前一个匹配字段，此字段请用户核对。`
            : `识别为「${spec.factKey}」候选，但系统没有该事实的已知值，不编造，请用户填写。`,
        });
      }
      continue;
    }

    // 4. 作者事实提醒位（value 恒空）。
    if (AUTHOR_FACT_HINT.test(`${field.label}\n${field.key}`)) {
      actions.push({
        ...base,
        fieldKey: `field_${field.key}`,
        value: '',
        safetyLevel: 'review',
        needsUser: true,
        packageFileId: null,
        reason: '作者事实系统不预填、不编造；请作者本人核对填写。',
      });
      continue;
    }

    // 5. 未识别字段：如实占位。
    actions.push({
      ...base,
      fieldKey: `field_${field.key}`,
      value: '',
      safetyLevel: 'review',
      needsUser: true,
      packageFileId: null,
      reason: '未识别的表单字段，系统无已知事实可填，请用户核对。',
    });
  }

  return actions;
}

/** 供调用方校验：计划项安全级别是否都在契约枚举内（防御外部构造数据）。 */
export function isKnownSafetyLevel(level: string): level is PortalActionSafetyLevel {
  return (PORTAL_ACTION_SAFETY_LEVELS as readonly string[]).includes(level);
}
