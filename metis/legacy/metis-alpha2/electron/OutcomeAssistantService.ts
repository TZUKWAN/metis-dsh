import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatMessage } from '../engine/core/types.js';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import {
  OutcomeAssistantChatRequestSchema,
  OutcomeAssistantChatResultSchema,
  OutcomeAssistantModelResponseSchema,
  OutcomeDocumentSchema,
  type OutcomeAssistantChatRequest,
  type OutcomeAssistantChatResult,
  type OutcomeAssistantDiagnostic,
  type OutcomeAssistantEdit,
  type OutcomeDocument,
  type OutcomeSource,
  type ScopedConversationMessage,
} from '../engine/runtime/OutcomeRuntimeContract.js';
import type { ProviderProfileBinding } from '../engine/runtime/ProviderProfileContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import { OutcomeRepository } from './OutcomeRepository.js';
import { OutcomeProjectContextService, type OutcomeProjectContext } from './OutcomeProjectContextService.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_DOCUMENT_CONTEXT_CHARS = 90_000;
const EDITABLE_WORD_BLOCKS = new Set([
  'paragraph',
  'heading',
  'figure_caption',
  'table_caption',
]);

type AssistantRunner = Pick<AgentLoop, 'run'>;

export interface OutcomeAssistantServiceOptions {
  repository: OutcomeRepository;
  agentLoop: AssistantRunner;
  modelName: string;
  /** Credential-free routing receipt resolved by the main-process provider resolver. */
  providerProfileBinding?: ProviderProfileBinding;
  /** Optional injection point for a project-context reader; production uses the DB-backed default. */
  projectContext?: Pick<OutcomeProjectContextService, 'collect'>;
  /** Stops a stale provider runtime from committing an AI version after a profile switch. */
  isRuntimeCurrent?: () => boolean;
  /** Cooperative cancellation owned by the main-process shutdown coordinator. */
  signal?: AbortSignal;
  /** 成果提示词工程(任务4):行为段 Override 解析。 */
  resolveBehaviorPrompt?: (promptId: string, outcomeId?: string | null) => string | null;
  getGlobalPrompt?: (officeKind: string, outcomeId?: string | null) => string | null;
}

interface ResolvedSelection {
  source: OutcomeSource;
  prompt: string;
  /** Present only after the persisted PPT element has been located. */
  pptElement?: { pageId: string; elementId: string };
}

function diagnostic(
  code: OutcomeAssistantDiagnostic['code'],
  message: string,
): OutcomeAssistantDiagnostic {
  return { code, message };
}

function serializeDocument(document: OutcomeDocument): string {
  const serialized = JSON.stringify(document);
  if (serialized.length <= MAX_DOCUMENT_CONTEXT_CHARS) return serialized;
  return `${serialized.slice(0, MAX_DOCUMENT_CONTEXT_CHARS)}\n[文档内容因模型上下文上限被截断；未展示部分不可作为修改依据。]`;
}

function asPromptMessages(messages: ScopedConversationMessage[]): ChatMessage[] {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  return recent.map((message) => ({ role: message.role, content: message.content }));
}

