/**
 * ScenarioMaterialService — 场景参考材料与 AI 场景生成（场景重构 P1）。
 *
 * 职责：
 *  1. 任意参考材料导入：txt/md 直读、pdf 用 PdfReader、docx 用零依赖
 *     DocxTextReader；文本落到数据目录 scenario-materials/ 下供重复使用。
 *  2. 组装「AI 学习材料 → 场景草案」的分析提示词（模型调用由外部注入，
 *     本服务只做确定性的解析、裁剪与归一化）。
 *  3. 解析模型输出为结构化场景草案（summary + materials insights +
 *     scenario deliverable/adaptivity/规则/方法/agents/workflow）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDocxText } from '../engine/io/DocxTextReader.js';
import { extractPptxText, extractXlsxText } from './MaterialExtractors.js';

export const MATERIAL_TEXT_CAP_PER_FILE = 60_000;
export const MATERIAL_TEXT_CAP_TOTAL = 240_000;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json']);
const MATERIAL_KINDS = [
  'template', 'exemplar', 'paper', 'textbook', 'method_book',
  'guide', 'policy', 'format_spec', 'user_spec', 'other',
] as const;
export type MaterialKind = typeof MATERIAL_KINDS[number];

/**
 * 材料大类（2026-09-01 刘总要求）：用途维度的顶层分类，与 MATERIAL_KINDS 的
 * 场景分析细分并存——category 面向项目资料库管理，kind 面向场景分析语义。
 */
export const MATERIAL_CATEGORIES = [
  'references',     // 文献（论文/书籍/报告）
  'data',           // 数据（问卷/统计/表格，含 csv/json/xlsx 与 sav/dta/rds 原始存档）
  'code',           // 代码（SPSS/Stata/R/Python 分析脚本）
  'notes',          // 研究笔记（访谈记录/田野笔记/备忘）
  'template_spec',  // 模板与规范（申报书模板/格式要求/范文）
  'other',
] as const;
export type MaterialCategory = typeof MATERIAL_CATEGORIES[number];
export const MATERIAL_CATEGORY_LABELS: Record<MaterialCategory, string> = {
  references: '文献',
  data: '数据',
  code: '代码',
  notes: '研究笔记',
  template_spec: '模板与规范',
  other: '其他',
};

/** 按扩展名推断材料大类（上传时的默认值，用户可改）。 */
export function inferMaterialCategory(extension: string): MaterialCategory {
  const ext = extension.toLowerCase();
  if (['.py', '.r', '.do', '.sas', '.m', '.ipynb', '.sql', '.stata'].includes(ext)) return 'code';
  if (['.csv', '.json', '.xlsx', '.xlsm', '.dta', '.sav', '.rds', '.rdata'].includes(ext)) return 'data';
  if (['.pdf', '.docx', '.doc'].includes(ext)) return 'references';
  if (['.md', '.markdown', '.txt', '.text'].includes(ext)) return 'notes';
  return 'other';
}

/** 统计软件数据二进制：原样存档（不抽文本），AI 不可读但保留资产并提示导出路径。 */
const BINARY_ARCHIVE_EXTENSIONS = new Set(['.dta', '.sav', '.rds', '.rdata']);
/** 代码脚本扩展名：按文本读取。 */
const CODE_TEXT_EXTENSIONS = new Set(['.py', '.r', '.do', '.sas', '.m']);

export interface MaterialMeta {
  category: MaterialCategory;
  projectIds: string[];
  addedAt: number;
  /** 二进制数据存档文件名（sav/dta/rds 等）：存在时该材料不参与 AI 文本读取。 */
  binaryArchive?: string;
}

export interface MaterialListEntry extends MaterialMeta {
  id: string;
  name: string;
  charCount: number;
}

const DELIVERABLE_TYPES = [
  'theory_paper', 'empirical_paper', 'computational_paper', 'case_study', 'review_paper',
  'grant_nssfc', 'grant_nsfc', 'grant_postdoc', 'grant_other',
  'policy_report', 'survey_report', 'tech_report', 'industry_report',
  'thesis', 'opening_report', 'completion_report', 'custom',
] as const;
export type DraftDeliverableType = typeof DELIVERABLE_TYPES[number];

