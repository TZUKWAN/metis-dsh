/**
 * Real PPT Generation Skill execution for Outcomes.
 *
 * The Provider sees only the repository's current PPT version, the selected
 * persisted generation skill/template and the user's instruction. Its response
 * is a strict patch, never an arbitrary document replacement. A valid patch is
 * committed as an immutable AI version through OutcomeRepository.
 */
import { randomUUID } from 'node:crypto';
import { OutlineDocumentSchema, outlineContractPrompt, getPptThemeProfile, renderZoneOutline, auditZonePages } from '../engine/pptx/ZoneLayoutEngine.js';
import type { ChatMessage } from '../engine/core/types.js';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import {
  OutcomeDocumentSchema,
  PptGenerationExecuteRequestSchema,
  PptGenerationModelResponseSchema,
  PptGenerationResultSchema,
  type OutcomeSource,
  type PptDocument,
  type PptGenerationDiagnostic,
  type PptGenerationExecuteRequest,
  type PptGenerationPatch,
  type PptGenerationResult,
  type PptGenerationSkill,
  type PptTemplate,
  type ScopedConversationMessage,
} from '../engine/runtime/OutcomeRuntimeContract.js';
import type { ProviderProfileBinding } from '../engine/runtime/ProviderProfileContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import { OutcomeProjectContextService, type OutcomeProjectContext } from './OutcomeProjectContextService.js';
import { OutcomeRepository } from './OutcomeRepository.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_DOCUMENT_CONTEXT_CHARS = 90_000;
type PptGenerationRunner = Pick<AgentLoop, 'run'>;

export interface OutcomePptGenerationServiceOptions {
  repository: OutcomeRepository;
  agentLoop: PptGenerationRunner;
  modelName: string;
  /** Credential-free routing receipt resolved by the main-process provider resolver. */
  providerProfileBinding?: ProviderProfileBinding;
  projectContext?: Pick<OutcomeProjectContextService, 'collect'>;
  /** T8：Profile 全局风格段（跨该 Profile 全部 AI Action）。 */
  getGlobalPrompt?: (officeKind: string, outcomeId: string | null) => string | null;
  /** 内容规范（2026-09-01）：按项目解析激活章程，演示规范与质量阈值随之注入。 */
  skill: PptGenerationSkill;
  template: PptTemplate | null;
  isRuntimeCurrent?: () => boolean;
  /** Cooperative cancellation owned by the main-process shutdown coordinator. */
  signal?: AbortSignal;
  /** 成果提示词工程(任务4/5):行为段 Override 解析(带 outcomeId 以支持 Profile 绑定)。 */
  resolveBehaviorPrompt?: (promptId: string, outcomeId?: string | null) => string | null;
}

