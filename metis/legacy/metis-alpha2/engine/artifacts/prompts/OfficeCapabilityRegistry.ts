/**
 * METIS Office Capability Registry(2026-09-05 刘总要求,任务5)。
 *
 * Settings 不再硬编码支持的格式;所有用户可见的 Office 能力列表由本注册表动态生成。
 * 能力分三层如实记录(不伪造):METIS 内编辑器 / Metis Office 外部编辑 / AI Action。
 * 交叉验证结论(审计 2026-09-05):
 * - word/ppt:内编辑器全功能 + 外部编辑 + AI(生成/协同编辑)
 * - spreadsheet:外部编辑(.xlsx/.xlsm),METIS 内无网格编辑器,无 AI Action
 * - pdf:外部编辑 + iframe 预览,无 AI Action
 * - markdown:无独立成果类型——以「材料导入(.md/.markdown) + 研究导出 + 场景交付物
 *   (markdown→word)」形式存在;AI 经研究写作动作间接支持,如实标注
 * - image/chart:文生图(image),chart 无 AI
 */

export type OfficeCapabilityKind = 'word' | 'ppt' | 'spreadsheet' | 'pdf' | 'markdown' | 'image' | 'chart';

export interface OfficeCapabilityDefinition {
  kind: OfficeCapabilityKind;
  label: string;
  labelEn: string;
  extensions: string[];
  /** 用户显示排序(清单顺序即 Settings 顺序)。 */
  order: number;
  editorMode: {
    embedded: boolean;
    external: boolean;
  };
  /** METIS 内自研编辑器(word 编辑器/PPT Studio);spreadsheet/pdf 为 false。 */
  nativeEditor: boolean;
  importable: boolean;
  exportable: boolean;
  /** 真实 AI Action(以代码为准,禁止伪造)。 */
  aiActions: Array<{
    slotId: string;
    label: string;
    description: string;
  }>;
  aiEnabled: boolean;
  /** 无 AI 的格式在 Settings 中如实展示该说明。 */
  aiNote?: string;
}

export const OFFICE_CAPABILITY_DEFINITIONS: readonly OfficeCapabilityDefinition[] = [
  {
    kind: 'word',
    label: 'Word',
    labelEn: 'Word',
    extensions: ['.docx'],
    order: 1,
    editorMode: { embedded: true, external: true },
    nativeEditor: true,
    importable: true,
    exportable: true,
    aiActions: [
      { slotId: 'word.assistant', label: '协同编辑助手', description: '成果页 AI 助手对 Word 内容的解释与修改(段落/表格单元格)。' },
      { slotId: 'word.selection.rewrite', label: '局部改写', description: '选中文本的 AI 改写动作。' },
      { slotId: 'word.selection.compress', label: '局部压缩', description: '选中文本的 AI 压缩动作。' },
      { slotId: 'word.selection.expand', label: '局部扩写', description: '选中文本的 AI 扩写动作。' },
    ],
    aiEnabled: true,
  },
  {
    kind: 'ppt',
    label: 'PPT',
    labelEn: 'Presentation',
    extensions: ['.pptx'],
    order: 2,
    editorMode: { embedded: true, external: true },
    nativeEditor: true,
    importable: true,
    exportable: true,
    aiActions: [
      { slotId: 'ppt.generation', label: 'PPT 生成', description: '根据源文档生成 PPT 大纲与页面内容的设计原则。' },
      { slotId: 'ppt.assistant', label: '协同编辑助手', description: '成果页 AI 助手对 PPT 页面/元素的解释与修改。' },
    ],
    aiEnabled: true,
  },
  {
    kind: 'markdown',
    label: 'Markdown',
    labelEn: 'Markdown',
    extensions: ['.md', '.markdown'],
    order: 3,
    editorMode: { embedded: false, external: false },
    nativeEditor: false,
    importable: true,
    exportable: true,
    aiActions: [
      { slotId: 'markdown.writing', label: '研究写作(间接)', description: '研究动作产出 Markdown 交付物时的写作规范(经场景/研究写作动作生效)。' },
    ],
    aiEnabled: true,
  },
  {
    kind: 'spreadsheet',
    label: 'Spreadsheet',
    labelEn: 'Spreadsheet',
    extensions: ['.xlsx', '.xlsm'],
    order: 4,
    editorMode: { embedded: false, external: true },
    nativeEditor: false,
    importable: false,
    exportable: false,
    aiActions: [],
    aiEnabled: false,
    aiNote: '当前版本表格通过 Metis Office 外部编辑,暂无 AI 生成/修改能力。',
  },
  {
    kind: 'pdf',
    label: 'PDF',
    labelEn: 'PDF',
    extensions: ['.pdf'],
    order: 5,
    editorMode: { embedded: false, external: true },
    nativeEditor: false,
    importable: true,
    exportable: false,
    aiActions: [],
    aiEnabled: false,
    aiNote: '当前版本 PDF 支持预览、Metis Office 编辑与批注阅读,暂无成果级 AI 动作。',
  },
  {
    kind: 'image',
    label: '图片',
    labelEn: 'Image',
    extensions: ['.png', '.jpg', '.jpeg', '.svg'],
    order: 6,
    editorMode: { embedded: false, external: false },
    nativeEditor: false,
    importable: true,
    exportable: true,
    aiActions: [
      { slotId: 'image.generation', label: '科研绘图生成', description: '文生图时的绘图行为规范(前置到绘图提示词)。' },
    ],
    aiEnabled: true,
  },
  {
    kind: 'chart',
    label: '图表',
    labelEn: 'Chart',
    extensions: [],
    order: 7,
    editorMode: { embedded: false, external: false },
    nativeEditor: false,
    importable: false,
    exportable: false,
    aiActions: [],
    aiEnabled: false,
    aiNote: '当前版本图表成果无 AI 动作。',
  },
];

export function getOfficeCapability(kind: string): OfficeCapabilityDefinition | undefined {
  return OFFICE_CAPABILITY_DEFINITIONS.find((definition) => definition.kind === kind);
}

/**
 * Office Prompt Slot → 通用 Registry(任务4)映射。
 * Office slot 是任务4 Registry 的 Office 视图;slot 解析的最终回退是对应通用 prompt。
 */
export const OFFICE_SLOT_TO_BASE_PROMPT: Record<string, string> = {
  'word.assistant': 'outcome.assistant',
  'word.selection.rewrite': 'word.selection.rewrite',
  'word.selection.compress': 'word.selection.compress',
  'word.selection.expand': 'word.selection.expand',
  'ppt.generation': 'presentation.generation',
  'ppt.assistant': 'outcome.assistant',
  'markdown.writing': 'markdown.writing',
  'image.generation': 'image.generation',
};
