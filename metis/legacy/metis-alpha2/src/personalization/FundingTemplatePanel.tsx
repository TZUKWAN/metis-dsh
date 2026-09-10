import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileCapabilitySelectionResultSchema,
  type FileCapabilitySelectionResult,
} from '../../engine/runtime/FileCapabilityContract.js';
import {
  FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
  FundingTemplateRuntimeScopeIdSchema,
  decodeFundingTemplateActivateResponse,
  decodeFundingTemplateArchiveResponse,
  decodeFundingTemplateDiffResponse,
  decodeFundingTemplateGetResponse,
  decodeFundingTemplateImportResponse,
  decodeFundingTemplateListResponse,
  decodeFundingTemplateRestoreResponse,
  type FundingTemplateActivateResponse,
  type FundingTemplateArchiveResponse,
  type FundingTemplateDiffView,
  type FundingTemplateIpcRequest,
  type FundingTemplateRestoreResponse,
  type FundingTemplateRuntimeFailureCode,
  type FundingTemplateSummary,
  type FundingTemplateVersionView,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import { useTranslation } from '../i18n';
import './FundingTemplatePanel.css';

type IpcRequest<Action extends FundingTemplateIpcRequest['action']> = Extract<
  FundingTemplateIpcRequest,
  { action: Action }
>;

export interface FundingTemplatePanelDependencies {
  createOperationId?: () => string;
  selectFileCapability(purpose: 'funding-template'): Promise<FileCapabilitySelectionResult>;
  importTemplate(request: IpcRequest<'import'>): Promise<unknown>;
  listTemplates(request: IpcRequest<'list'>): Promise<unknown>;
  getTemplate(request: IpcRequest<'get'>): Promise<unknown>;
  getTemplateDiff(request: IpcRequest<'diff'>): Promise<unknown>;
  activateTemplate(request: IpcRequest<'activate'>): Promise<unknown>;
  archiveTemplate(request: IpcRequest<'archive'>): Promise<unknown>;
  restoreTemplate(request: IpcRequest<'restore'>): Promise<unknown>;
  /** 逐栏填写草稿生成（2026-09-01）：可选；未注入时隐藏草稿区。 */
  draftOutline?(request: { projectId: string; templateId: string; materialText?: string }): Promise<{ ok: boolean; markdown?: string; message?: string }>;
  /** 草稿导出 DOCX（2026-09-01）：可选；未注入时隐藏导出按钮。 */
  exportDraftDocx?(request: { title: string; markdown: string }): Promise<{ ok: boolean; fileName?: string; message?: string }>;
}

export interface FundingTemplatePanelProps {
  projectId: string | null;
  dependencies: FundingTemplatePanelDependencies;
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const FAILURE_LABELS_ZH: Record<FundingTemplateRuntimeFailureCode, string> = {
  invalid_request: '请求不符合严格合同',
  file_capability_unavailable: '文件选择已失效或不可用',
  not_found: '模板不存在',
  archived: '模板已归档',
  cas_conflict: '模板版本已变化，请刷新后重试',
  source_unchanged: '上传文件与已保存版本相同',
  observation_failed: '无法安全读取模板结构',
  docx_layout_unobservable: 'DOCX 未提供可核验的最终版式坐标',
  analysis_failed: '模板分析失败',
  package_invalid: '模板包完整性校验失败',
  sensitive_content: '检测到不应保存的敏感内容',
  repository_busy: '模板库正在被其他操作占用',
  repository_corrupt: '模板库完整性校验失败',
  persist_failed: '模板持久化失败',
  response_invalid: '响应无效，已拒绝使用',
};

const FAILURE_LABELS_EN: Record<FundingTemplateRuntimeFailureCode, string> = {
  invalid_request: 'The request does not satisfy the strict contract',
  file_capability_unavailable: 'The selected file capability expired or is unavailable',
  not_found: 'The template does not exist',
  archived: 'The template is archived',
  cas_conflict: 'The template revision changed. Refresh and try again',
  source_unchanged: 'The uploaded file is identical to the saved version',
  observation_failed: 'Metis could not safely inspect the template structure',
  docx_layout_unobservable: 'The DOCX does not expose verifiable final layout coordinates',
  analysis_failed: 'Template analysis failed',
  package_invalid: 'Template package integrity verification failed',
  sensitive_content: 'Content that must not be saved was detected',
  repository_busy: 'Another template operation is using the repository',
  repository_corrupt: 'Template repository integrity verification failed',
  persist_failed: 'Template persistence failed',
  response_invalid: 'The response was invalid and has been rejected',
};

function operationId(factory?: () => string): string {
  return factory ? factory() : crypto.randomUUID();
}

function shortDigest(value: string): string {
  return value.slice(0, 12);
}

function upsertTemplate(
  templates: readonly FundingTemplateSummary[],
  next: FundingTemplateSummary,
): FundingTemplateSummary[] {
  return [...templates.filter((template) => template.templateId !== next.templateId), next]
    .sort((left, right) => left.templateId.localeCompare(right.templateId));
}

function responseMatches(
  response: { action: string; operationId: string; projectId: string },
  request: { action: string; operationId: string; projectId: string },
): boolean {
  return response.action === request.action
    && response.operationId === request.operationId
    && response.projectId === request.projectId;
}

function failureMessage(code: FundingTemplateRuntimeFailureCode, zh: boolean): string {
  return `${(zh ? FAILURE_LABELS_ZH : FAILURE_LABELS_EN)[code]} (${code})`;
}

function formatSelection(mime: string): 'PDF' | 'DOCX' | null {
  if (mime === PDF_MIME) return 'PDF';
  if (mime === DOCX_MIME) return 'DOCX';
  return null;
}

export default function FundingTemplatePanel({
  projectId,
  dependencies,
}: FundingTemplatePanelProps) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [templates, setTemplates] = useState<FundingTemplateSummary[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateIdInput, setTemplateIdInput] = useState('');
  const [targetVersion, setTargetVersion] = useState('1');
  const [version, setVersion] = useState<FundingTemplateVersionView | null>(null);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string | null>(null);
  const [materialText, setMaterialText] = useState('');
  const [draftMarkdown, setDraftMarkdown] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftStatus, setDraftStatus] = useState('');

  const generateDraft = (): void => {
    if (!projectId || !selectedTemplate || draftBusy) return;
    setDraftBusy(true);
    setDraftStatus('');
    dependencies.draftOutline?.({ projectId, templateId: selectedTemplate.templateId, materialText: materialText.trim() || undefined })
      .then((result) => {
        if (result.ok && result.markdown) {
          setDraftMarkdown(result.markdown);
          setDraftStatus(zh ? '草稿已生成；请逐栏核对并替换「待补充」项后再使用。' : 'Draft generated; verify every section before use.');
        } else {
          setDraftStatus(result.message ?? (zh ? '草稿生成未完成。' : 'Draft generation did not complete.'));
        }
      })
      .catch(() => setDraftStatus(zh ? '草稿生成请求未完成。' : 'Draft generation request failed.'))
      .finally(() => setDraftBusy(false));
  };

  const exportDraft = (): void => {
    if (!draftMarkdown || !dependencies.exportDraftDocx) return;
    const title = `${selectedTemplate?.templateId ?? '申报书'}-填写草稿`;
    void dependencies.exportDraftDocx({ title, markdown: draftMarkdown })
      .then((result) => setDraftStatus(result.ok ? (zh ? `已导出 ${result.fileName ?? 'DOCX'}。` : `Exported ${result.fileName ?? 'DOCX'}.`) : (result.message ?? (zh ? '导出未完成。' : 'Export failed.'))))
      .catch(() => setDraftStatus(zh ? '导出请求未完成。' : 'Export request failed.'));
  };
  const [selectedFormat, setSelectedFormat] = useState<'PDF' | 'DOCX' | null>(null);
  const [lastDiffBinding, setLastDiffBinding] = useState<FundingTemplateDiffView | null>(null);
  const [displayedDiff, setDisplayedDiff] = useState<FundingTemplateDiffView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);
  const projectEpoch = useRef(0);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.templateId === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  );
  const disabled = projectId === null || busy;

  const showError = useCallback((message: string) => {
    setError(message);
    setStatus('');
  }, []);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  const loadVersion = useCallback(async (
    template: FundingTemplateSummary,
    epoch = projectEpoch.current,
  ): Promise<void> => {
    if (!projectId || template.archivedAt !== null) {
      setVersion(null);
      return;
    }
    const request: IpcRequest<'get'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'get',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      templateId: template.templateId,
      templateVersion: template.activeVersion,
      packageDigest: template.activeDigest,
    };
    try {
      const response = decodeFundingTemplateGetResponse(await dependencies.getTemplate(request));
      if (epoch !== projectEpoch.current) return;
      if (!responseMatches(response, request)
        || (response.ok && (response.template.templateId !== template.templateId
          || response.version.templateVersion !== template.activeVersion
          || response.version.packageDigest !== template.activeDigest))) {
        showError(failureMessage('response_invalid', zh));
        setVersion(null);
        return;
      }
      if (!response.ok) {
        showError(failureMessage(response.code, zh));
        setVersion(null);
        return;
      }
      setVersion(response.version);
    } catch {
      if (epoch === projectEpoch.current) {
        showError(failureMessage('response_invalid', zh));
        setVersion(null);
      }
    }
  }, [dependencies, projectId, showError, zh]);

  useEffect(() => {
    const epoch = ++projectEpoch.current;
    queueMicrotask(() => {
      if (epoch !== projectEpoch.current) return;
      setTemplates([]);
      setSelectedTemplateId(null);
      setTemplateIdInput('');
      setVersion(null);
      setSelectedCapabilityId(null);
      setSelectedFormat(null);
      setLastDiffBinding(null);
      setDisplayedDiff(null);
      setError('');
      setStatus('');
    });
    if (!projectId) return () => { projectEpoch.current += 1; };
    const request: IpcRequest<'list'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'list',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      includeArchived: true,
    };
    void dependencies.listTemplates(request).then((raw) => {
      if (epoch !== projectEpoch.current) return;
      const response = decodeFundingTemplateListResponse(raw);
      if (!responseMatches(response, request)) {
        showError(failureMessage('response_invalid', zh));
        return;
      }
      if (!response.ok) {
        showError(failureMessage(response.code, zh));
        return;
      }
      setTemplates(response.templates);
      const first = response.templates[0] ?? null;
      if (first) {
        setSelectedTemplateId(first.templateId);
        setTemplateIdInput(first.templateId);
        setTargetVersion(String(first.activeVersion));
        void loadVersion(first, epoch);
      }
    }).catch(() => {
      if (epoch === projectEpoch.current) showError(failureMessage('response_invalid', zh));
    });
    return () => { projectEpoch.current += 1; };
  }, [dependencies, loadVersion, projectId, showError, zh]);

  const selectCapability = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const parsed = FileCapabilitySelectionResultSchema.safeParse(
        await dependencies.selectFileCapability('funding-template'),
      );
      if (!parsed.success || !parsed.data.success) {
        showError(failureMessage('file_capability_unavailable', zh));
        return;
      }
      const format = parsed.data.capability.kind === 'file'
        ? formatSelection(parsed.data.capability.mime)
        : null;
      if (!format) {
        showError(zh
          ? '仅支持 PDF 或 DOCX 基金申报模板。'
          : 'Only PDF or DOCX funding-application templates are supported.');
        return;
      }
      setSelectedCapabilityId(parsed.data.capability.capabilityId);
      setSelectedFormat(format);
      setStatus(zh
        ? '文件能力已就绪；文件名与本地路径不会显示或发送给模型。'
        : 'The file capability is ready. The file name and local path will not be displayed or sent to the model.');
    } catch {
      showError(failureMessage('file_capability_unavailable', zh));
    } finally {
      setBusy(false);
    }
  };

  const importOrReanalyze = async () => {
    if (!projectId || !selectedCapabilityId || busy) return;
    const templateId = templateIdInput.trim();
    if (!FundingTemplateRuntimeScopeIdSchema.safeParse(templateId).success) {
      showError(zh ? '模板标识不符合安全格式。' : 'The template identifier does not satisfy the safe format.');
      return;
    }
    const existing = templates.find((template) => template.templateId === templateId) ?? null;
    if (existing !== null && existing.archivedAt !== null) {
      showError(failureMessage('archived', zh));
      return;
    }
    const request: IpcRequest<'import'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'import',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      templateId,
      fileCapabilityId: selectedCapabilityId,
      capabilityUse: 'consume_once',
      expectedTemplateRevision: existing?.templateRevision ?? 0,
      expectedActiveVersion: existing?.activeVersion ?? null,
      expectedActiveDigest: existing?.activeDigest ?? null,
    };
    // Once dispatch begins the renderer must never reuse this capability.
    setSelectedCapabilityId(null);
    setSelectedFormat(null);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const response = decodeFundingTemplateImportResponse(await dependencies.importTemplate(request));
      if (!responseMatches(response, request)
        || (response.ok && (response.template.templateId !== request.templateId
          || response.version.templateVersion !== response.template.activeVersion
          || response.version.packageDigest !== response.template.activeDigest))) {
        showError(failureMessage('response_invalid', zh));
        return;
      }
      if (!response.ok) {
        showError(failureMessage(response.code, zh));
        return;
      }
      setTemplates((current) => upsertTemplate(current, response.template));
      setSelectedTemplateId(response.template.templateId);
      setTemplateIdInput(response.template.templateId);
      setTargetVersion(String(response.template.activeVersion));
      setVersion(response.version);
      setLastDiffBinding(response.diff);
      setDisplayedDiff(response.diff);
      setStatus(existing
        ? (zh ? '重分析版本已原子保存并自动核验。' : 'The reanalyzed revision was saved atomically and verified automatically.')
        : (zh ? '模板已分析、核验并保存为版本 1。' : 'The template was analyzed, verified, and saved as version 1.'));
    } catch {
      showError(failureMessage('response_invalid', zh));
    } finally {
      setBusy(false);
    }
  };

  const selectTemplate = (template: FundingTemplateSummary) => {
    if (disabled) return;
    setSelectedTemplateId(template.templateId);
    setTemplateIdInput(template.templateId);
    setTargetVersion(String(template.activeVersion));
    setVersion(null);
    setLastDiffBinding(null);
    setDisplayedDiff(null);
    setError('');
    setStatus('');
    void loadVersion(template);
  };

  const verifyLastDiff = async () => {
    if (!projectId || !selectedTemplate || !lastDiffBinding || busy) return;
    const request: IpcRequest<'diff'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'diff',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      templateId: selectedTemplate.templateId,
      expectedTemplateRevision: selectedTemplate.templateRevision,
      fromVersion: lastDiffBinding.fromVersion,
      toVersion: lastDiffBinding.toVersion,
      fromDigest: lastDiffBinding.fromDigest,
      toDigest: lastDiffBinding.toDigest,
    };
    setBusy(true);
    setError('');
    try {
      const response = decodeFundingTemplateDiffResponse(await dependencies.getTemplateDiff(request));
      if (!responseMatches(response, request)
        || (response.ok && (response.diff.templateId !== request.templateId
          || response.diff.fromVersion !== request.fromVersion
          || response.diff.toVersion !== request.toVersion
          || response.diff.fromDigest !== request.fromDigest
          || response.diff.toDigest !== request.toDigest))) {
        showError(failureMessage('response_invalid', zh));
        return;
      }
      if (!response.ok) {
        showError(failureMessage(response.code, zh));
        return;
      }
      setDisplayedDiff(response.diff);
      setStatus(zh
        ? '版本差异已从持久化包重新计算并核验。'
        : 'The version diff was recomputed from the persisted package and verified.');
    } catch {
      showError(failureMessage('response_invalid', zh));
    } finally {
      setBusy(false);
    }
  };

  const updateFromMutation = (
    response: FundingTemplateActivateResponse | FundingTemplateArchiveResponse | FundingTemplateRestoreResponse,
    request: IpcRequest<'activate'> | IpcRequest<'archive'> | IpcRequest<'restore'>,
    successStatus: string,
  ) => {
    if (!responseMatches(response, request)
      || (response.ok && response.template.templateId !== request.templateId)) {
      showError(failureMessage('response_invalid', zh));
      return;
    }
    if (!response.ok) {
        showError(failureMessage(response.code, zh));
      return;
    }
    setTemplates((current) => upsertTemplate(current, response.template));
    setSelectedTemplateId(response.template.templateId);
    setTemplateIdInput(response.template.templateId);
    setTargetVersion(String(response.template.activeVersion));
    setLastDiffBinding(null);
    setDisplayedDiff(null);
    setStatus(successStatus);
    if (response.template.archivedAt === null) void loadVersion(response.template);
    else setVersion(null);
  };

  const activateVersion = async () => {
    if (!projectId || !selectedTemplate || selectedTemplate.archivedAt !== null || busy) return;
    const target = Number(targetVersion);
    if (!Number.isSafeInteger(target) || target < 1 || target > selectedTemplate.latestVersion) {
      showError(zh
        ? `目标版本必须在 1 到 ${selectedTemplate.latestVersion} 之间。`
        : `The target version must be between 1 and ${selectedTemplate.latestVersion}.`);
      return;
    }
    const request: IpcRequest<'activate'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'activate',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      templateId: selectedTemplate.templateId,
      expectedTemplateRevision: selectedTemplate.templateRevision,
      expectedActiveVersion: selectedTemplate.activeVersion,
      expectedActiveDigest: selectedTemplate.activeDigest,
      targetVersion: target,
    };
    setBusy(true);
    setError('');
    try {
      updateFromMutation(
        decodeFundingTemplateActivateResponse(await dependencies.activateTemplate(request)),
        request,
        zh ? `版本 ${target} 已激活。` : `Version ${target} is now active.`,
      );
    } catch {
      showError(failureMessage('response_invalid', zh));
    } finally {
      setBusy(false);
    }
  };

  const archiveTemplate = async () => {
    if (!projectId || !selectedTemplate || selectedTemplate.archivedAt !== null || busy) return;
    const request: IpcRequest<'archive'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'archive',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      templateId: selectedTemplate.templateId,
      expectedTemplateRevision: selectedTemplate.templateRevision,
      expectedActiveVersion: selectedTemplate.activeVersion,
      expectedActiveDigest: selectedTemplate.activeDigest,
    };
    setBusy(true);
    setError('');
    try {
      updateFromMutation(
        decodeFundingTemplateArchiveResponse(await dependencies.archiveTemplate(request)),
        request,
        zh ? '模板已归档，历史版本仍保留。' : 'The template was archived; its version history remains available.',
      );
    } catch {
      showError(failureMessage('response_invalid', zh));
    } finally {
      setBusy(false);
    }
  };

  const restoreTemplate = async () => {
    if (!projectId || !selectedTemplate || selectedTemplate.archivedAt === null || busy) return;
    const request: IpcRequest<'restore'> = {
      contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
      action: 'restore',
      operationId: operationId(dependencies.createOperationId),
      projectId,
      templateId: selectedTemplate.templateId,
      expectedTemplateRevision: selectedTemplate.templateRevision,
      expectedActiveVersion: selectedTemplate.activeVersion,
      expectedActiveDigest: selectedTemplate.activeDigest,
    };
    setBusy(true);
    setError('');
    try {
      updateFromMutation(
        decodeFundingTemplateRestoreResponse(await dependencies.restoreTemplate(request)),
        request,
        zh ? '模板已恢复并重新核验当前版本。' : 'The template was restored and its current version was verified again.',
      );
    } catch {
      showError(failureMessage('response_invalid', zh));
    } finally {
      setBusy(false);
    }
  };

  const existingForInput = templates.find((template) => template.templateId === templateIdInput.trim()) ?? null;
  const importLabel = existingForInput
    ? (zh ? '重新分析' : 'Reanalyze')
    : (zh ? '创建模板' : 'Create template');

  return (
    <section className="funding-template-panel" role="region" aria-label={zh ? '基金申报模板' : 'Funding application templates'}>
      <header className="funding-template-panel__header">
        <div>
          <span className="funding-template-panel__eyebrow">{zh ? '证据绑定模板编译器' : 'Evidence-bound template compiler'}</span>
          <h2>{zh ? '基金申报模板' : 'Funding application templates'}</h2>
          <p>{zh
            ? '上传 PDF 或 DOCX，保存可追溯的结构版本；不保存申请人正文，也不把本地路径交给模型。'
            : 'Upload a PDF or DOCX and save traceable structural versions. Applicant prose is not retained, and local paths are never sent to the model.'}</p>
        </div>
        <div className="funding-template-panel__truth" aria-label={zh ? '自动真实性核验' : 'Automatic truth verification'}>
          <strong>{zh ? '自动真实性核验' : 'Automatic truth verification'}</strong>
          <span>{zh
            ? '真实性、摘要、版本与差异由主进程自动核验，无逐步权限确认。'
            : 'The main process automatically verifies truth state, digests, versions, and diffs without step-by-step permission prompts.'}</span>
        </div>
      </header>

      {!projectId && (
        <div className="funding-template-panel__alert" role="alert" aria-live="assertive">
          {zh
            ? '请先打开或创建研究项目，再管理项目绑定的基金申报模板。'
            : 'Open or create a research project before managing project-bound funding templates.'}
        </div>
      )}

      <div className="funding-template-panel__composer">
        <label>
          <span>{zh ? '模板标识' : 'Template identifier'}</span>
          <input
            aria-label={zh ? '模板标识' : 'Template identifier'}
            value={templateIdInput}
            disabled={disabled}
            placeholder="user:funding-template"
            onChange={(event) => setTemplateIdInput(event.target.value)}
          />
        </label>
        <button type="button" disabled={disabled} onClick={() => { void selectCapability(); }}>
          {zh ? '选择 PDF 或 DOCX' : 'Choose PDF or DOCX'}
        </button>
        <button
          type="button"
          className="primary"
          disabled={disabled || !selectedCapabilityId || templateIdInput.trim().length === 0 || (existingForInput !== null && existingForInput.archivedAt !== null)}
          onClick={() => { void importOrReanalyze(); }}
        >
          {importLabel}
        </button>
      </div>

      {selectedFormat && (
        <div className="funding-template-panel__selection">{zh
          ? `已选择 ${selectedFormat}；能力将在本次分析调用时一次性消费。`
          : `${selectedFormat} selected. The capability will be consumed once by this analysis call.`}</div>
      )}

      <div className="funding-template-panel__layout">
        <aside className="funding-template-panel__library" aria-label={zh ? '模板列表' : 'Template list'}>
          <div className="funding-template-panel__library-heading">
            <h3>{zh ? '项目模板' : 'Project templates'}</h3>
            <span>{templates.length}</span>
          </div>
          {templates.length === 0 ? (
            <p className="funding-template-panel__empty">{zh ? '当前项目尚无已保存模板。' : 'This project has no saved templates.'}</p>
          ) : (
            <ul>
              {templates.map((template) => (
                <li key={template.templateId}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={template.templateId === selectedTemplateId}
                    onClick={() => selectTemplate(template)}
                  >
                    <strong>{template.templateId}</strong>
                    <span>r{template.templateRevision} · v{template.activeVersion}/{template.latestVersion}</span>
                    <span>{template.archivedAt === null
                      ? (zh ? '使用中' : 'Active')
                      : (zh ? '已归档' : 'Archived')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="funding-template-panel__detail">
          {!selectedTemplate ? (
            <p className="funding-template-panel__empty">{zh
              ? '选择一个模板查看安全版本摘要。'
              : 'Select a template to view its version-safe summary.'}</p>
          ) : (
            <>
              <div className="funding-template-panel__detail-heading">
                <div>
                  <span>{zh ? '当前模板' : 'Current template'}</span>
                  <h3>{selectedTemplate.templateId}</h3>
                </div>
                <code title={zh ? '当前包摘要' : 'Current package digest'}>{shortDigest(selectedTemplate.activeDigest)}</code>
              </div>

              {version && selectedTemplate.archivedAt === null && (
                <div className="funding-template-panel__metrics" aria-label={zh ? '版本安全摘要' : 'Version-safe summary'}>
                  <div><span>{zh ? '版本' : 'Version'}</span><strong>{version.templateVersion}</strong></div>
                  <div><span>{zh ? '格式' : 'Format'}</span><strong>{version.sourceFormat.toUpperCase()}</strong></div>
                  <div><span>{zh ? '页数' : 'Pages'}</span><strong>{version.pageCount}</strong></div>
                  <div><span>{zh ? '可信度' : 'Confidence'}</span><strong>{Math.round(version.quality.overallConfidence * 100)}%</strong></div>
                  <div><span>{zh ? '版式证据' : 'Layout evidence'}</span><strong>{zh
                    ? ({ observed: '已观测', partial: '部分观测', not_observed: '未观测' } as const)[version.structure.layoutEvidence]
                    : ({ observed: 'Observed', partial: 'Partial', not_observed: 'Not observed' } as const)[version.structure.layoutEvidence]}</strong></div>
                  <div><span>{zh ? '质量状态' : 'Quality status'}</span><strong>{zh
                    ? ({ ready: '就绪', needs_review: '需要复核' } as const)[version.quality.status]
                    : ({ ready: 'Ready', needs_review: 'Needs review' } as const)[version.quality.status]}</strong></div>
                  <p>{zh
                    ? `章节 ${version.structure.sectionCount} · 指令 ${version.structure.instructionCount} · 表格 ${version.structure.tableCount}`
                    : `Sections ${version.structure.sectionCount} · Instructions ${version.structure.instructionCount} · Tables ${version.structure.tableCount}`}</p>
                  <p>{zh
                    ? `内容槽 ${version.structure.contentSlotCount} · 字段映射 ${version.structure.fieldMappingCount} · 字体规则 ${version.structure.typographyRuleCount}`
                    : `Content slots ${version.structure.contentSlotCount} · Field mappings ${version.structure.fieldMappingCount} · Typography rules ${version.structure.typographyRuleCount}`}</p>
                </div>
              )}

              <div className="funding-template-panel__actions">
                <label>
                  <span>{zh ? '目标版本' : 'Target version'}</span>
                  <input
                    aria-label={zh ? '目标版本' : 'Target version'}
                    type="number"
                    min={1}
                    max={selectedTemplate.latestVersion}
                    value={targetVersion}
                    disabled={disabled || selectedTemplate.archivedAt !== null}
                    onChange={(event) => setTargetVersion(event.target.value)}
                  />
                </label>
                {selectedTemplate.archivedAt === null ? (
                  <>
                    <button type="button" disabled={disabled} onClick={() => { void activateVersion(); }}>{zh ? '激活版本' : 'Activate version'}</button>
                    <button type="button" disabled={disabled} onClick={() => { void archiveTemplate(); }}>{zh ? '归档模板' : 'Archive template'}</button>
                  </>
                ) : (
                  <button type="button" disabled={disabled} onClick={() => { void restoreTemplate(); }}>{zh ? '恢复模板' : 'Restore template'}</button>
                )}
                {lastDiffBinding && (
                  <button type="button" disabled={disabled} onClick={() => { void verifyLastDiff(); }}>
                    {zh ? '重新核验版本差异' : 'Verify version diff again'}
                  </button>
                )}
              </div>

              {displayedDiff && (
                <div className="funding-template-panel__diff" aria-label={zh ? '版本差异摘要' : 'Version diff summary'}>
                  <strong>v{displayedDiff.fromVersion} → v{displayedDiff.toVersion}</strong>
                  <span>{zh
                    ? `${displayedDiff.changes.length} 项已核验变更`
                    : `${displayedDiff.changes.length} verified changes`}</span>
                  <span>{displayedDiff.breaking
                    ? (zh ? '包含破坏性变更' : 'Contains breaking changes')
                    : (zh ? '无破坏性变更' : 'No breaking changes')}</span>
                  <code>{shortDigest(displayedDiff.diffDigest)}</code>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          ref={alertRef}
          className="funding-template-panel__alert"
          role="alert"
          aria-live="assertive"
          tabIndex={-1}
        >
          {error}
        </div>
      )}

      {dependencies.draftOutline && projectId && (
        <div className="funding-template-panel__draft" aria-label={zh ? '申报书填写草稿' : 'Application draft'}>
          <strong>{zh ? '生成填写草稿' : 'Generate application draft'}</strong>
          <p>
            {zh
              ? '按上方已分析模板的栏目结构，结合你提供的材料生成逐栏填写草稿。草稿只使用材料里真实存在的内容；材料没覆盖的栏目会给出填写框架与待补充清单。'
              : 'Drafts every section against the analyzed template using your own material. Sections the material does not cover receive an outline plus a to-fill checklist instead of invented facts.'}
          </p>
          <textarea
            rows={4}
            value={materialText}
            onChange={(event) => setMaterialText(event.target.value)}
            placeholder={zh ? '粘贴申请材料：研究基础、代表性成果、团队情况、前期数据…（可留空）' : 'Paste your material: research basis, publications, team, preliminary data… (optional)'}
          />
          <div className="funding-template-panel__draft-actions">
            <button
              type="button"
              disabled={disabled || !selectedTemplate || draftBusy}
              onClick={() => { void generateDraft(); }}
            >
              {draftBusy ? (zh ? '生成中…' : 'Generating…') : (zh ? '生成填写草稿' : 'Generate draft')}
            </button>
            {draftMarkdown && (
              <button
                type="button"
                disabled={draftBusy}
                onClick={() => { void exportDraft(); }}
              >
                {zh ? '导出为 DOCX' : 'Export as DOCX'}
              </button>
            )}
          </div>
          {draftMarkdown && (
            <pre className="funding-template-panel__draft-output" aria-label={zh ? '草稿内容' : 'Draft content'}>{draftMarkdown}</pre>
          )}
          {draftStatus && <p role="status">{draftStatus}</p>}
        </div>
      )}

      <div className="funding-template-panel__status" role="status" aria-live="polite">
        {busy ? (zh ? '正在执行…' : 'Working…') : status}
      </div>
    </section>
  );
}