const SECTION_KINDS = ['title', 'abstract', 'keywords', 'chapter', 'section', 'grant_column', 'attachment', 'references', 'other'] as const;
const SECTION_STATUSES = ['locked', 'required', 'optional', 'conditional'] as const;


export interface ImportedMaterial {
  id: string;
  name: string;
  kind: MaterialKind;
  storageRef: string;
  charCount: number;
}

export interface MaterialAnalysisInput {
  name: string;
  text: string;
}

export interface MaterialInsights {
  structureRules: string[];
  writingPrinciples: string[];
  methodSuggestions: string[];
  hardRequirements: string[];
}

export interface DraftSection {
  id: string;
  title: string;
  kind: (typeof SECTION_KINDS)[number];
  status: (typeof SECTION_STATUSES)[number];
  condition?: string;
  purpose?: string;
  requirements?: string[];
  optionalContent?: string[];
  forbidden?: string[];
  lengthTarget?: string;
  method?: string;
  evidence?: string;
  aiAdjust?: Record<string, boolean>;
  children?: DraftSection[];
}

export interface ScenarioAnalysisSummary {
  deliverableType: DraftDeliverableType;
  deliverableTypeLabel: string;
  structureTitles: string[];
  hardRuleCount: number;
  writingPrincipleCount: number;
  methods: string[];
  adjustable: string[];
  recommended: { agents: number; skills: number; mcps: number; rules: number };
}

export interface ScenarioDraft {
  name: string;
  description: string;
  triggerPhrases: string[];
  deliverableType: DraftDeliverableType;
  deliverableTypeLabel: string;
  sections: DraftSection[];
  structurePolicy?: { defaultSections: number; suggestedMin: number; suggestedMax: number };
  globalLength?: string;
  language?: 'zh' | 'en';
  journalTier?: 'any' | 'core' | 'general';
  adaptivity?: Record<string, unknown>;
  writingRules: string[];
  methodPolicy?: { recommended: string[]; allowed: string[]; conditional: string[]; forbidden: string[] };
  agents: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
  workflow: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
  rulesMarkdown: string;
}

export interface ScenarioAnalysisResult {
  summary: ScenarioAnalysisSummary;
  materials: Array<{ name: string; kind: MaterialKind; insights: MaterialInsights }>;
  draft: ScenarioDraft;
}

function slugId(title: string, fallback: string): string {
  const cleaned = title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-').replace(/^-+|-+$/gu, '');
  return (cleaned || fallback).slice(0, 60);
}

function clampStringArray(value: unknown, cap: number, itemCap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, itemCap);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

export class ScenarioMaterialService {
  readonly #materialsDir: string;

