/**
 * outcomeBridge.ts — Task 3 §5 preload domain split.
 * Mechanical extraction from electron/preload.ts; method bodies unchanged.
 */

import { ipcRenderer } from 'electron';
import { ImageGenerationSettingsUpdateSchema, OutcomeCategoryCreateSchema, OutcomeCategoryDeleteSchema, OutcomeCategoryRenameSchema, OutcomeCreateRequestSchema, OutcomeFinalRequestSchema, OutcomeGetRequestSchema, OutcomeImageGenerateRequestSchema, OutcomeImageGenerateResultSchema, OutcomeImageSettingsGetResultSchema, OutcomeImageSettingsSaveResultSchema, OutcomeListRequestSchema, OutcomeMediaImportRequestSchema, OutcomeMediaReadRequestSchema, OutcomeMediaSvgExportResultSchema, OutcomeMoveRequestSchema, OutcomePptxExportRequestSchema, OutcomePptxExportResultSchema, OutcomePptxImportCommitRequestSchema, OutcomePptxImportCommitResultSchema, OutcomePptxImportRequestSchema, OutcomePptxImportResultSchema, OutcomeRenameRequestSchema, OutcomeRestoreRequestSchema, OutcomeSaveRequestSchema, OutcomeVersionsRequestSchema, OutcomeWordDocxExportRequestSchema, OutcomeWordDocxExportResultSchema, OutcomeWordDocxImportCommitRequestSchema, OutcomeWordDocxImportCommitResultSchema, OutcomeWordDocxImportRequestSchema, OutcomeWordDocxImportResultSchema, PptGenerationExecuteRequestSchema, PptGenerationResultSchema, PptGenerationSkillSaveRequestSchema, PptTemplateSaveRequestSchema, OutcomeTemplateDefaultGetRequestSchema, OutcomeTemplateDeleteRequestSchema, OutcomeTemplateListRequestSchema, OutcomeTemplateSaveRequestSchema, OutcomeTemplateUpdateRequestSchema, OutcomeDefaultTemplateSetRequestSchema, OutcomeSourceLocateRequestSchema, OutcomeSourceLocateResultSchema, OutcomeTrashListRequestSchema, OutcomeTrashRequestSchema } from '../../engine/runtime/OutcomeRuntimeContract.js';