function resolveSelection(
  document: OutcomeDocument,
  selection: OutcomeAssistantChatRequest['selection'],
): ResolvedSelection | undefined {
  if (!selection) return undefined;
  if (selection.type === 'word_table_cell') {
    if (document.type !== 'word') throw new Error('edit_document_kind_mismatch');
    const block = document.blocks.find((item) => item.id === selection.blockId);
    if (!block || block.kind !== 'table') throw new Error('edit_target_not_found');
    const cell = block.rows?.[selection.row]?.[selection.column];
    if (cell === undefined) throw new Error('edit_target_not_found');
    const start = selection.start ?? 0;
    const end = selection.end ?? cell.length;
    if (start > end || end > cell.length) throw new Error('invalid_selection');
    return {
      source: { kind: 'selection', id: block.id, label: `当前 Word 表格单元格选区：${cell.slice(start, Math.min(end, start + 120)) || '空单元格'}` },
      prompt: [
        `当前选区（Word 表格 block ${block.id}，第 ${selection.row + 1} 行第 ${selection.column + 1} 列单元格，字符 ${start}-${end}）：`,
        cell.slice(start, end),
        `若输出 Word edit 修改该单元格，replacement 必须写作 {"blockId":"${block.id}","row":${selection.row},"column":${selection.column},"text":"替换后的完整单元格文本"}；不得用整段替换或修改其他单元格。`,
      ].join('\n'),
    };
  }
  if (selection.type === 'word_block') {
    if (document.type !== 'word') throw new Error('edit_document_kind_mismatch');
    const block = document.blocks.find((item) => item.id === selection.blockId);
    if (!block) throw new Error('edit_target_not_found');
    const content = block.text ?? (block.rows ? JSON.stringify(block.rows) : '');
    const start = selection.start ?? 0;
    const end = selection.end ?? content.length;
    if (start > end || end > content.length) throw new Error('invalid_selection');
    return {
      source: { kind: 'selection', id: block.id, label: `当前 Word 选区：${block.text?.slice(start, Math.min(end, start + 120)) || block.kind}` },
      prompt: `当前选区（Word block ${block.id}，字符 ${start}-${end}）：\n${content.slice(start, end)}`,
    };
  }
  if (document.type !== 'ppt') throw new Error('edit_document_kind_mismatch');
  const page = document.pages.find((item) => item.id === selection.pageId);
  if (!page) throw new Error('edit_target_not_found');
  if (selection.type === 'ppt_element') {
    const matches = page.elements.filter((item) => item.id === selection.elementId);
    if (matches.length === 0) throw new Error('edit_target_not_found');
    if (matches.length !== 1) throw new Error('invalid_selection');
    const [element] = matches;
    const text = typeof element.props.text === 'string' ? `：${element.props.text.slice(0, 80)}` : '';
    return {
      source: { kind: 'selection', id: element.id, label: `当前 PPT 元素（${page.title.slice(0, 280)}）：${element.type}${text}` },
      prompt: [
        `当前选区（PPT page ${page.id}，element ${element.id}）：`,
        JSON.stringify({ pageId: page.id, pageTitle: page.title, element }),
        '这是当前版本中实际选中的单个元素。若输出 PPT edit，只能在同一页面保留其余元素不变并修改此 elementId；不得替换整页或修改标题。',
      ].join('\n'),
      pptElement: { pageId: page.id, elementId: element.id },
    };
  }
  return {
    source: { kind: 'selection', id: page.id, label: `当前 PPT 页面：${page.title.slice(0, 480)}` },
    prompt: `当前选区（PPT page ${page.id}）：\n${JSON.stringify(page)}`,
  };
}