  constructor(baseDir: string) {
    this.#materialsDir = path.join(baseDir, 'scenario-materials');
    fs.mkdirSync(this.#materialsDir, { recursive: true });
  }

  get materialsDir(): string {
    return this.#materialsDir;
  }

  /** 导入一份参考材料：按扩展名提取文本并落盘，返回材料元数据。 */
  async importMaterial(
    filePath: string,
    options: { name?: string; category?: MaterialCategory; projectId?: string; extractPdf?: (filePath: string) => Promise<string> } = {},
  ): Promise<ImportedMaterial> {
    const resolved = path.resolve(filePath);
    const extension = path.extname(resolved).toLowerCase();
    const name = (options.name ?? path.basename(resolved)).slice(0, 200);
    const id = `mat-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let text: string;
    if (extension === '.ppt') {
      // 旧版二进制 PPT 没有可靠的零依赖文本抽取——如实要求转存。
      throw new Error('ppt_legacy_unsupported: 请将 .ppt 转存为 .pptx 后再上传');
    } else if (extension === '.pptx') {
      text = await extractPptxText(resolved);
    } else if (extension === '.xlsx' || extension === '.xlsm') {
      text = await extractXlsxText(resolved);
    } else if (BINARY_ARCHIVE_EXTENSIONS.has(extension)) {
      // SPSS(.sav)/Stata(.dta)/R(.rds/.rdata) 数据文件：零依赖无法解析内部结构，
      // 原样存档保留资产；文本置为导出指引，AI 不可读但列表可见可下载。
      const archived = path.join(this.#materialsDir, `${id}.archive${extension}`);
      fs.copyFileSync(resolved, archived);
      text = `[二进制数据文件存档：${name}。请在 ${extension.slice(1).toUpperCase()} 软件中导出为 CSV 后重新上传，AI 才能读取数据内容。]`;
      const clippedArchive = text;
      const archiveId = id;
      const archiveStorageRef = `${archiveId}.txt`;
      fs.writeFileSync(path.join(this.#materialsDir, archiveStorageRef), clippedArchive, 'utf8');
      this.writeMaterialMeta(archiveId, {
        category: options.category ?? 'data',
        projectIds: options.projectId ? [options.projectId] : [],
        addedAt: Date.now(),
        name,
        charCount: 0,
        binaryArchive: `app.archive${extension}`,
      });
      return { id: archiveId, name, kind: 'other', storageRef: archiveStorageRef, charCount: 0 };
    } else if (CODE_TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension)) {
      text = fs.readFileSync(resolved, 'utf8');
    } else if (extension === '.docx') {
      text = readDocxText(resolved);
    } else if (extension === '.pdf') {
      if (!options.extractPdf) throw new Error('pdf_extractor_unavailable');
      text = await options.extractPdf(resolved);
    } else {
      // 尝试按 UTF-8 文本读取；二进制内容在字符检查后拒绝。
      const candidate = fs.readFileSync(resolved, 'utf8');
      if (candidate.includes(String.fromCharCode(0))) throw new Error('unsupported_material_type')
      text = candidate;
    }
    const clipped = text.replace(/\r\n/gu, '\n').trim().slice(0, 500_000);
    if (clipped.length < 20) throw new Error('material_too_short');
    const storageRef = `${id}.txt`;
    fs.writeFileSync(path.join(this.#materialsDir, storageRef), clipped, 'utf8');
    this.writeMaterialMeta(id, {
      category: options.category ?? inferMaterialCategory(extension),
      projectIds: options.projectId ? [options.projectId] : [],
      addedAt: Date.now(),
      name,
      charCount: clipped.length,
    });
    return { id, name, kind: 'other', storageRef, charCount: clipped.length };
  }

  // ─── 材料元数据索引与大类管理（2026-09-01 刘总要求） ───────────────────────

  #metaPath(): string {
    return path.join(this.#materialsDir, 'material-index.json');
  }

  #readMetaIndex(): Record<string, MaterialMeta & { name?: string; charCount?: number }> {
    try {
      const raw = fs.readFileSync(this.#metaPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  #writeMetaIndex(index: Record<string, unknown>): void {
    fs.writeFileSync(this.#metaPath(), `${JSON.stringify(index, null, 1)}\n`, 'utf8');
  }

  writeMaterialMeta(id: string, meta: MaterialMeta & { name?: string; charCount?: number }): void {
    const index = this.#readMetaIndex();
    index[id] = meta;
    this.#writeMetaIndex(index);
  }

  listMaterials(projectId?: string): MaterialListEntry[] {
    const index = this.#readMetaIndex();
    const entries: MaterialListEntry[] = [];
    for (const [id, meta] of Object.entries(index)) {
      if (projectId && !(meta.projectIds ?? []).includes(projectId)) continue;
      const storageRef = `${id}.txt`;
      const target = path.join(this.#materialsDir, storageRef);
      let charCount = meta.charCount ?? 0;
      try {
        charCount = Math.max(charCount, fs.readFileSync(target, 'utf8').length);
      } catch { continue; }
      entries.push({
        id, name: meta.name ?? id, charCount,
        category: MATERIAL_CATEGORIES.includes(meta.category) ? meta.category : 'other',
        projectIds: meta.projectIds ?? [],
        addedAt: meta.addedAt ?? 0,
      });
    }
    return entries.sort((left, right) => right.addedAt - left.addedAt);
  }

  deleteMaterial(id: string): boolean {
    if (!/^[a-z0-9-]+$/u.test(id)) return false;
    const target = path.join(this.#materialsDir, `${id}.txt`);
    let deleted = false;
    try {
      if (fs.existsSync(target)) { fs.unlinkSync(target); deleted = true; }
    } catch { return false; }
    const index = this.#readMetaIndex();
    if (index[id]) { delete index[id]; this.#writeMetaIndex(index); }
    return deleted || index[id] === undefined;
  }

  setMaterialCategory(id: string, category: MaterialCategory): boolean {
    const index = this.#readMetaIndex();
    if (!index[id]) return false;
    index[id]!.category = category;
    this.#writeMetaIndex(index);
    return true;
  }

  /** 读取已导入材料的文本（用于再次分析或追加学习）。 */
  loadMaterialText(id: string): string | null {
    if (!/^[a-z0-9-]+$/u.test(id)) return null;
    const target = path.join(this.#materialsDir, `${id}.txt`);
    if (!target.startsWith(this.#materialsDir + path.sep)) return null;
    if (!fs.existsSync(target)) return null;
    return fs.readFileSync(target, 'utf8');
  }

  /** 组装分析提示词（确定性部分；模型调用由调用方注入）。 */
  buildAnalysisPrompts(
    requirement: string,
    materials: readonly MaterialAnalysisInput[],
    catalog: string,
  ): { system: string; user: string } {
    const perMaterialCap = Math.max(4_000, Math.floor(MATERIAL_TEXT_CAP_TOTAL / Math.max(1, materials.length)));
    const materialBlocks = materials.map((material, index) => {
      const text = material.text.slice(0, Math.min(MATERIAL_TEXT_CAP_PER_FILE, perMaterialCap));
      return `【材料${index + 1}】${material.name}\n<material>\n${text}\n</material>`;
    }).join('\n\n');
    const system = [
      '你是人文社科科研场景设计师。用户想创建一个可复用的研究场景（这类科研任务的标准工作方式）。',
      '用户可能提供：自然语言需求描述，以及若干参考材料（可能是模板、范文、论文、写作教材、专著、方法书、投稿指南、政策文件、格式规范或任意参考文件）。',
      '你要综合所有信息设计场景，不要机械套用某一份材料；材料内容只作参考来源，判断哪些值得转化为场景配置。',
      '只输出一个 JSON 对象，不要解释、前后缀或 Markdown 代码围栏。JSON 结构：',
      '{',
      '  "summary": { "deliverableType": "成果类型代码", "deliverableTypeLabel": "中文名称", "structureTitles": ["题目","摘要","1 引言","…"], "hardRuleCount": 数字, "writingPrincipleCount": 数字, "methods": ["理论分析"], "adjustable": ["主体章节"], "recommended": { "agents": 3, "skills": 6, "mcps": 1, "rules": 2 } },',
      '  "materials": [ { "name": "材料名", "kind": "template|exemplar|paper|textbook|method_book|guide|policy|format_spec|user_spec|other", "insights": { "structureRules": ["…"], "writingPrinciples": ["…"], "methodSuggestions": ["…"], "hardRequirements": ["…"] } } ],',
      '  "scenario": {',
      '    "name": "场景名(≤40字)", "description": "场景说明(≤200字)", "triggerPhrases": ["触发词"],',
      '    "deliverable": { "type": "成果类型代码", "typeLabel": "中文名称",',
      '      "sections": [ { "id": "title", "title": "题目", "kind": "title", "status": "locked", "purpose": "作用", "requirements": ["必须包含"], "optionalContent": ["可选"], "forbidden": ["禁止"], "lengthTarget": "建议篇幅", "method": "方法", "evidence": "证据要求", "condition": "条件出现时才填写", "children": [] } ],',
      '      "structurePolicy": { "defaultSections": 5, "suggestedMin": 4, "suggestedMax": 7 }, "globalLength": "10000-12000 字", "language": "zh", "journalTier": "core|general|any" },',
      '    "adaptivity": { "structure": { "addSections": true, "deleteUnlockedSections": true, "splitSections": true, "mergeSections": true, "reorderSections": true, "adjustLength": true },',
      '      "content": { "reviseQuestion": true, "addQuestion": false, "reviseHypothesis": true, "dropUnsupportedHypothesis": true, "adjustFramework": true },',
      '      "method": { "addMethod": true, "replaceUnsuitableMethod": true, "addRobustness": true, "addHeterogeneity": false, "addMechanism": false },',
      '      "allowedBacktracks": ["analysis->literature"], "majorAdjustmentTriggers": ["新证据推翻原假设"] },',
      '    "writingRules": ["摘要禁止出现本文"], "methodPolicy": { "recommended": ["历史分析"], "allowed": [], "conditional": [], "forbidden": ["问卷调查"] },',
      '    "agents": [ { "name": "智能体名", "role": "职责", "systemPrompt": "系统指令(≤600字)", "skillIds": [], "toolIds": [], "mcpIds": [], "maxTurns": 12 } ],',
      '    "workflow": [ { "name": "步骤名", "description": "说明", "agent": "智能体名", "skillIds": [], "toolIds": [], "mcpIds": [], "maxTurns": 12 } ],',
      '    "rules": "场景 Metis.md（Markdown ≤1500字）：研究目标、资料与证据边界、输出规范" }',
      '}',
      '设计要求：',
      '1. sections 覆盖该成果类型的完整结构（题目/摘要/关键词/正文各章/参考文献等），每部分 status：锁定=核心功能不可删（如题目、研究设计）、required=默认必选、optional=可选、conditional=满足条件时由 AI 加入（须给 condition）。',
      '2. 每个正文章节写 purpose/requirements/lengthTarget，方法性章节写 method/evidence。',
      '3. adaptivity 是 AI 的自主边界：只允许在用户合理的范围内放开；锁定部分永不可删。',
      '4. 从材料中学习：模板→结构规则与硬性要求；范文→结构与写作方式；教材/专著→可复用写作原则与方法建议；指南/规范→硬性规范。区分“结构要求/写作经验/方法建议/硬性规范”，普通内容不要都变成规则。',
      '5. agents 1-3 个；workflow 2-7 步按执行顺序；skillIds/mcpIds 只能从现有定义清单选。toolIds 只能使用已注册工具：read_file、write_file、web_search、list_sources、extract_evidence、link_evidence、draft_claim、save_artifact。',
      `现有定义清单：\n${catalog || '（暂无）'}`,
    ].join('\n');
    const user = [
      requirement.trim() ? `## 用户需求\n${requirement.trim().slice(0, 4_000)}` : '## 用户需求\n（用户未填写文字需求，请完全依据参考材料设计场景）',
      materialBlocks.length > 0 ? `## 参考材料（共 ${materialBlocks.length} 份）\n${materialBlocks}` : '',
      '请综合以上信息输出场景设计 JSON。',
    ].filter(Boolean).join('\n\n');
    return { system, user };
  }