export const outcomeBridge = {
    // ── Outcomes workbench ──────────────────────────────────
    listOutcomeCategories: () => ipcRenderer.invoke('outcomes:categories:list'),

    createOutcomeCategory: async (raw: unknown) => { const p=OutcomeCategoryCreateSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:categories:create',p.data) : null; },

    renameOutcomeCategory: async (raw: unknown) => { const p=OutcomeCategoryRenameSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:categories:rename',p.data) : null; },

    deleteOutcomeCategory: async (raw: unknown) => { const p=OutcomeCategoryDeleteSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:categories:delete',p.data) : false; },

    listOutcomes: async (raw: unknown) => { const p=OutcomeListRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:list',p.data) : []; },

    getOutcome: async (raw: unknown) => { const p=OutcomeGetRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:get',p.data) : null; },

    listOutcomeVersions: async (raw: unknown) => { const p=OutcomeVersionsRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:versions',p.data) : []; },

    createOutcome: async (raw: unknown) => { const p=OutcomeCreateRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:create',p.data) : null; },

    saveOutcome: async (raw: unknown) => { const p=OutcomeSaveRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:save',p.data) : null; },

    restoreOutcome: async (raw: unknown) => { const p=OutcomeRestoreRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:restore',p.data) : null; },

    renameOutcome: async (raw: unknown) => { const p=OutcomeRenameRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:rename',p.data) : null; },

    moveOutcome: async (raw: unknown) => { const p=OutcomeMoveRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:move',p.data) : null; },

    markOutcomeFinal: async (raw: unknown) => { const p=OutcomeFinalRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:markFinal',p.data) : null; },

    archiveOutcome: async (raw: unknown) => { const p=OutcomeTrashRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:archive',p.data) : false; },

    listOutcomeTrash: async (raw: unknown) => { const p=OutcomeTrashListRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:trash:list',p.data) : []; },

    restoreOutcomeFromTrash: async (raw: unknown) => { const p=OutcomeTrashRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:trash:restore',p.data) : false; },

    deleteOutcomePermanent: async (raw: unknown) => { const p=OutcomeTrashRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:delete',p.data) : false; },

    locateOutcomeSource: async (raw: unknown) => { const p=OutcomeSourceLocateRequestSchema.safeParse(raw); if(!p.success) return OutcomeSourceLocateResultSchema.parse({ ok:false, code:'invalid_request' }); const result=OutcomeSourceLocateResultSchema.safeParse(await ipcRenderer.invoke('outcomes:source:locate',p.data)); return result.success ? result.data : OutcomeSourceLocateResultSchema.parse({ ok:false, code:'source_not_found' }); },

    savePptTemplate: async (raw: unknown) => { const p=PptTemplateSaveRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template:save',p.data) : null; },

    listPptTemplates: () => ipcRenderer.invoke('outcomes:template:list'),

    listOutcomeTemplates: async (raw: unknown) => { const p=OutcomeTemplateListRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template:listByKind',p.data) : []; },

    saveOutcomeTemplate: async (raw: unknown) => { const p=OutcomeTemplateSaveRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template:saveUnified',p.data) : null; },

    updateOutcomeTemplate: async (raw: unknown) => { const p=OutcomeTemplateUpdateRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template:update',p.data) : null; },

    deleteOutcomeTemplate: async (raw: unknown) => { const p=OutcomeTemplateDeleteRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template:delete',p.data) : false; },

    getDefaultOutcomeTemplate: async (raw: unknown) => { const p=OutcomeTemplateDefaultGetRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template-defaults:get',p.data) : null; },

    setDefaultOutcomeTemplate: async (raw: unknown) => { const p=OutcomeDefaultTemplateSetRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:template-defaults:set',p.data) : false; },

    savePptGenerationSkill: async (raw: unknown) => { const p=PptGenerationSkillSaveRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:generation-skill:save',p.data) : null; },

    listPptGenerationSkills: () => ipcRenderer.invoke('outcomes:generation-skill:list'),

    executeOutcomePptGeneration: async (raw: unknown) => { const p=PptGenerationExecuteRequestSchema.safeParse(raw); if (!p.success) return PptGenerationResultSchema.parse({ status:'error', code:'invalid_request', message:'PPT 生成请求无效。', answer:'', sources:[], diagnostics:[{code:'invalid_request',message:'请求未通过 PPT Generation Skill 契约校验。'}] }); const result=PptGenerationResultSchema.safeParse(await ipcRenderer.invoke('outcomes:ppt:generation:execute',p.data)); return result.success ? result.data : PptGenerationResultSchema.parse({ status:'error', code:'generation_unavailable', message:'PPT 生成响应无效，请重试。', answer:'', sources:[], diagnostics:[{code:'generation_unavailable',message:'主进程返回了无效的 PPT 生成响应。'}] }); },

    importOutcomeMedia: async (raw: unknown) => { const p=OutcomeMediaImportRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:media:import',p.data) : null; },

    readOutcomeMedia: async (raw: unknown) => { const p=OutcomeMediaReadRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:media:read',p.data) : null; },

    exportOutcomeMediaSvg: async (raw: unknown) => { const p=OutcomeMediaReadRequestSchema.safeParse(raw); if (!p.success) return OutcomeMediaSvgExportResultSchema.parse({ ok:false, code:'invalid_request', message:'SVG 导出请求无效。' }); const result=OutcomeMediaSvgExportResultSchema.safeParse(await ipcRenderer.invoke('outcomes:media:export-svg',p.data)); return result.success ? result.data : OutcomeMediaSvgExportResultSchema.parse({ ok:false, code:'svg_write_failed', message:'SVG 导出响应无效。' }); },

    importOutcomeWordDocx: async (raw: unknown) => { const p=OutcomeWordDocxImportRequestSchema.safeParse(raw); if (!p.success) return OutcomeWordDocxImportResultSchema.parse({ ok:false, code:'invalid_request', message:'DOCX 导入请求无效。', warnings:[] }); const result=OutcomeWordDocxImportResultSchema.safeParse(await ipcRenderer.invoke('outcomes:word:docx:import',p.data)); return result.success ? result.data : OutcomeWordDocxImportResultSchema.parse({ ok:false, code:'docx_read_failed', message:'DOCX 导入响应无效。', warnings:[] }); },

    commitOutcomeWordDocxImportMedia: async (raw: unknown) => { const p=OutcomeWordDocxImportCommitRequestSchema.safeParse(raw); if (!p.success) return OutcomeWordDocxImportCommitResultSchema.parse({ ok:false, code:'invalid_request', message:'DOCX 导入媒体提交请求无效。' }); const result=OutcomeWordDocxImportCommitResultSchema.safeParse(await ipcRenderer.invoke('outcomes:word:docx:import:commitMedia',p.data)); return result.success ? result.data : OutcomeWordDocxImportCommitResultSchema.parse({ ok:false, code:'docx_media_commit_failed', message:'DOCX 导入媒体提交响应无效。' }); },

    exportOutcomeWordDocx: async (raw: unknown) => { const p=OutcomeWordDocxExportRequestSchema.safeParse(raw); if (!p.success) return OutcomeWordDocxExportResultSchema.parse({ ok:false, code:'invalid_request', message:'DOCX 导出请求无效。', warnings:[] }); const result=OutcomeWordDocxExportResultSchema.safeParse(await ipcRenderer.invoke('outcomes:word:docx:export',p.data)); return result.success ? result.data : OutcomeWordDocxExportResultSchema.parse({ ok:false, code:'docx_write_failed', message:'DOCX 导出响应无效。', warnings:[] }); },
    // 预览栏「导出为 Word」（2026-08-31）：预览 Markdown 直接转 DOCX，无需先建成果。

    // 预览栏「导出为 Word」（2026-08-31）：预览 Markdown 直接转 DOCX，无需先建成果。
    exportMarkdownAsDocx: async (request: { title: string; markdown: string }) =>
      ipcRenderer.invoke('outcomes:word:docx:exportMarkdown', request) as Promise<{ ok: boolean; fileName?: string; code?: string; message?: string; warnings?: unknown[] }>,
    // 排版面板「导入 Word 模板」（2026-09-01）：选模板文件→解析排版规则→返回配置与识别清单。

    importOutcomePptx: async (raw: unknown) => { const p=OutcomePptxImportRequestSchema.safeParse(raw); if (!p.success) return OutcomePptxImportResultSchema.parse({ ok:false, code:'invalid_request', message:'PPTX 导入请求无效。', warnings:[] }); const result=OutcomePptxImportResultSchema.safeParse(await ipcRenderer.invoke('outcomes:pptx:import',p.data)); return result.success ? result.data : OutcomePptxImportResultSchema.parse({ ok:false, code:'pptx_read_failed', message:'PPTX 导入响应无效。', warnings:[] }); },

    commitOutcomePptxImportMedia: async (raw: unknown) => { const p=OutcomePptxImportCommitRequestSchema.safeParse(raw); if (!p.success) return OutcomePptxImportCommitResultSchema.parse({ ok:false, code:'invalid_request', message:'PPTX 导入媒体提交请求无效。' }); const result=OutcomePptxImportCommitResultSchema.safeParse(await ipcRenderer.invoke('outcomes:pptx:import:commitMedia',p.data)); return result.success ? result.data : OutcomePptxImportCommitResultSchema.parse({ ok:false, code:'pptx_media_commit_failed', message:'PPTX 导入媒体提交响应无效。' }); },

    exportOutcomePptx: async (raw: unknown) => { const p=OutcomePptxExportRequestSchema.safeParse(raw); if (!p.success) return OutcomePptxExportResultSchema.parse({ ok:false, code:'invalid_request', message:'PPTX 导出请求无效。', warnings:[] }); const result=OutcomePptxExportResultSchema.safeParse(await ipcRenderer.invoke('outcomes:pptx:export',p.data)); return result.success ? result.data : OutcomePptxExportResultSchema.parse({ ok:false, code:'pptx_write_failed', message:'PPTX 导出响应无效。', warnings:[] }); },

    getOutcomeImageSettings: async () => { const result=OutcomeImageSettingsGetResultSchema.safeParse(await ipcRenderer.invoke('outcomes:image-settings:get')); return result.success ? result.data : OutcomeImageSettingsGetResultSchema.parse({ ok:false, code:'settings_read_failed' }); },

    setOutcomeImageSettings: async (raw: unknown) => { const p=ImageGenerationSettingsUpdateSchema.safeParse(raw); if(!p.success)return OutcomeImageSettingsSaveResultSchema.parse({ ok:false, code:'invalid_request' }); const result=OutcomeImageSettingsSaveResultSchema.safeParse(await ipcRenderer.invoke('outcomes:image-settings:set',p.data)); return result.success ? result.data : OutcomeImageSettingsSaveResultSchema.parse({ ok:false, code:'settings_write_failed' }); },

    generateOutcomeImage: async (raw: unknown) => { const p=OutcomeImageGenerateRequestSchema.safeParse(raw); if(!p.success)return OutcomeImageGenerateResultSchema.parse({ok:false,code:'invalid_request'}); const result=await ipcRenderer.invoke('outcomes:image:generate',p.data); const decoded=OutcomeImageGenerateResultSchema.safeParse(result); return decoded.success?decoded.data:OutcomeImageGenerateResultSchema.parse({ok:false,code:'image_generation_provider_response_invalid'}); },

    // ── Goal Engine ────────────────────────────────────────

    // ---- 成果提示词工程(2026-09-05 刘总要求,任务4)----
    outcomePromptList: async () => (
      ipcRenderer.invoke('outcomePrompt:list') as Promise<Array<{ definition: { id: string; name: string; description: string; category: string; action: string; defaultPrompt: string; scopeNote: string; editable: boolean; version: number }; override: { promptId: string; content: string; enabled: boolean; baseVersion: number; createdAt: number; updatedAt: number } | null; effectiveContent: string; defaultUpgraded: boolean; status: string }>>
    ),

    outcomePromptSave: async (request: { promptId: string; content: string; enabled?: boolean; note?: string }) => (
      ipcRenderer.invoke('outcomePrompt:saveOverride', request) as Promise<{ ok: boolean; code?: string; view?: Record<string, unknown> }>
    ),

    outcomePromptSetEnabled: async (request: { promptId: string; enabled: boolean }) => (
      ipcRenderer.invoke('outcomePrompt:setEnabled', request) as Promise<{ ok: boolean; code?: string }>
    ),

    outcomePromptReset: async (promptId: string) => (
      ipcRenderer.invoke('outcomePrompt:reset', { promptId }) as Promise<{ ok: boolean; code?: string }>
    ),

    outcomePromptListRevisions: async (promptId: string) => (
      ipcRenderer.invoke('outcomePrompt:listRevisions', { promptId }) as Promise<Array<{ id: string; content: string; createdAt: number; source: string; note: string }>>
    ),

    outcomePromptRestoreRevision: async (request: { promptId: string; revisionId: string }) => (
      ipcRenderer.invoke('outcomePrompt:restoreRevision', request) as Promise<{ ok: boolean; code?: string }>
    ),

    outcomePromptExport: async () => (
      ipcRenderer.invoke('outcomePrompt:export') as Promise<{ schemaVersion: number; createdAt: number; prompts: Array<{ promptId: string; content: string; baseVersion: number; enabled: boolean }> } | null>
    ),

    outcomePromptImport: async (pack: unknown) => (
      ipcRenderer.invoke('outcomePrompt:import', pack) as Promise<{ ok: boolean; code?: string; applied?: string[]; unknownIds?: string[] }>
    ),
    // ---- METIS Office Prompt Profiles(2026-09-05,任务5)----
    // ---- Skill Studio(2026-09-05,任务7)----

    outcomePromptAssist: async (request: { promptId: string; instruction: string }) => (
      ipcRenderer.invoke('outcomePrompt:assist', request) as Promise<{ ok: boolean; code?: string; suggestion?: string; message?: string }>
    ),

    // 排版面板「导入 Word 模板」（2026-09-01）：选模板文件→解析排版规则→返回配置与识别清单。
    parseWordTemplateStyle: async () =>
      ipcRenderer.invoke('outcomes:word:templateStyle:parse') as Promise<{
        ok: boolean; fileName?: string; code?: string; message?: string;
        config?: Record<string, unknown>; recognized?: string[]; unrecognized?: string[];
      }>,
    // 排版面板「从投稿要求生成」（2026-09-01）：规范文本→（确定性+AI兜底）解析为排版配置。

    // 排版面板「从投稿要求生成」（2026-09-01）：规范文本→（确定性+AI兜底）解析为排版配置。
    parseFormattingFromText: async (text: string) =>
      ipcRenderer.invoke('outcomes:word:formattingFromText', { text }) as Promise<{
        ok: boolean; code?: string; message?: string; source?: string; note?: string;
        config?: Record<string, unknown>; matched?: string[]; unclear?: string[];
      }>,
    // 场景配置助手「上传申报书模板」（2026-09-01）：选文件→分析入库→返回模板ID与栏目结构摘要。
};