function applyEdit(
  document: OutcomeDocument,
  edit: OutcomeAssistantEdit,
  selection?: ResolvedSelection,
): {
  content?: OutcomeDocument;
  diagnostic?: OutcomeAssistantDiagnostic;
} {
  if (edit.kind === 'word') {
    if (document.type !== 'word') {
      return { diagnostic: diagnostic('edit_document_kind_mismatch', '当前成果不是 Word，无法应用 Word 修改。') };
    }
    const seen = new Set<string>();
    for (const replacement of edit.replacements) {
      const isCell = replacement.row !== undefined || replacement.column !== undefined;
      const key = isCell ? `${replacement.blockId}#${String(replacement.row)}:${String(replacement.column)}` : replacement.blockId;
      if (seen.has(key)) {
        return { diagnostic: diagnostic('edit_target_unsupported', 'AI 修改中包含重复的 Word 段落目标，未应用。') };
      }
      seen.add(key);
      const target = document.blocks.find((block) => block.id === replacement.blockId);
      if (!target) {
        return { diagnostic: diagnostic('edit_target_not_found', 'AI 修改所指向的 Word 段落已不存在，未应用。') };
      }
      if (isCell) {
        // 单元格替换：目标必须是表格块，且行列坐标必须真实存在。
        if (replacement.row === undefined || replacement.column === undefined) {
          return { diagnostic: diagnostic('edit_target_unsupported', 'AI 表格单元格修改缺少完整行列坐标，未应用。') };
        }
        if (target.kind !== 'table' || target.rows?.[replacement.row]?.[replacement.column] === undefined) {
          return { diagnostic: diagnostic('edit_target_not_found', 'AI 修改所指向的表格单元格已不存在，未应用。') };
        }
        continue;
      }
      if (!EDITABLE_WORD_BLOCKS.has(target.kind)) {
        return { diagnostic: diagnostic('edit_target_unsupported', 'AI 只能直接改写正文、标题或图表题注，未应用表格/图片修改。') };
      }
    }
    const replacementMap = new Map(edit.replacements.filter((replacement) => replacement.row === undefined && replacement.column === undefined).map((replacement) => [replacement.blockId, replacement]));
    const candidate = {
      ...document,
      blocks: document.blocks.map((block) => {
        if (block.kind === 'table') {
          // 表格块只接受带完整行列坐标的单元格替换；整表替换不被支持。
          const cellReplacements = edit.replacements.filter((item) => item.blockId === block.id && item.row !== undefined && item.column !== undefined);
          if (cellReplacements.length === 0) return block;
          const rows = (block.rows ?? []).map((row, rowIndex) => row.map((cell, columnIndex) => {
            const replacement = cellReplacements.find((item) => item.row === rowIndex && item.column === columnIndex);
            return replacement ? replacement.text : cell;
          }));
          return { ...block, rows };
        }
        const replacement = replacementMap.get(block.id);
        if (!replacement) return block;
        return {
          ...block,
          text: replacement.text,
          ...(replacement.style ? { style: { ...(block.style ?? {}), ...replacement.style } } : {}),
        };
      }),
    };
    const decoded = OutcomeDocumentSchema.safeParse(candidate);
    return decoded.success
      ? { content: decoded.data }
      : { diagnostic: diagnostic('model_response_contract_error', 'AI 修改未通过成果文档约束，未应用。') };
  }

  if (document.type !== 'ppt') {
    return { diagnostic: diagnostic('edit_document_kind_mismatch', '当前成果不是 PPT，无法应用 PPT 修改。') };
  }
  const page = document.pages.find((item) => item.id === edit.replacePage.pageId);
  if (!page) {
    return { diagnostic: diagnostic('edit_target_not_found', 'AI 修改所指向的 PPT 页面已不存在，未应用。') };
  }
  if (selection?.pptElement) {
    if (page.id !== selection.pptElement.pageId) {
      return { diagnostic: diagnostic('edit_target_not_found', 'AI 修改指向的页面不是当前选中的 PPT 元素所在页面，未应用。') };
    }
    const selected = page.elements.find((element) => element.id === selection.pptElement?.elementId);
    if (!selected) {
      return { diagnostic: diagnostic('edit_target_not_found', '当前选中的 PPT 元素已不存在，未应用。') };
    }
    if (selected.locked) {
      return { diagnostic: diagnostic('edit_target_unsupported', '当前选中的 PPT 元素已锁定，AI 不能直接修改。') };
    }
    const proposed = edit.replacePage.elements;
    if (edit.replacePage.title !== undefined || !proposed) {
      return { diagnostic: diagnostic('edit_target_unsupported', '选择单个 PPT 元素时，AI 只能提交该元素的局部修改，不能替换页面标题或整页内容。') };
    }
    if (proposed.length !== page.elements.length) {
      return { diagnostic: diagnostic('edit_target_unsupported', '选择单个 PPT 元素时，AI 不得增删页面元素，未应用。') };
    }
    let changedSelected = false;
    for (let index = 0; index < page.elements.length; index += 1) {
      const existing = page.elements[index];
      const replacement = proposed[index];
      if (!replacement || replacement.id !== existing.id) {
        return { diagnostic: diagnostic('edit_target_unsupported', '选择单个 PPT 元素时，AI 不得改变页面元素的标识或顺序，未应用。') };
      }
      if (existing.id !== selected.id) {
        if (!isDeepStrictEqual(existing, replacement)) {
          return { diagnostic: diagnostic('edit_target_unsupported', 'AI 修改包含未选中的 PPT 元素，未应用。') };
        }
        continue;
      }
      if (replacement.type !== existing.type) {
        return { diagnostic: diagnostic('edit_target_unsupported', 'AI 不能将当前选中的 PPT 元素替换为其他类型，未应用。') };
      }
      changedSelected = !isDeepStrictEqual(existing, replacement);
    }
    if (!changedSelected) {
      return { diagnostic: diagnostic('edit_target_unsupported', 'AI 未对当前选中的 PPT 元素提交实际修改，未创建空版本。') };
    }
  }
  const candidate = {
    ...document,
    pages: document.pages.map((item) => item.id === page.id
      ? {
          ...item,
          ...(edit.replacePage.title === undefined ? {} : { title: edit.replacePage.title }),
          ...(edit.replacePage.elements === undefined ? {} : { elements: edit.replacePage.elements }),
          humanModified: true,
        }
      : item),
  };
  const decoded = OutcomeDocumentSchema.safeParse(candidate);
  return decoded.success
    ? { content: decoded.data }
    : { diagnostic: diagnostic('model_response_contract_error', 'AI 修改未通过 PPT Grid 文档约束，未应用。') };
}