function diagnostic(code: PptGenerationDiagnostic['code'], message: string): PptGenerationDiagnostic {
  return { code, message };
}
function projectContextDiagnostics(context: OutcomeProjectContext): PptGenerationDiagnostic[] {
  return context.diagnostics.flatMap((item) => {
    if (item.code === 'project_context_unavailable' || item.code === 'project_context_truncated') {
      return [diagnostic(item.code, item.message)];
    }
    return [];
  });
}
function asPromptMessages(messages: ScopedConversationMessage[]): ChatMessage[] {
  return messages.slice(-MAX_HISTORY_MESSAGES).map((message) => ({ role: message.role, content: message.content }));
}
function serializeDocument(document: PptDocument): string {
  const serialized = JSON.stringify(document);
  return serialized.length <= MAX_DOCUMENT_CONTEXT_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_DOCUMENT_CONTEXT_CHARS)}\n[文档内容因模型上下文上限被截断；未展示部分不可作为修改依据。]`;
}
function removeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
}
// 真实模型自然输出小数坐标（实证：height:1.4），而 PPT Grid 契约保持整数
// 不变式。模型提议、产品对齐：四舍五入并夹紧到合法 Grid 边界后再校验。
function clampRound(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.min(max, Math.max(min, Math.round(value)));
}
function normalizeElementGrid(element: unknown): unknown {
  if (typeof element !== 'object' || element === null) return element;
  const e = { ...(element as Record<string, unknown>) };
  if (typeof e.x === 'number') e.x = clampRound(e.x, 0, 32);
  if (typeof e.y === 'number') e.y = clampRound(e.y, 0, 18);
  if (typeof e.width === 'number') e.width = clampRound(e.width, 1, 32);
  if (typeof e.height === 'number') e.height = clampRound(e.height, 1, 18);
  return e;
}
function normalizePageGrid(page: unknown): unknown {
  if (typeof page !== 'object' || page === null) return page;
  const p = { ...(page as Record<string, unknown>) };
  if (Array.isArray(p.elements)) p.elements = p.elements.map(normalizeElementGrid);
  return p;
}
function normalizeModelPatchGrid(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = { ...body as Record<string, unknown> };
  const patch = b.patch;
  if (typeof patch === 'object' && patch !== null) {
    const p = { ...(patch as Record<string, unknown>) };
    if (Array.isArray(p.replacePages)) p.replacePages = p.replacePages.map(normalizePageGrid);
    if (Array.isArray(p.appendPages)) p.appendPages = p.appendPages.map(normalizePageGrid);
    b.patch = p;
  }
  return b;
}
function parseModelResponse(raw: string): { value?: { answer: string; patch: PptGenerationPatch }; error?: PptGenerationDiagnostic } {
  // 诊断：契约失败时携带模型原始返回的截断片段，否则失败完全不可归因。
  const rawSlice = `（原始返回前 500 字符：${raw.slice(0, 500)}）`;
  try {
    const parsed = PptGenerationModelResponseSchema.safeParse(normalizeModelPatchGrid(JSON.parse(removeFence(raw))));
    return parsed.success
      ? { value: parsed.data }
      : { error: diagnostic('model_response_contract_error', `模型返回的 PPT patch 未通过成果文档约束，未写入版本。${rawSlice}`) };
  } catch {
    return { error: diagnostic('model_response_contract_error', `模型没有返回可应用的 PPT patch JSON，未写入版本。${rawSlice}`) };
  }
}
function templateTheme(template: PptTemplate | null): Record<string, unknown> {
  const candidate = template?.definition.theme;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}
function elementsFitGrid(document: PptDocument, elements: PptDocument['pages'][number]['elements']): boolean {
  const maxX = document.ratio === '4:3' ? 24 : 32;
  const ids = new Set<string>();
  return elements.every((element) => {
    if (ids.has(element.id)) return false;
    ids.add(element.id);
    return element.x + element.width <= maxX && element.y + element.height <= 18;
  });
}
function applyPatch(document: PptDocument, patch: PptGenerationPatch, skill: PptGenerationSkill, template: PptTemplate | null): {
  content?: PptDocument;
  diagnostic?: PptGenerationDiagnostic;
} {
  const replaced = new Set<string>();
  for (const page of patch.replacePages) {
    if (replaced.has(page.pageId)) return { diagnostic: diagnostic('patch_target_duplicate', '模型 patch 重复修改了同一页面，未写入版本。') };
    replaced.add(page.pageId);
    if (!document.pages.some((item) => item.id === page.pageId)) return { diagnostic: diagnostic('patch_target_not_found', '模型 patch 指向的 PPT 页面不存在，未写入版本。') };
  }
  const knownIds = new Set(document.pages.map((page) => page.id));
  for (const page of patch.appendPages) {
    if (knownIds.has(page.id)) return { diagnostic: diagnostic('patch_page_id_conflict', '模型新建页面的 ID 与现有页面冲突，未写入版本。') };
    knownIds.add(page.id);
    if (!elementsFitGrid(document, page.elements)) return { diagnostic: diagnostic('model_response_contract_error', '模型新建页面含有重复元素 ID 或超出 PPT Grid 的元素，未写入版本。') };
  }
  if (document.pages.length + patch.appendPages.length > 500) return { diagnostic: diagnostic('model_response_contract_error', '模型 patch 超出 PPT 的页面数量上限，未写入版本。') };
  for (const page of patch.replacePages) if (page.elements && !elementsFitGrid(document, page.elements)) return { diagnostic: diagnostic('model_response_contract_error', '模型替换页面含有重复元素 ID 或超出 PPT Grid 的元素，未写入版本。') };
  const updates = new Map(patch.replacePages.map((page) => [page.pageId, page]));
  const candidate = {
    ...document,
    theme: { ...document.theme, ...templateTheme(template), ...(patch.theme ?? {}) },
    templateId: template?.id ?? null,
    generationSkillId: skill.id,
    pages: [
      ...document.pages.map((page) => {
        const update = updates.get(page.id);
        return update ? {
          ...page,
          ...(update.title === undefined ? {} : { title: update.title }),
          ...(update.pageType === undefined ? {} : { pageType: update.pageType }),
          ...(update.elements === undefined ? {} : { elements: update.elements }),
          status: 'complete' as const,
        } : page;
      }),
      ...patch.appendPages.map((page) => ({ ...page, humanModified: false, status: 'complete' as const })),
    ],
  };
  const parsed = OutcomeDocumentSchema.safeParse(candidate);
  return parsed.success && parsed.data.type === 'ppt'
    ? { content: parsed.data }
    : { diagnostic: diagnostic('model_response_contract_error', '模型 patch 不能形成有效 PPT Grid 文档，未写入版本。') };
}
function prompt(input: {
  title: string;
  version: number;
  document: PptDocument;
  skill: PptGenerationSkill;
  template: PptTemplate | null;
  instruction: string;
  historyTruncated: boolean;
  projectContext: OutcomeProjectContext;
}): string {
  const grid = input.document.ratio === '4:3' ? '24×18' : '32×18';
  const template = input.template
    ? `已选择模板：${JSON.stringify(input.template)}`
    : '未选择模板；不要杜撰模板资产、图片或来源。';
  return [
    '你是 METIS PPT Generation Skill 执行器。仅根据当前成果、当前成果协同历史、已选择的生成技能、模板和用户要求生成 PPT Grid patch。',
    `不能使用未给出的项目资料、图片、数据、模板资产或外部来源；不要调用工具。所有元素必须在 ${grid} PPT Grid 范围内。`,
    `当前成果：${input.title}；当前不可覆盖版本：v${input.version}。`,
    `生成技能：${JSON.stringify(input.skill)}。`,
    template,
    input.historyTruncated ? `仅提供最近 ${MAX_HISTORY_MESSAGES} 条成果协同历史。` : '已提供全部当前成果协同历史。',
    `用户生成要求：${input.instruction}`,
    '必须只输出一个 JSON 对象，且不能使用 Markdown 代码围栏：',
    '{"answer":"给用户的中文生成说明","patch":{"replacePages":[{"pageId":"现有页面ID","title":"可选标题","pageType":"可选类型","elements":[完整元素数组]}],"appendPages":[{"id":"新且唯一页面ID","title":"标题","pageType":"content","elements":[]}],"theme":{},"note":"简短版本说明"}}',
    'patch 至少必须包含 replacePages、appendPages 或 theme 之一。替换页面只能使用当前文档已有 ID；appendPages 必须使用新且唯一的 ID。',
    '元素坐标 x/y/width/height 会被对齐到整数 Grid（x/width 取值 0..32，y/height 取值 0..18，宽高最小 1）；请尽量直接给出整数。',
    `当前 PPT 文档 JSON：\n${serializeDocument(input.document)}`,
    input.projectContext.prompt,
  ].filter(Boolean).join('\n');
}

export class OutcomePptGenerationService {
  constructor(private readonly options: OutcomePptGenerationServiceOptions) {}
  private result(value: PptGenerationResult): PptGenerationResult { return PptGenerationResultSchema.parse(value); }

  async execute(rawRequest: unknown): Promise<PptGenerationResult> {
    const parsedRequest = PptGenerationExecuteRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success) return this.result({ status: 'error', code: 'invalid_request', message: 'PPT 生成请求无效。', answer: '', sources: [], diagnostics: [diagnostic('invalid_request', '请求未通过 PPT Generation Skill 契约校验。')] });
    const request: PptGenerationExecuteRequest = parsedRequest.data;
    if (request.generationSkillId !== this.options.skill.id) return this.result({ status: 'error', code: 'generation_skill_not_found', message: '所选 PPT 生成技能不存在或已变化。', answer: '', sources: [], diagnostics: [diagnostic('generation_skill_not_found', '请求的技能与主进程加载的技能不一致。')] });
    if (request.templateId !== this.options.template?.id && !(request.templateId === null && this.options.template === null)) return this.result({ status: 'error', code: 'template_not_found', message: '所选 PPT 模板不存在或已变化。', answer: '', sources: [], diagnostics: [diagnostic('template_not_found', '请求的模板与主进程加载的模板不一致。')] });
    const detail = this.options.repository.get(request.projectId, request.outcomeId);
    if (!detail) return this.result({ status: 'error', code: 'outcome_not_found', message: '当前成果不存在或不属于所选项目。', answer: '', sources: [], diagnostics: [diagnostic('outcome_not_found', '未找到当前项目中的成果。')] });
    if (detail.version.content.type !== 'ppt') return this.result({ status: 'error', code: 'outcome_not_ppt', message: '所选成果不是 PPT，无法执行 PPT 生成技能。', answer: '', sources: [], diagnostics: [diagnostic('outcome_not_ppt', '当前成果文档类型不是 PPT。')] });
    if (detail.outcome.currentVersion !== request.baseVersion || detail.version.version !== request.baseVersion) return this.result({ status: 'error', code: 'outcome_version_conflict', message: '成果已有新版本，请重新打开最新版本后生成。', answer: '', sources: [], diagnostics: [diagnostic('outcome_version_conflict', '请求基于的 PPT 版本不是当前版本。')] });

    const projectContext = (this.options.projectContext ?? new OutcomeProjectContextService(this.options.repository)).collect({
      projectId: request.projectId,
      outcomeId: request.outcomeId,
      instruction: request.instruction,
      // 任务2（Artifact Context）：请求契约未携带显式资料选择，声明「无选中
      // 成果」——禁止暗中把最近更新的 artifact 替代用户选择。
      activeArtifactIds: [],
    });
    const sources: OutcomeSource[] = [
      { kind: 'outcome_version', id: detail.outcome.id, version: detail.version.version, label: `${detail.outcome.title} v${detail.version.version}` },
      { kind: 'artifact', id: this.options.skill.id, label: `PPT 生成技能：${this.options.skill.name}` },
      ...(this.options.template ? [{ kind: 'artifact' as const, id: this.options.template.id, label: `PPT 模板：${this.options.template.name}` }] : []),
      ...projectContext.sources,
    ];
    const history = this.options.repository.listConversation({ projectId: request.projectId, scope: 'outcome', outcomeId: request.outcomeId, scenarioId: null });
    const userMessage = this.options.repository.appendConversation({ projectId: request.projectId, scope: 'outcome', outcomeId: request.outcomeId, scenarioId: null, role: 'user', content: request.instruction, sources });
    // zone 版式引擎协议（2026-09-01 融入 wut-ppt 方法论）：模型只产出大纲 JSON，
    // 版式由 ZoneLayoutEngine 确定性渲染并机器自检——版式质量不再是模型运气。
    const zoneEngine = this.options.skill.layoutEngine === 'zone';
    const themeProfile = getPptThemeProfile(this.options.skill.themeProfileId);
    // 成果提示词工程(任务4):行为段支持用户 Override(版式协议与源文档注入保持系统控制)。
    const generationBehavior = this.options.resolveBehaviorPrompt?.('presentation.generation', request.outcomeId) ?? null;
    const globalStylePrompt = this.options.getGlobalPrompt?.('ppt', request.outcomeId) ?? null;
    const zoneBehaviorLines = generationBehavior
      ? generationBehavior.split('\n').filter((line) => line.trim().length > 0)
      : [
          '你是 METIS PPT 大纲设计师（zone 版式体系）。把源文档的要点组织为大纲 JSON；版式由引擎渲染，你不需要描述颜色与坐标。',
          '不能使用未给出的资料、图片、数据、模板资产或外部来源；不要调用工具。',
        ];
    const systemPrompt = zoneEngine
      ? [
          ...zoneBehaviorLines,
          `当前成果：${detail.outcome.title}；当前不可覆盖版本：v${detail.version.version}。`,
          `生成技能：${JSON.stringify(this.options.skill)}。`,
          `主题风格：${themeProfile.name}（主色 ${themeProfile.colors.primary}、点缀 ${themeProfile.colors.accent}、强调 ${themeProfile.colors.emphasis}）。`,
          `用户生成要求：${request.instruction}`,
          '必须只输出一个 JSON 对象，不能使用 Markdown 代码围栏：',
          '{"answer":"给用户的中文生成说明","outline":{"title":"封面主标题","speaker":"汇报人","chapters":[{"name":"章节名","pages":[{"title":"页面标题","zones":[zone 列表]}]}],"closing":{"line1":"以上汇报，敬请批评指正","line2":"汇报人：xxx"}}}',
          ...((globalStylePrompt ?? '').trim() ? [`【内容规范·全局风格（本 Profile 全部动作共同遵守）】