  /** 解析模型输出为场景分析结果（容错裁剪，保证枚举与数量合法）。 */
  parseAnalysisResponse(raw: string): ScenarioAnalysisResult | null {
    const cleaned = raw.trim().replace(/```(?:json)?/gu, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const root = parsed as Record<string, unknown>;
    const scenarioRaw = typeof root.scenario === 'object' && root.scenario !== null ? root.scenario as Record<string, unknown> : {};
    const deliverableRaw = typeof scenarioRaw.deliverable === 'object' && scenarioRaw.deliverable !== null ? scenarioRaw.deliverable as Record<string, unknown> : {};
    const type = (DELIVERABLE_TYPES as readonly string[]).includes(deliverableRaw.type as string)
      ? deliverableRaw.type as DraftDeliverableType
      : 'custom';
    const sections = this.normalizeSections(deliverableRaw.sections);
    const adaptivityRaw = scenarioRaw.adaptivity;
    const adaptivity = typeof adaptivityRaw === 'object' && adaptivityRaw !== null
      ? adaptivityRaw as Record<string, unknown>
      : undefined;
    const methodPolicyRaw = typeof scenarioRaw.methodPolicy === 'object' && scenarioRaw.methodPolicy !== null
      ? scenarioRaw.methodPolicy as Record<string, unknown>
      : undefined;
    const summaryRaw = typeof root.summary === 'object' && root.summary !== null ? root.summary as Record<string, unknown> : {};
    const materialsRaw = Array.isArray(root.materials) ? root.materials : [];
    const hardCount = materialsRaw.reduce((total, item) => {
      const insights = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).insights : null;
      const hard = typeof insights === 'object' && insights !== null ? (insights as Record<string, unknown>).hardRequirements : null;
      return total + (Array.isArray(hard) ? hard.length : 0);
    }, 0);
    const writingCount = materialsRaw.reduce((total, item) => {
      const insights = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).insights : null;
      const writing = typeof insights === 'object' && insights !== null ? (insights as Record<string, unknown>).writingPrinciples : null;
      return total + (Array.isArray(writing) ? writing.length : 0);
    }, 0);
    const recommendedRaw = typeof summaryRaw.recommended === 'object' && summaryRaw.recommended !== null
      ? summaryRaw.recommended as Record<string, unknown>
      : {};
    return {
      summary: {
        deliverableType: type,
        deliverableTypeLabel: typeof summaryRaw.deliverableTypeLabel === 'string' ? summaryRaw.deliverableTypeLabel.slice(0, 120) : String(deliverableRaw.typeLabel ?? '').slice(0, 120) || '自定义成果',
        structureTitles: clampStringArray(summaryRaw.structureTitles, 48, 120).length > 0
          ? clampStringArray(summaryRaw.structureTitles, 48, 120)
          : sections.map((section) => section.title),
        hardRuleCount: Number.isFinite(summaryRaw.hardRuleCount) ? Number(summaryRaw.hardRuleCount) : hardCount,
        writingPrincipleCount: Number.isFinite(summaryRaw.writingPrincipleCount) ? Number(summaryRaw.writingPrincipleCount) : writingCount,
        methods: clampStringArray(summaryRaw.methods, 16, 120),
        adjustable: clampStringArray(summaryRaw.adjustable, 16, 120),
        recommended: {
          agents: Number.isFinite(recommendedRaw.agents) ? Number(recommendedRaw.agents) : 0,
          skills: Number.isFinite(recommendedRaw.skills) ? Number(recommendedRaw.skills) : 0,
          mcps: Number.isFinite(recommendedRaw.mcps) ? Number(recommendedRaw.mcps) : 0,
          rules: Number.isFinite(recommendedRaw.rules) ? Number(recommendedRaw.rules) : 0,
        },
      },
      materials: materialsRaw
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .slice(0, 32)
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name.slice(0, 200) : '未命名材料',
          kind: (MATERIAL_KINDS as readonly string[]).includes(item.kind as string) ? item.kind as MaterialKind : 'other',
          insights: {
            structureRules: clampStringArray((item.insights as Record<string, unknown> | undefined)?.structureRules, 64, 500),
            writingPrinciples: clampStringArray((item.insights as Record<string, unknown> | undefined)?.writingPrinciples, 64, 500),
            methodSuggestions: clampStringArray((item.insights as Record<string, unknown> | undefined)?.methodSuggestions, 64, 500),
            hardRequirements: clampStringArray((item.insights as Record<string, unknown> | undefined)?.hardRequirements, 64, 500),
          },
        })),
      draft: {
        name: typeof scenarioRaw.name === 'string' && scenarioRaw.name.trim() ? scenarioRaw.name.trim().slice(0, 60) : '未命名场景',
        description: typeof scenarioRaw.description === 'string' ? scenarioRaw.description.trim().slice(0, 400) : '',
        triggerPhrases: clampStringArray(scenarioRaw.triggerPhrases, 16, 200),
        deliverableType: type,
        deliverableTypeLabel: typeof deliverableRaw.typeLabel === 'string' ? deliverableRaw.typeLabel.slice(0, 120) : '',
        sections,
        structurePolicy: this.normalizeStructurePolicy(deliverableRaw.structurePolicy, sections),
        globalLength: typeof deliverableRaw.globalLength === 'string' ? deliverableRaw.globalLength.slice(0, 200) : undefined,
        language: deliverableRaw.language === 'en' ? 'en' : 'zh',
        journalTier: ['any', 'core', 'general'].includes(deliverableRaw.journalTier as string) ? deliverableRaw.journalTier as 'any' | 'core' | 'general' : undefined,
        adaptivity,
        writingRules: clampStringArray(scenarioRaw.writingRules, 64, 500),
        methodPolicy: methodPolicyRaw
          ? {
              recommended: clampStringArray(methodPolicyRaw.recommended, 24, 200),
              allowed: clampStringArray(methodPolicyRaw.allowed, 24, 200),
              conditional: clampStringArray(methodPolicyRaw.conditional, 24, 200),
              forbidden: clampStringArray(methodPolicyRaw.forbidden, 24, 200),
            }
          : undefined,
        agents: (Array.isArray(scenarioRaw.agents) ? scenarioRaw.agents : [])
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .slice(0, 4)
          .map((item) => ({
            name: typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '智能体',
            role: typeof item.role === 'string' ? item.role.slice(0, 200) : '',
            systemPrompt: typeof item.systemPrompt === 'string' ? item.systemPrompt.slice(0, 2_000) : '',
            skillIds: clampStringArray(item.skillIds, 32, 160),
            toolIds: clampStringArray(item.toolIds, 32, 160),
            mcpIds: clampStringArray(item.mcpIds, 32, 160),
            maxTurns: Math.min(30, Math.max(1, Number(item.maxTurns) || 12)),
          }))
          .filter((agent) => agent.systemPrompt),
        workflow: (Array.isArray(scenarioRaw.workflow) ? scenarioRaw.workflow : [])
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .slice(0, 8)
          .map((item) => ({
            name: typeof item.name === 'string' ? item.name.trim().slice(0, 120) : '步骤',
            description: typeof item.description === 'string' ? item.description.slice(0, 400) : '',
            agent: typeof item.agent === 'string' ? item.agent.slice(0, 60) : '',
            skillIds: clampStringArray(item.skillIds, 32, 160),
            toolIds: clampStringArray(item.toolIds, 32, 160),
            mcpIds: clampStringArray(item.mcpIds, 32, 160),
            maxTurns: Math.min(30, Math.max(1, Number(item.maxTurns) || 12)),
          }))
          .filter((step) => step.agent),
        rulesMarkdown: typeof scenarioRaw.rules === 'string' ? scenarioRaw.rules.slice(0, 4_000) : '',
      },
    };
  }

  normalizeSections(raw: unknown): DraftSection[] {
    if (!Array.isArray(raw)) return [];
    const out: DraftSection[] = [];
    const usedIds = new Set<string>();
    const visit = (items: unknown[], depth: number): void => {
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue;
        if (out.length >= 96) return;
        const record = item as Record<string, unknown>;
        const title = typeof record.title === 'string' ? record.title.trim().slice(0, 120) : '';
        if (!title) continue;
        let id = typeof record.id === 'string' && record.id.trim() ? slugId(record.id, 'sec') : slugId(title, 'sec');
        while (usedIds.has(id)) id = id + '-' + usedIds.size;
        usedIds.add(id);
        const section: DraftSection = {
          id,
          title,
          kind: (SECTION_KINDS as readonly string[]).includes(record.kind as string) ? record.kind as DraftSection['kind'] : 'other',
          status: (SECTION_STATUSES as readonly string[]).includes(record.status as string) ? record.status as DraftSection['status'] : 'required',
        };
        if (section.status === 'conditional' && typeof record.condition === 'string' && record.condition.trim()) {
          section.condition = record.condition.trim().slice(0, 1_000);
        } else if (section.status === 'conditional') {
          section.status = 'optional';
        }
        if (typeof record.purpose === 'string' && record.purpose.trim()) section.purpose = record.purpose.trim().slice(0, 2_000);
        const requirements = clampStringArray(record.requirements, 32, 500);
        if (requirements.length > 0) section.requirements = requirements;
        const optionalContent = clampStringArray(record.optionalContent, 32, 500);
        if (optionalContent.length > 0) section.optionalContent = optionalContent;
        const forbidden = clampStringArray(record.forbidden, 32, 500);
        if (forbidden.length > 0) section.forbidden = forbidden;
        if (typeof record.lengthTarget === 'string' && record.lengthTarget.trim()) section.lengthTarget = record.lengthTarget.trim().slice(0, 200);
        if (typeof record.method === 'string' && record.method.trim()) section.method = record.method.trim().slice(0, 500);
        if (typeof record.evidence === 'string' && record.evidence.trim()) section.evidence = record.evidence.trim().slice(0, 500);
        if (typeof record.aiAdjust === 'object' && record.aiAdjust !== null) {
          const adjust: Record<string, boolean> = {};
          for (const entry of Object.entries(record.aiAdjust as Record<string, unknown>)) {
            if (typeof entry[1] === 'boolean') adjust[entry[0]] = entry[1] as boolean;
          }
          if (Object.keys(adjust).length > 0) section.aiAdjust = adjust;
        }
        if (depth < 3 && Array.isArray(record.children) && record.children.length > 0) {
          const children: DraftSection[] = [];
          for (const node of record.children) {
            if (typeof node !== 'object' || node === null) continue;
            const childRecord = node as Record<string, unknown>;
            const childTitle = typeof childRecord.title === 'string' ? childRecord.title.trim().slice(0, 120) : '';
            if (!childTitle) continue;
            let childId = typeof childRecord.id === 'string' && childRecord.id.trim() ? slugId(childRecord.id, 'sub') : slugId(childTitle, 'sub');
            while (usedIds.has(childId)) childId = childId + '-' + usedIds.size;
            usedIds.add(childId);
            const child: DraftSection = {
              id: childId,
              title: childTitle,
              kind: (SECTION_KINDS as readonly string[]).includes(childRecord.kind as string) ? childRecord.kind as DraftSection['kind'] : 'section',
              status: (SECTION_STATUSES as readonly string[]).includes(childRecord.status as string) ? childRecord.status as DraftSection['status'] : 'optional',
            };
            if (child.status === 'conditional' && typeof childRecord.condition === 'string' && childRecord.condition.trim()) {
              child.condition = childRecord.condition.trim().slice(0, 1_000);
            } else if (child.status === 'conditional') {
              child.status = 'optional';
            }
            if (typeof childRecord.purpose === 'string' && childRecord.purpose.trim()) child.purpose = childRecord.purpose.trim().slice(0, 1_000);
            const childRequirements = clampStringArray(childRecord.requirements, 16, 500);
            if (childRequirements.length > 0) child.requirements = childRequirements;
            children.push(child);
          }
          if (children.length > 0) section.children = children;
        }
        out.push(section);
      }
    };
    visit(raw, 0);
    return out;
  }

  normalizeStructurePolicy(raw: unknown, sections: DraftSection[]): { defaultSections: number; suggestedMin: number; suggestedMax: number } | undefined {
    const chapterCount = sections.filter((section) => section.kind === 'chapter').length;
    if (typeof raw !== 'object' || raw === null) {
      return chapterCount > 0 ? { defaultSections: chapterCount, suggestedMin: Math.max(1, chapterCount - 1), suggestedMax: chapterCount + 2 } : undefined;
    }
    const record = raw as Record<string, unknown>;
    const fallback = chapterCount > 0 ? chapterCount : 5;
    const defaultSections = Math.min(48, Math.max(1, Number(record.defaultSections) || fallback));
    const suggestedMin = Math.min(48, Math.max(1, Number(record.suggestedMin) || defaultSections));
    const suggestedMax = Math.min(64, Math.max(suggestedMin, Number(record.suggestedMax) || suggestedMin + 2));
    return { defaultSections, suggestedMin, suggestedMax };
  }

  /** 「AI 帮我配置」：针对单个配置对象（章节规则/写作规范/自适应等）生成补全提示词。 */
  buildRefinePrompts(input: {
    targetKind: 'section' | 'writingRules' | 'methodPolicy' | 'adaptivity';
    targetTitle: string;
    currentValue: string;
    instruction: string;
    materialsText?: string;
  }): { system: string; user: string } {
    const system = [
      '你是科研场景配置助手。用户正在编辑一个研究场景的某项配置，需要你补全或改进它。',
      '只输出一个 JSON 对象，不要解释。输出结构必须与用户提供的当前值同构（字段一致，仅填充或改进内容）。',
      input.targetKind === 'section' ? '章节配置字段：purpose（作用）、requirements（必须包含，数组）、optionalContent（可选，数组）、forbidden（禁止，数组）、lengthTarget（篇幅）、method（方法）、evidence（证据要求）。' : '',
      input.targetKind === 'writingRules' ? '输出 { "writingRules": ["…"] }（8-20 条，每条一个明确规范）。' : '',
      input.targetKind === 'methodPolicy' ? '输出 { "recommended": [], "allowed": [], "conditional": [], "forbidden": [] }（方法名数组）。' : '',
      input.targetKind === 'adaptivity' ? '输出与当前值同构的 adaptivity JSON（structure/content/method 布尔开关 + allowedBacktracks + majorAdjustmentTriggers）。' : '',
    ].filter(Boolean).join('\n');
    const user = [
      '## 配置对象\n' + input.targetTitle + '\n当前值：\n' + input.currentValue.slice(0, 8_000),
      '## 用户指令\n' + input.instruction.trim().slice(0, 2_000),
      input.materialsText ? '## 场景参考材料（节选）\n' + input.materialsText.slice(0, 12_000) : '',
      '请输出补全后的 JSON。',
    ].filter(Boolean).join('\n\n');
    return { system, user };
  }
}