/**
 * 从模型输出中提取顶层 JSON 对象候选：现实里推理型模型经常先输出一段思考、
 * 再输出协议 JSON（或 JSON 前后带说明文字）。按花括号配平扫描（跳过字符串
 * 字面量与转义）找出所有候选，调用方从后往前逐个尝试解析。
 */
const BS_VAL = String.fromCharCode(92);

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === BS_VAL) escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }
  return candidates;
}

function answerFromModel(raw: string): { answer: string; edit: OutcomeAssistantEdit | null; diagnostic?: OutcomeAssistantDiagnostic } {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  let value: unknown;
  try {
    value = JSON.parse(withoutFence);
  } catch {
    // 混合输出（思考过程 + 协议 JSON）：剥掉推理标签后按候选逐个尝试；
    // 从最后一个候选往前，因为结论性 JSON 通常在思考之后。
    const visible = raw
      .replace(/<[\s\S]*?>/gu, '')
      .trim();
    const candidates = extractJsonObjectCandidates(visible);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      try {
        const candidate = JSON.parse(candidates[index]!);
        const parsed = OutcomeAssistantModelResponseSchema.safeParse(candidate);
        if (parsed.success && parsed.data.edit) {
          const prose = visible.replace(candidates[index]!, ' ').replace(/\s+/gu, ' ').trim();
          return { answer: parsed.data.answer || prose.slice(0, 400), edit: parsed.data.edit };
        }
        // 近似协议（edit 为空或字段不合 schema）也至少把 answer 摘出来，
        // 否则候选 JSON 会原样残留在正文里显示为乱码。
        const loose = candidate as { answer?: unknown };
        if (typeof loose?.answer === 'string' && loose.answer.trim()) {
          const prose = visible.replace(candidates[index]!, ' ').replace(/\s+/gu, ' ').trim();
          return {
            answer: loose.answer.trim() || prose.slice(0, 400),
            edit: null,
            diagnostic: diagnostic('model_response_not_structured', '模型返回了回答，但没有按编辑协议提交修改，成果内容未变。'),
          };
        }
      } catch { /* try next candidate */ }
    }
    // 真的没有可应用的编辑：回答截断到弹窗可读长度，避免把整段推理塞进局部编辑弹窗。
    const clipped = visible.length > 600 ? `${visible.slice(0, 600)}…（回答过长已截断；本次没有产生可应用的修改）` : visible;
    const rawAnswer = OutcomeAssistantModelResponseSchema.safeParse({ answer: clipped, edit: null });
    return {
      answer: rawAnswer.success ? clipped : '',
      edit: null,
      diagnostic: diagnostic(
        rawAnswer.success ? 'model_response_not_structured' : 'model_response_contract_error',
        rawAnswer.success ? '模型返回了回答，但没有按编辑协议提交修改，成果内容未变。' : '模型回答包含无法安全呈现的内容，未写入成果历史。',
      ),
    };
  }
  const parsed = OutcomeAssistantModelResponseSchema.safeParse(value);
  if (!parsed.success) {
    // 模型回了近似协议的 JSON（例如 replacements 写成数组对）：把 answer
    // 字段摘出来展示，而不是把整段 JSON 当回答塞进历史。
    const loose = value as { answer?: unknown };
    if (loose && typeof loose === 'object' && typeof loose.answer === 'string' && loose.answer.trim()) {
      return {
        answer: loose.answer.trim(),
        edit: null,
        diagnostic: diagnostic('model_response_contract_error', '模型返回了回答，但修改内容未通过成果协议，成果内容未变。'),
      };
    }
    const clipped = raw.length > 600 ? `${raw.slice(0, 600)}…（回答过长已截断；本次没有产生可应用的修改）` : raw;
    return {
      answer: clipped,
      edit: null,
      diagnostic: diagnostic('model_response_contract_error', '模型返回了真实回答，但编辑内容未通过成果协议，成果内容未变。'),
    };
  }
  return { answer: parsed.data.answer, edit: parsed.data.edit };
}