${(globalStylePrompt ?? '').trim()}`] : []),
          outlineContractPrompt(themeProfile),
          `当前 PPT 文档 JSON（现状）：\n${serializeDocument(detail.version.content)}`,
          projectContext.prompt,
        ].filter(Boolean).join('\n')
      : (this.options.resolveBehaviorPrompt?.('presentation.generation', request.outcomeId)
          ? [
              this.options.resolveBehaviorPrompt('presentation.generation', request.outcomeId)!,
              `当前成果：${detail.outcome.title}；当前不可覆盖版本：v${detail.version.version}。`,
              `生成技能：${JSON.stringify(this.options.skill)}。`,
              `用户生成要求：${request.instruction}`,
              this.options.template ? `当前模板：${this.options.template.name}。` : '',
              `当前 PPT 文档 JSON（现状）：\n${serializeDocument(detail.version.content)}`,
              projectContext.prompt,
            ].filter(Boolean).join('\n')
          : prompt({ title: detail.outcome.title, version: detail.version.version, document: detail.version.content, skill: this.options.skill, template: this.options.template, instruction: request.instruction, historyTruncated: history.length > MAX_HISTORY_MESSAGES, projectContext }));
    const response = await runEphemeralChatTurn({
      agentLoop: this.options.agentLoop,
      sessionId: `outcome-ppt-generation-${randomUUID()}`,
      requestId: `outcome-ppt-generation-${randomUUID()}`,
      maxTurns: 1,
      allowedTools: [],
      projectId: request.projectId,
      ...(this.options.providerProfileBinding ? { providerProfileBinding: this.options.providerProfileBinding } : {}),
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      messages: [...asPromptMessages(history), { role: 'user', content: request.instruction }],
      skillPrompt: systemPrompt,
    });
    if (response.status === 'cancelled') return this.result({ status: 'cancelled', code: 'agent_cancelled', message: 'PPT Generation Skill 已取消；你的要求已保存在成果协同历史中。', answer: '', sources, diagnostics: [diagnostic('agent_cancelled', '模型运行在生成 PPT patch 前被取消。')], userMessage });
    if (response.status !== 'completed') return this.result({ status: 'error', code: 'agent_error', message: 'PPT Generation Skill 未能完成模型调用；请检查模型配置后重试。', answer: '', sources, diagnostics: [diagnostic('agent_error', `模型运行状态：${response.status}。`)], userMessage });
    if (!response.answer.trim()) return this.result({ status: 'error', code: 'model_response_empty', message: '模型没有返回可用的 PPT 生成结果；请重试。', answer: '', sources, diagnostics: [diagnostic('model_response_empty', '模型运行完成但没有返回内容。')], userMessage });
    if (this.options.isRuntimeCurrent && !this.options.isRuntimeCurrent()) return this.result({ status: 'error', code: 'generation_runtime_reconfigured', message: '模型配置已切换，本次 PPT 生成没有写入成果版本；请重新请求。', answer: '', sources, diagnostics: [diagnostic('generation_runtime_reconfigured', 'Provider runtime changed before the generation response could be committed.')], userMessage });
    if (zoneEngine) {
      // zone 协议：解析大纲 JSON → 引擎渲染 → 机器自检 → 组装 patch（复用既有保存链）。
      let outlineJson = response.answer.trim();
      const fenceStart = outlineJson.indexOf('{');
      const fenceEnd = outlineJson.lastIndexOf('}');
      if (fenceStart >= 0 && fenceEnd > fenceStart) outlineJson = outlineJson.slice(fenceStart, fenceEnd + 1);
      let answerText = '已按 zone 版式体系生成演示文稿。';
      let parsedOutline: unknown;
      try {
        const value = JSON.parse(outlineJson) as { answer?: string; outline?: unknown };
        answerText = typeof value.answer === 'string' && value.answer.trim() ? value.answer : answerText;
        parsedOutline = value.outline;
      } catch { parsedOutline = undefined; }
      const outlineParsed = parsedOutline ? OutlineDocumentSchema.safeParse(parsedOutline) : null;
      if (!outlineParsed?.success) return this.result({ status: 'error', code: 'model_response_contract_error', message: '模型大纲未通过 zone 契约校验，成果版本未变更；请重试。', answer: '', sources, diagnostics: [...projectContextDiagnostics(projectContext), diagnostic('model_response_contract_error', '大纲 JSON 不符合 zone 契约。')], userMessage });
      const themeProfileId = themeProfile.id;
      const rendered = renderZoneOutline({ outline: outlineParsed.data, themeId: themeProfileId });
      if (!rendered.ok || !rendered.document) return this.result({ status: 'error', code: 'model_response_contract_error', message: 'zone 版式渲染失败；请调整大纲后重试。', answer: '', sources, diagnostics: [...projectContextDiagnostics(projectContext), diagnostic('model_response_contract_error', '版式引擎渲染失败。')], userMessage });
      const audit = auditZonePages(rendered.document.pages);
      const auditIssues = audit.pages.flatMap((page) => page.issues.map((issue) => `第 ${page.pageIndex + 1} 页：${issue}`));
      const newPages = rendered.document.pages.map((page) => ({
        id: `ppt-page-${randomUUID().slice(0, 8)}`,
        title: page.title,
        pageType: page.pageType,
        humanModified: false,
        status: 'complete' as const,
        elements: page.elements,
      }));
      const saved = this.options.repository.save({ projectId: request.projectId, outcomeId: request.outcomeId, baseVersion: detail.outcome.currentVersion, content: { ...detail.version.content, theme: { ...detail.version.content.theme, primary: themeProfile.colors.primary, accent: themeProfile.colors.accent }, templateId: null, generationSkillId: this.options.skill.id, pages: [...detail.version.content.pages, ...newPages] }, note: 'zone 版式引擎生成', actor: 'ai', sources });
      const assistantMessage = this.options.repository.appendConversation({ projectId: request.projectId, scope: 'outcome', outcomeId: request.outcomeId, scenarioId: null, role: 'assistant', content: answerText, sources });
      return this.result({ status: 'completed', model: this.options.modelName, answer: answerText + (auditIssues.length > 0 ? `（自检提示：${auditIssues.slice(0, 3).join('；')}）` : '（机器自检通过）'), userMessage, assistantMessage, sources, diagnostics: projectContextDiagnostics(projectContext), applied: { outcome: saved.outcome, version: saved.version, patch: { replacePages: [], appendPages: newPages, theme: { primary: themeProfile.colors.primary, accent: themeProfile.colors.accent }, note: 'zone 版式引擎生成' }, skill: this.options.skill, template: null } });
    }
    const model = parseModelResponse(response.answer);
    if (!model.value) return this.result({ status: 'error', code: 'model_response_contract_error', message: '模型没有返回可应用的 PPT patch，成果版本未变更。', answer: '', sources, diagnostics: [model.error ?? diagnostic('model_response_contract_error', 'PPT patch 解析失败。')], userMessage });
    const candidate = applyPatch(detail.version.content, model.value.patch, this.options.skill, this.options.template);
    if (!candidate.content) return this.result({ status: 'error', code: candidate.diagnostic?.code ?? 'model_response_contract_error', message: '模型 PPT patch 无法安全应用，成果版本未变更。', answer: '', sources, diagnostics: [candidate.diagnostic ?? diagnostic('model_response_contract_error', 'PPT patch 应用失败。')], userMessage });
    if (this.options.isRuntimeCurrent && !this.options.isRuntimeCurrent()) return this.result({ status: 'error', code: 'generation_runtime_reconfigured', message: '模型配置已切换，本次 PPT 生成没有写入成果版本；请重新请求。', answer: '', sources, diagnostics: [diagnostic('generation_runtime_reconfigured', 'Provider runtime changed before the generation patch could be committed.')], userMessage });
    try {
      const saved = this.options.repository.save({ projectId: request.projectId, outcomeId: request.outcomeId, baseVersion: detail.outcome.currentVersion, content: candidate.content, note: model.value.patch.note, actor: 'ai', sources });
      const assistantMessage = this.options.repository.appendConversation({ projectId: request.projectId, scope: 'outcome', outcomeId: request.outcomeId, scenarioId: null, role: 'assistant', content: model.value.answer, sources });
      return this.result({ status: 'completed', model: this.options.modelName, answer: model.value.answer, userMessage, assistantMessage, sources, diagnostics: projectContextDiagnostics(projectContext), applied: { outcome: saved.outcome, version: saved.version, patch: model.value.patch, skill: this.options.skill, template: this.options.template } });
    } catch (error) {
      const conflict = error instanceof Error && error.message === 'outcome_version_conflict';
      return this.result({ status: 'error', code: conflict ? 'outcome_version_conflict' : 'agent_error', message: conflict ? '人工编辑已产生新版本，PPT 生成未覆盖，请基于最新版本重新请求。' : 'PPT 生成版本无法保存，请重试。', answer: '', sources, diagnostics: [diagnostic(conflict ? 'outcome_version_conflict' : 'agent_error', conflict ? '保存时发现版本冲突。' : '保存 AI PPT 版本失败。')], userMessage });
    }
  }
}
