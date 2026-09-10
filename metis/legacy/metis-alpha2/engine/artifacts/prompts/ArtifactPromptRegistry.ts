/**
 * 成果提示词工程 — Artifact Prompt Registry(2026-09-05 刘总要求,任务4)。
 *
 * 把 METIS 成果 AI 中真正控制"怎么生成/修改/组织/表达/审查"的行为级 Prompt
 * 系统化注册,允许用户长期自定义(User Override),同时保持:
 * - defaultPrompt = METIS 出厂行为,永不被用户覆盖删除(恢复默认永远可用);
 * - Runtime Contract(Tool/Schema/文件协议/编辑协议 JSON)不在注册范围,
 *   永不接受用户编辑;
 * - 每个暴露的 prompt 都有真实 Runtime Consumer(双向审计,禁止假配置)。
 *
 * 真实 Consumer Map(审计 2026-09-05):
 * - outcome.assistant      → electron/OutcomeAssistantService.ts assistantPrompt()
 * - presentation.generation→ electron/OutcomePptGenerationService.ts(zone+legacy 两分支)
 * - image.generation       → electron/OutcomeImageService.ts prompt 组装(前置行为段)
 * - document.cover_letter  → electron/CoverLetterService.ts skillPrompt 行为段
 */

export interface ArtifactPromptDefinition {
  id: string;
  name: string;
  description: string;
  category: 'general' | 'document' | 'presentation' | 'figure' | 'spreadsheet' | 'other';
  action: string;
  defaultPrompt: string;
  /** 影响范围说明(帮助用户知道该改什么、不该改什么)。 */
  scopeNote: string;
  editable: boolean;
  version: number;
}

export const ARTIFACT_PROMPT_DEFINITIONS: readonly ArtifactPromptDefinition[] = [
  {
    id: 'outcome.assistant',
    name: '成果协同助手',
    description: '控制成果详情页 AI 助手在 Word/PPT 成果上对话、解释、修改时的工作方式(角色、修改原则、表达方式)。',
    category: 'general',
    action: 'outcomes:assistant:chat',
    defaultPrompt: [
      '你是 METIS 成果协同助手,帮助用户理解和修改当前成果(Word 文档或 PPT 演示)。',
      '回答使用与成果一致的语言;解释修改时先说清改动意图,再执行修改。',
      '修改学术文本时保持原有论证结构与核心判断;除非用户明确要求,不主动删除引用或压缩有效内容。',
    ].join('\n'),
    scopeNote: '只影响助手的行为方式;不影响编辑协议(返回 JSON 的结构)、文档内容注入与项目上下文。',
    editable: true,
    version: 1,
  },
  {
    id: 'presentation.generation',
    name: 'PPT 生成',
    description: '控制 PPT 生成时的设计原则:叙事方式、页面组织、信息密度偏好与表达风格。',
    category: 'presentation',
    action: 'outcomes:ppt:generation:execute',
    defaultPrompt: [
      '你是 METIS PPT 大纲设计师。根据源文档要点组织演示内容。',
      '不能使用未给出的资料、图片、数据、模板资产或外部来源。',
      '页面组织优先服务叙事逻辑;每页内容保持清晰的信息层次。',
    ].join('\n'),
    scopeNote: '只影响生成时的设计原则;版式协议(JSON 输出结构)、主题参数与源文档注入保持系统控制。',
    editable: true,
    version: 1,
  },
  {
    id: 'image.generation',
    name: '科研绘图',
    description: '生成图片/科研绘图时前置的行为规范:图形表达原则、学术风格要求。留空表示不附加规范。',
    category: 'figure',
    action: 'outcomes:image:generate',
    defaultPrompt: '',
    scopeNote: '作为绘图提示词的前置规范;不影响用户输入的绘图内容本身,也不影响模型与画质参数。',
    editable: true,
    version: 1,
  },
  {
    id: 'document.cover_letter',
    name: '投稿信(Cover Letter)',
    description: '控制投稿信生成助手的写作方式:语气、结构重点、事实约束的表达方式。',
    category: 'document',
    action: 'submissions:coverLetter:generate',
    defaultPrompt: [
      '你是 METIS 投稿信写作助手,为论文投稿生成得体的 Cover Letter。',
      '语气专业、克制、直接;突出研究的核心贡献与目标期刊的适配点。',
      '只使用提供的事实占位内容,不编造数据、成果或审稿人偏好。',
    ].join('\n'),
    scopeNote: '只影响写作行为;事实占位结构、收件人字段与提交包登记保持系统控制。',
    editable: true,
    version: 1,
  },
];

export function getArtifactPromptDefinition(id: string): ArtifactPromptDefinition | undefined {
  return ARTIFACT_PROMPT_DEFINITIONS.find((definition) => definition.id === id);
}

/** Import/Export 包契约(v2 04 第二十六节:不含 API Key/项目数据/成果内容)。 */
export interface ArtifactPromptPack {
  schemaVersion: 1;
  createdAt: number;
  prompts: Array<{
    promptId: string;
    content: string;
    baseVersion: number;
    enabled: boolean;
  }>;
}