function assistantPrompt(input: {
  title: string;
  kind: string;
  outcomeId?: string | null;
  currentVersion: number;
  document: OutcomeDocument;
  selection?: ResolvedSelection;
  historyTruncated: boolean;
  projectContext: OutcomeProjectContext;
  /** 成果提示词工程(任务4/5):行为段 Override 解析(带 outcomeId)。 */
  resolveBehaviorPrompt?: (promptId: string, outcomeId?: string | null) => string | null;
  getGlobalPrompt?: (officeKind: string, outcomeId?: string | null) => string | null;
}): string {
  const scope = input.selection
    ? `\n${input.selection.prompt}\n`
    : '\n没有显式选区；如需要直接修改，请使用当前成果中的真实 blockId/pageId。\n';
  // 成果提示词工程(2026-09-05,任务4):行为段支持用户 Override(只替换行为规范,
  // 编辑协议 JSON 与上下文注入保持系统控制)。
  const behaviorPrompt = input.resolveBehaviorPrompt?.('outcome.assistant', input.outcomeId) ?? null;
  const globalPrompt = input.getGlobalPrompt?.('word', input.outcomeId) ?? null;
  const behaviorLines = behaviorPrompt
    ? behaviorPrompt.split('\n').filter((line) => line.trim().length > 0)
    : [
        '你是 METIS 成果协同助手。只根据本提示中提供的当前成果、当前项目内成果协同历史、当前选区和明确列出的项目上下文回答。',
        '不要声称使用了没有提供的文件、资料、联网信息或来源；不要调用工具。',
      ];
  return [
    ...behaviorLines,
    ...((globalPrompt ?? '').trim() ? [`【内容规范·全局风格（本 Profile 全部动作共同遵守）】
${(globalPrompt ?? '').trim()}`] : []),
    `当前成果：${input.title}；类型：${input.kind}；当前版本：v${input.currentVersion}。`,
    input.historyTruncated ? `仅提供最近 ${MAX_HISTORY_MESSAGES} 条成果协同历史；更早历史未被本轮模型读取。` : '已提供全部当前成果协同历史。',
    '必须只输出一个 JSON 对象：',
    '{"answer":"给用户的中文回答","edit":null}',
    '或 Word：{"answer":"...","edit":{"kind":"word","replacements":[{"blockId":"真实段落ID","text":"替换后的完整段落","style":{}}],"note":"简短修改说明"}}',
    'Word 表格单元格：replacements 元素写成 {"blockId":"真实表格ID","row":行号从0起,"column":列号从0起,"text":"替换后的完整单元格文本"}；表格只支持单元格级替换，不支持整表替换。',
    '或 PPT：{"answer":"...","edit":{"kind":"ppt","replacePage":{"pageId":"真实页面ID","title":"可选新标题","elements":[完整元素数组] },"note":"简短修改说明"}}',
    '没有可安全直接应用的修改时 edit 必须为 null。不得给出 Markdown 代码围栏。',
    `当前成果文档 JSON：\n${serializeDocument(input.document)}`,
    input.projectContext.prompt,
    scope,
  ].join('\n');
}

export class OutcomeAssistantService {
  constructor(private readonly options: OutcomeAssistantServiceOptions) {}

  private result(value: OutcomeAssistantChatResult): OutcomeAssistantChatResult {
    return OutcomeAssistantChatResultSchema.parse(value);
  }

  async chat(rawRequest: unknown): Promise<OutcomeAssistantChatResult> {
    const parsedRequest = OutcomeAssistantChatRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success) {
      return this.result({
        status: 'error', code: 'invalid_request', message: '成果助手请求无效。', answer: '', sources: [],
        diagnostics: [diagnostic('invalid_request', '成果助手请求未通过契约校验。')],
      });
    }
    const request = parsedRequest.data;
    const detail = this.options.repository.get(request.projectId, request.outcomeId);
    if (!detail) {
      return this.result({
        status: 'error', code: 'outcome_not_found', message: '当前成果不存在或不属于所选项目。', answer: '', sources: [],
        diagnostics: [diagnostic('outcome_not_found', '未找到当前项目中的成果。')],
      });
    }

    let selection: ResolvedSelection | undefined;
    try {
      selection = resolveSelection(detail.version.content, request.selection);
    } catch (error) {
      const code = error instanceof Error && [
        'invalid_selection', 'edit_document_kind_mismatch', 'edit_target_not_found',
      ].includes(error.message)
        ? error.message as OutcomeAssistantDiagnostic['code']
        : 'invalid_selection';
      return this.result({
        status: 'error', code, message: '当前选区已变化，请重新选择后再试。', answer: '', sources: [],
        diagnostics: [diagnostic(code, '请求中的成果选区无法在当前版本中定位。')],
      });
    }

    const projectContext = (this.options.projectContext ?? new OutcomeProjectContextService(this.options.repository)).collect({
      projectId: request.projectId,
      outcomeId: request.outcomeId,
      instruction: request.instruction,
      // 任务2（Artifact Context）：本入口暂无显式 artifact 选择通道，必须
      // 声明「无选中成果」——禁止暗中把最近更新的 artifact 替代用户选择。
      activeArtifactIds: [],
    });
    const sources: OutcomeSource[] = [
      { kind: 'outcome_version', id: detail.outcome.id, version: detail.version.version, label: `${detail.outcome.title} v${detail.version.version}` },
      ...(selection ? [selection.source] : []),
      ...projectContext.sources,
    ];
    const history = this.options.repository.listConversation({
      projectId: request.projectId,
      scope: 'outcome',
      outcomeId: request.outcomeId,
      scenarioId: null,
    });
    const userMessage = this.options.repository.appendConversation({
      projectId: request.projectId,
      scope: 'outcome',
      outcomeId: request.outcomeId,
      scenarioId: null,
      role: 'user',
      content: request.instruction,
      sources,
    });
    const promptMessages = [
      ...asPromptMessages(history),
      { role: 'user' as const, content: request.instruction },
    ];

    const response = await runEphemeralChatTurn({
      agentLoop: this.options.agentLoop,
      sessionId: `outcome-ai-${randomUUID()}`,
      messages: promptMessages,
      requestId: `outcome-ai-${randomUUID()}`,
      maxTurns: 1,
      allowedTools: [],
      projectId: request.projectId,
      ...(this.options.providerProfileBinding ? { providerProfileBinding: this.options.providerProfileBinding } : {}),
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      skillPrompt: assistantPrompt({
        title: detail.outcome.title,
        kind: detail.outcome.kind,
        outcomeId: detail.outcome.id,
        currentVersion: detail.version.version,
        document: detail.version.content,
        selection,
        historyTruncated: history.length > MAX_HISTORY_MESSAGES,
        projectContext,
        resolveBehaviorPrompt: this.options.resolveBehaviorPrompt,
      }),
    });
    if (response.status === 'cancelled') {
      return this.result({
        status: 'cancelled', code: 'agent_cancelled', message: '成果助手运行已取消；你的指令已保存在成果协同历史中。', answer: '', sources,
        diagnostics: [...projectContext.diagnostics, diagnostic('agent_cancelled', '模型运行在产生回答前被取消。')], userMessage,
      });
    }
    if (response.status !== 'completed') {
      return this.result({
        status: 'error', code: 'agent_error', message: '成果助手未能完成本次模型调用；请检查模型配置后重试。', answer: '', sources,
        diagnostics: [...projectContext.diagnostics, diagnostic('agent_error', `模型运行状态：${response.status}。`)], userMessage,
      });
    }
    if (!response.answer.trim()) {
      return this.result({
        status: 'error', code: 'model_response_empty', message: '模型没有返回可用回答；请重试。', answer: '', sources,
        diagnostics: [...projectContext.diagnostics, diagnostic('model_response_empty', '模型运行完成但返回了空内容。')], userMessage,
      });
    }
    if (this.options.isRuntimeCurrent && !this.options.isRuntimeCurrent()) {
      return this.result({
        status: 'error', code: 'assistant_runtime_reconfigured', message: '模型配置已切换，本次成果回答未写入；请重新发送。', answer: '', sources,
        diagnostics: [...projectContext.diagnostics, diagnostic('assistant_runtime_reconfigured', 'Provider runtime changed before assistant response could be persisted.')], userMessage,
      });
    }

    const model = answerFromModel(response.answer);
    if (!model.answer.trim()) {
      return this.result({
        status: 'error', code: 'model_response_empty', message: '模型没有返回可展示的成果回答；请重试。', answer: '', sources,
        diagnostics: [...projectContext.diagnostics, diagnostic('model_response_empty', '模型 JSON 回答中的 answer 为空。')], userMessage,
      });
    }
    const assistantMessage = this.options.repository.appendConversation({
      projectId: request.projectId,
      scope: 'outcome',
      outcomeId: request.outcomeId,
      scenarioId: null,
      role: 'assistant',
      content: model.answer,
      sources,
    });
    const diagnostics = [...projectContext.diagnostics, ...(model.diagnostic ? [model.diagnostic] : [])];
    if (!model.edit) {
      return this.result({ status: 'completed', model: this.options.modelName, answer: model.answer, userMessage, assistantMessage, sources, diagnostics });
    }

    const applied = applyEdit(detail.version.content, model.edit, selection);
    if (!applied.content) {
      return this.result({
        status: 'completed', model: this.options.modelName, answer: model.answer, userMessage, assistantMessage, sources,
        diagnostics: [...diagnostics, applied.diagnostic ?? diagnostic('model_response_contract_error', 'AI 修改未能应用。')],
      });
    }
    if (this.options.isRuntimeCurrent && !this.options.isRuntimeCurrent()) {
      return this.result({
        status: 'completed', model: this.options.modelName, answer: model.answer, userMessage, assistantMessage, sources,
        diagnostics: [...diagnostics, diagnostic('assistant_runtime_reconfigured', '模型配置已切换，AI 修改未写入成果版本。')],
      });
    }
    try {
      const saved = this.options.repository.save({
        projectId: request.projectId,
        outcomeId: request.outcomeId,
        baseVersion: detail.outcome.currentVersion,
        content: applied.content,
        note: model.edit.note,
        actor: 'ai',
        sources,
      });
      return this.result({
        status: 'completed', model: this.options.modelName, answer: model.answer, userMessage, assistantMessage, sources, diagnostics,
        applied: { outcome: saved.outcome, version: saved.version, edit: model.edit },
      });
    } catch (error) {
      const conflict = error instanceof Error && error.message === 'outcome_version_conflict';
      return this.result({
        status: 'completed', model: this.options.modelName, answer: model.answer, userMessage, assistantMessage, sources,
        diagnostics: [...diagnostics, diagnostic(conflict ? 'outcome_version_conflict' : 'agent_error', conflict
          ? '人工编辑已产生新版本，AI 修改未覆盖，请基于最新版本重新请求。'
          : 'AI 修改无法保存到成果版本，请重试。')],
      });
    }
  }
}
