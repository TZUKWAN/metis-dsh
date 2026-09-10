import { useMemo, useState } from 'react';
import {
  DEFAULT_EXPORT_REDACTION,
  ExportRequestSchema,
  decodeExportResult,
  type ExportFailure,
  type ExportFormat,
  type ExportPrivacyProfile,
  type ExportPreview,
  type ExportRedactionOptions,
  type ExportRequest,
  type ExportResult,
  type ExportScope,
} from '../../engine/runtime/ExportRuntimeContract';
import {
  FileCapabilityDescriptorSchema,
  type FileCapabilityDescriptor,
} from '../../engine/runtime/FileCapabilityContract';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import './ResearchExportCenter.css';

interface ResearchExportTargetAPI {
  selectExportDestination(): Promise<unknown>;
  previewResearchExport(request: ExportRequest): Promise<unknown>;
  executeResearchExport(request: ExportRequest): Promise<unknown>;
}

type BusyAction = 'destination' | 'preview' | 'execute' | null;
type RedactionToggleKey = Exclude<keyof ExportRedactionOptions, 'stripSecrets'>;

interface PreviewState {
  fingerprint: string;
  request: ExportRequest;
  result: ExportPreview;
}

interface SummaryState {
  phase: 'preview' | 'execute';
  result: ExportResult;
}

const SCOPE_ORDER: readonly ExportScope[] = [
  'project',
  'artifact',
  'citations',
  'evidence',
  'audit',
];

const FORMAT_ORDER: readonly ExportFormat[] = [
  'markdown',
  'html',
  'csv',
  'json-bundle',
  'docx',
  'pdf',
];

const PRIVACY_ORDER: readonly ExportPrivacyProfile[] = [
  'public-share',
  'deidentified',
  'private-local',
];

const REDACTION_ORDER: readonly RedactionToggleKey[] = [
  'stripAbsolutePaths',
  'stripPersonalData',
  'pseudonymizeParticipants',
  'omitRawTranscripts',
  'omitModelPrompts',
  'omitToolArguments',
];

function getTargetAPI(): ResearchExportTargetAPI | null {
  const candidate = window.metis as unknown as Partial<ResearchExportTargetAPI> | undefined;
  return candidate
    && typeof candidate.selectExportDestination === 'function'
    && typeof candidate.previewResearchExport === 'function'
    && typeof candidate.executeResearchExport === 'function'
    ? candidate as ResearchExportTargetAPI
    : null;
}

function decodeDestination(input: unknown): FileCapabilityDescriptor | null {
  const direct = FileCapabilityDescriptorSchema.safeParse(input);
  if (direct.success) return direct.data;
  if (input === null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (record.success !== true) return null;
  const nested = FileCapabilityDescriptorSchema.safeParse(record.capability);
  return nested.success ? nested.data : null;
}

function createExportId(): string | null {
  try {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const binary = Array.from(bytes, (value) => String.fromCharCode(value)).join('');
    const encoded = btoa(binary)
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    return `ex_${encoded}`;
  } catch {
    return null;
  }
}

function isSupportedFormat(format: ExportFormat): boolean {
  return format === 'markdown'
    || format === 'html'
    || format === 'csv'
    || format === 'json-bundle'
    || format === 'docx'
    || format === 'pdf';
}

/** Whether the format requires Electron main-process rendering at write time. */
function showsBinaryFormatNotice(format: ExportFormat): boolean {
  return format === 'pdf' || format === 'docx';
}

function configurationFingerprint(input: {
  projectId: string;
  destinationCapabilityId: string | null;
  scopes: readonly ExportScope[];
  format: ExportFormat;
  privacyProfile: ExportPrivacyProfile;
  redaction: ExportRedactionOptions;
  artifactId: string | null;
  artifactVersion: number | null;
}): string {
  return JSON.stringify({
    projectId: input.projectId,
    destinationCapabilityId: input.destinationCapabilityId,
    scopes: SCOPE_ORDER.filter((scope) => input.scopes.includes(scope)),
    format: input.format,
    privacyProfile: input.privacyProfile,
    redaction: input.redaction,
    artifactId: input.artifactId,
    artifactVersion: input.artifactVersion,
  });
}

export interface ResearchExportCenterProps {
  projectId: string;
  /** Stable ID of the artifact version selected for export. */
  artifactId?: string;
  /** Artifact version selected for export; main verifies it against the repository. */
  artifactVersion?: number;
}

export default function ResearchExportCenter({
  projectId,
  artifactId: artifactIdProp,
  artifactVersion: artifactVersionProp,
}: ResearchExportCenterProps) {
  const { locale } = useTranslation();
  const workspaceSelection = useResearchWorkspaceStore((state) => state.selection);
  const workspaceSnapshot = useResearchWorkspaceStore((state) => state.snapshot);
  const selectedArtifact = workspaceSelection?.kind === 'artifact'
    ? workspaceSnapshot?.artifacts.find((artifact) => artifact.id === workspaceSelection.id)
    : undefined;
  const artifactId = artifactIdProp ?? selectedArtifact?.id;
  const artifactVersion = artifactVersionProp ?? selectedArtifact?.version;
  const copy = useMemo(() => locale === 'zh' ? {
    title: '研究导出中心',
    description: '仅导出明确选择的研究范围。目标位置使用不透明授权，界面不会显示真实路径。',
    scopes: '导出范围',
    formats: '文件格式',
    privacy: '隐私档位',
    redaction: '脱敏选项',
    destination: '导出目标',
    selectDestination: '选择导出目标',
    selecting: '正在选择…',
    destinationSelected: (name: string) => `已选择：${name}`,
    destinationNone: '尚未选择导出目标。',
    preview: '安全预览',
    previewing: '正在预览…',
    execute: '执行导出',
    executing: '正在导出…',
    formatNotice: 'PDF 预览仅检查 HTML 中间体；执行时由 Electron 生成并在写盘前校验结构。DOCX 仅嵌入通过类型、哈希、尺寸验证的 PNG、JPEG 或 GIF。',
    selectScope: '至少选择一个导出范围。',
    artifactBindingUnavailable: '尚未选择可验证的产物及版本，导出已安全禁用。',
    previewOutdated: '配置已变化，请重新执行安全预览。',
    apiUnavailable: '安全导出服务暂不可用。',
    destinationUnavailable: '未获得有效的导出目标授权。',
    previewComplete: '导出候选内容检查完成',
    intermediatePreviewComplete: 'PDF HTML 中间体检查完成',
    exportComplete: '导出完成',
    exportFailed: '导出未完成',
    files: '文件数',
    bytes: '总字节',
    checksum: 'Manifest SHA-256',
    previewChecksum: '预览内容 SHA-256（不是最终文件）',
    previewKind: '预览类型',
    intermediateKind: 'HTML 中间体',
    candidateKind: '确定性候选内容',
    safeSummary: '安全摘要',
    privacyHint: '“公开分享”和“去标识化”档位会强制启用全部脱敏选项。密钥剥离始终开启。',
    scopeLabels: {
      project: '项目摘要', artifact: '研究产物', citations: '引文', evidence: '证据', audit: '审计记录',
    },
    formatLabels: {
      markdown: 'Markdown', html: 'HTML', csv: 'CSV', 'json-bundle': 'JSON Bundle', docx: 'DOCX', pdf: 'PDF',
    },
    privacyLabels: {
      'public-share': '公开分享（最安全）', deidentified: '去标识化', 'private-local': '仅本地私有',
    },
    redactionLabels: {
      stripSecrets: '剥离密钥与令牌（始终开启）',
      stripAbsolutePaths: '剥离绝对路径',
      stripPersonalData: '剥离个人信息',
      pseudonymizeParticipants: '参与者使用稳定化名',
      omitRawTranscripts: '排除原始访谈文本',
      omitModelPrompts: '排除模型提示词',
      omitToolArguments: '排除工具参数',
    },
    issue: {
      export_invalid_request: '导出请求无效。',
      export_destination_unavailable: '导出目标不可用。',
      export_format_unsupported: '该格式不受支持。',
      export_snapshot_unavailable: '安全研究快照不可用。',
      export_artifact_binding_mismatch: '产物版本或 Manifest 摘要与可信快照不一致。',
      export_privacy_blocked: '隐私检查阻止了本次导出。',
      export_limit_exceeded: '导出内容超过安全上限。',
      export_write_failed: '安全写入失败。',
      export_redaction_applied: '已应用脱敏规则。',
      export_scope_empty: '所选范围中存在空范围。',
      export_gate_blocked: '导出门禁检查未通过。',
      export_gate_warning: '导出门禁发现需要复核的警告。',
      export_render_failed: '文件渲染失败。',
    } as Record<string, string>,
  } : {
    title: 'Research export center',
    description: 'Only explicitly selected research scopes are exported. The destination uses an opaque capability and no local path is shown.',
    scopes: 'Export scopes',
    formats: 'File format',
    privacy: 'Privacy profile',
    redaction: 'Redaction options',
    destination: 'Export destination',
    selectDestination: 'Select export destination',
    selecting: 'Selecting…',
    destinationSelected: (name: string) => `Selected: ${name}`,
    destinationNone: 'No export destination selected.',
    preview: 'Secure preview',
    previewing: 'Previewing…',
    execute: 'Execute export',
    executing: 'Exporting…',
    formatNotice: 'PDF preview checks an HTML intermediate only; execution renders it in Electron and validates the PDF structure before writing. DOCX embeds only PNG, JPEG, or GIF images that pass type, digest, and dimension checks.',
    selectScope: 'Select at least one export scope.',
    artifactBindingUnavailable: 'A verifiable artifact and version are not selected, so export is safely disabled.',
    previewOutdated: 'The configuration changed. Run the secure preview again.',
    apiUnavailable: 'The secure export service is unavailable.',
    destinationUnavailable: 'A valid export destination capability was not granted.',
    previewComplete: 'Export candidate inspection complete',
    intermediatePreviewComplete: 'PDF HTML intermediate inspection complete',
    exportComplete: 'Export complete',
    exportFailed: 'Export not completed',
    files: 'Files',
    bytes: 'Total bytes',
    checksum: 'Manifest SHA-256',
    previewChecksum: 'Preview content SHA-256 (not the final file)',
    previewKind: 'Preview kind',
    intermediateKind: 'HTML intermediate',
    candidateKind: 'Deterministic candidate content',
    safeSummary: 'Safe summary',
    privacyHint: 'Public-share and deidentified profiles force every redaction option on. Secret stripping is always enabled.',
    scopeLabels: {
      project: 'Project', artifact: 'Artifacts', citations: 'Citations', evidence: 'Evidence', audit: 'Audit',
    },
    formatLabels: {
      markdown: 'Markdown', html: 'HTML', csv: 'CSV', 'json-bundle': 'JSON Bundle', docx: 'DOCX', pdf: 'PDF',
    },
    privacyLabels: {
      'public-share': 'Public share (safest)', deidentified: 'Deidentified', 'private-local': 'Private local only',
    },
    redactionLabels: {
      stripSecrets: 'Strip secrets and tokens (always on)',
      stripAbsolutePaths: 'Strip absolute paths',
      stripPersonalData: 'Strip personal data',
      pseudonymizeParticipants: 'Use stable participant pseudonyms',
      omitRawTranscripts: 'Omit raw transcripts',
      omitModelPrompts: 'Omit model prompts',
      omitToolArguments: 'Omit tool arguments',
    },
    issue: {
      export_invalid_request: 'The export request is invalid.',
      export_destination_unavailable: 'The export destination is unavailable.',
      export_format_unsupported: 'This format is not supported.',
      export_snapshot_unavailable: 'The secure research snapshot is unavailable.',
      export_artifact_binding_mismatch: 'The artifact version or manifest digest does not match the trusted snapshot.',
      export_privacy_blocked: 'The privacy check blocked this export.',
      export_limit_exceeded: 'The export exceeds a safe limit.',
      export_write_failed: 'The secure write failed.',
      export_redaction_applied: 'Redaction rules were applied.',
      export_scope_empty: 'One or more selected scopes are empty.',
      export_gate_blocked: 'An export gate check failed.',
      export_gate_warning: 'An export gate warning needs review.',
      export_render_failed: 'File rendering failed.',
    } as Record<string, string>,
  }, [locale]);

  const [scopes, setScopes] = useState<ExportScope[]>(['project']);
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [privacyProfile, setPrivacyProfile] = useState<ExportPrivacyProfile>('public-share');
  const [redaction, setRedaction] = useState<ExportRedactionOptions>({
    ...DEFAULT_EXPORT_REDACTION,
  });
  const [destination, setDestination] = useState<FileCapabilityDescriptor | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [safeMessage, setSafeMessage] = useState<string | null>(null);

  const supported = isSupportedFormat(format);
  const artifactBindingAvailable = typeof artifactId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(artifactId)
    && Number.isInteger(artifactVersion)
    && (artifactVersion ?? 0) >= 1;
  const fingerprint = configurationFingerprint({
    projectId,
    destinationCapabilityId: destination?.capabilityId ?? null,
    scopes,
    format,
    privacyProfile,
    redaction,
    artifactId: artifactBindingAvailable ? artifactId! : null,
    artifactVersion: artifactBindingAvailable ? artifactVersion! : null,
  });
  const previewCurrent = preview?.fingerprint === fingerprint;
  const canPreview = busy === null
    && supported
    && destination !== null
    && scopes.length > 0
    && artifactBindingAvailable;
  const canExecute = canPreview && previewCurrent;

  const invalidatePreview = () => {
    setSummary(null);
    setSafeMessage(null);
  };

  const toggleScope = (scope: ExportScope, checked: boolean) => {
    setScopes((current) => checked
      ? SCOPE_ORDER.filter((candidate) => candidate === scope || current.includes(candidate))
      : current.filter((candidate) => candidate !== scope));
    invalidatePreview();
  };

  const changePrivacy = (profile: ExportPrivacyProfile) => {
    setPrivacyProfile(profile);
    if (profile !== 'private-local') setRedaction({ ...DEFAULT_EXPORT_REDACTION });
    invalidatePreview();
  };

  const changeRedaction = (key: RedactionToggleKey, checked: boolean) => {
    setRedaction((current) => ({ ...current, [key]: checked }));
    invalidatePreview();
  };

  const selectDestination = async () => {
    const api = getTargetAPI();
    if (!api) {
      setSafeMessage(copy.apiUnavailable);
      return;
    }
    setBusy('destination');
    setSafeMessage(null);
    try {
      const selected = decodeDestination(await api.selectExportDestination());
      if (
        !selected
        || selected.kind !== 'folder'
        || !selected.operations.includes('folder')
      ) {
        setSafeMessage(copy.destinationUnavailable);
        return;
      }
      setDestination(selected);
      setPreview(null);
      setSummary(null);
    } catch {
      setSafeMessage(copy.destinationUnavailable);
    } finally {
      setBusy(null);
    }
  };

  const createRequest = (): ExportRequest | null => {
    if (
      !destination
      || scopes.length === 0
      || !supported
      || !artifactBindingAvailable
    ) return null;
    const exportId = createExportId();
    if (!exportId) return null;
    const parsed = ExportRequestSchema.safeParse({
      exportId,
      projectId,
      artifactId,
      destinationCapabilityId: destination.capabilityId,
      displayName: `research-export-${new Date().toISOString().slice(0, 10)}`,
      scopes: SCOPE_ORDER.filter((scope) => scopes.includes(scope)),
      format,
      privacyProfile,
      redaction,
      requestedAt: Date.now(),
      artifactVersion,
    });
    return parsed.success ? parsed.data : null;
  };

  const previewExport = async () => {
    const api = getTargetAPI();
    const request = createRequest();
    if (!api || !request) {
      setSafeMessage(!api
        ? copy.apiUnavailable
        : !artifactBindingAvailable
          ? copy.artifactBindingUnavailable
          : copy.selectScope);
      return;
    }
    setBusy('preview');
    setSafeMessage(null);
    try {
      const result = decodeExportResult(await api.previewResearchExport(request));
      setSummary({ phase: 'preview', result });
      if (result.success && result.code === 'export_preview_ready') {
        setPreview({ fingerprint, request, result });
      } else {
        setPreview(null);
      }
    } catch {
      const failure: ExportFailure = {
        success: false,
        code: 'export_unavailable',
        issues: [{ code: 'export_write_failed', severity: 'error' }],
      };
      setPreview(null);
      setSummary({ phase: 'preview', result: failure });
    } finally {
      setBusy(null);
    }
  };

  const executeExport = async () => {
    const api = getTargetAPI();
    if (!api || !preview || preview.fingerprint !== fingerprint) {
      setSafeMessage(api ? copy.previewOutdated : copy.apiUnavailable);
      return;
    }
    setBusy('execute');
    setSafeMessage(null);
    try {
      const result = decodeExportResult(await api.executeResearchExport(preview.request));
      setSummary({ phase: 'execute', result });
    } catch {
      const failure: ExportFailure = {
        success: false,
        code: 'export_unavailable',
        issues: [{ code: 'export_write_failed', severity: 'error' }],
      };
      setSummary({ phase: 'execute', result: failure });
    } finally {
      setBusy(null);
    }
  };

  const totalBytes = summary?.result.success
    ? (summary.result.code === 'export_complete'
        ? summary.result.files
        : summary.result.entries
      ).reduce((total, file) => total + file.byteLength, 0)
    : 0;
  const byteFormatter = useMemo(
    () => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US'),
    [locale],
  );

  return (
    <section className="research-export-center" aria-labelledby="research-export-title">
      <header className="research-export-center__header">
        <div>
          <h2 id="research-export-title">{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </header>

      <div className="research-export-center__grid">
        <fieldset className="research-export-center__card">
          <legend>{copy.scopes}</legend>
          <div className="research-export-center__options">
            {SCOPE_ORDER.map((scope) => (
              <label key={scope} className="research-export-center__check">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) => toggleScope(scope, event.currentTarget.checked)}
                />
                <span>{copy.scopeLabels[scope]}</span>
              </label>
            ))}
          </div>
          {scopes.length === 0 && <p className="research-export-center__hint">{copy.selectScope}</p>}
        </fieldset>

        <fieldset
          className="research-export-center__card"
          aria-describedby={!supported ? 'export-format-unsupported' : undefined}
        >
          <legend>{copy.formats}</legend>
          <div className="research-export-center__options research-export-center__options--formats">
            {FORMAT_ORDER.map((option) => (
              <label key={option} className="research-export-center__radio">
                <input
                  type="radio"
                  name="research-export-format"
                  value={option}
                  checked={format === option}
                  onChange={() => {
                    setFormat(option);
                    invalidatePreview();
                  }}
                />
                <span>{copy.formatLabels[option]}</span>
              </label>
            ))}
          </div>
          {!supported && (
            <p
              id="export-format-unsupported"
              className="research-export-center__unsupported"
              role="note"
            >
              {copy.formatNotice}
            </p>
          )}
          {supported && showsBinaryFormatNotice(format) && (
            <p
              id="export-format-unsupported"
              className="research-export-center__unsupported"
              role="note"
            >
              {copy.formatNotice}
            </p>
          )}
        </fieldset>

        <fieldset className="research-export-center__card">
          <legend>{copy.privacy}</legend>
          <div className="research-export-center__options">
            {PRIVACY_ORDER.map((profile) => (
              <label key={profile} className="research-export-center__radio">
                <input
                  type="radio"
                  name="research-export-privacy"
                  value={profile}
                  checked={privacyProfile === profile}
                  onChange={() => changePrivacy(profile)}
                />
                <span>{copy.privacyLabels[profile]}</span>
              </label>
            ))}
          </div>
          <p className="research-export-center__hint">{copy.privacyHint}</p>
        </fieldset>

        <fieldset className="research-export-center__card">
          <legend>{copy.redaction}</legend>
          <div className="research-export-center__options">
            <label className="research-export-center__check research-export-center__check--locked">
              <input type="checkbox" checked disabled />
              <span>{copy.redactionLabels.stripSecrets}</span>
            </label>
            {REDACTION_ORDER.map((key) => {
              const forced = privacyProfile !== 'private-local';
              return (
                <label key={key} className="research-export-center__check">
                  <input
                    type="checkbox"
                    checked={forced ? true : redaction[key]}
                    disabled={forced}
                    onChange={(event) => changeRedaction(key, event.currentTarget.checked)}
                  />
                  <span>{copy.redactionLabels[key]}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <section className="research-export-center__destination" aria-labelledby="export-destination-title">
        <div>
          <h3 id="export-destination-title">{copy.destination}</h3>
          <p>{destination ? copy.destinationSelected(destination.displayName) : copy.destinationNone}</p>
        </div>
        <button
          type="button"
          className="research-export-center__button research-export-center__button--secondary"
          onClick={() => void selectDestination()}
          disabled={busy !== null}
        >
          {busy === 'destination' ? copy.selecting : copy.selectDestination}
        </button>
      </section>

      <div className="research-export-center__actions" aria-label={copy.safeSummary}>
        <button
          type="button"
          className="research-export-center__button research-export-center__button--secondary"
          onClick={() => void previewExport()}
          disabled={!canPreview}
        >
          {busy === 'preview' ? copy.previewing : copy.preview}
        </button>
        <button
          type="button"
          className="research-export-center__button research-export-center__button--primary"
          onClick={() => void executeExport()}
          disabled={!canExecute}
          aria-describedby={!previewCurrent && preview ? 'export-preview-outdated' : undefined}
        >
          {busy === 'execute' ? copy.executing : copy.execute}
        </button>
      </div>

      {!artifactBindingAvailable && (
        <p className="research-export-center__message research-export-center__message--error" role="alert">
          {copy.artifactBindingUnavailable}
        </p>
      )}

      {!previewCurrent && preview && (
        <p id="export-preview-outdated" className="research-export-center__hint" role="status">
          {copy.previewOutdated}
        </p>
      )}
      {safeMessage && (
        <p className="research-export-center__message research-export-center__message--error" role="alert">
          {safeMessage}
        </p>
      )}

      {summary && (
        <section
          className={`research-export-center__summary ${summary.result.success ? 'is-success' : 'is-error'}`}
          aria-labelledby="export-summary-title"
          aria-live="polite"
        >
          <h3 id="export-summary-title">
            {summary.result.success
              ? summary.result.code === 'export_preview_ready'
                ? summary.result.previewKind === 'html-intermediate'
                  ? copy.intermediatePreviewComplete
                  : copy.previewComplete
                : copy.exportComplete
              : copy.exportFailed}
          </h3>
          {summary.result.success ? (
            <>
              {summary.result.code === 'export_complete' ? (
                <>
                  <dl>
                    <div><dt>{copy.files}</dt><dd>{summary.result.files.length}</dd></div>
                    <div><dt>{copy.bytes}</dt><dd>{byteFormatter.format(totalBytes)}</dd></div>
                    <div className="research-export-center__checksum">
                      <dt>{copy.checksum}</dt>
                      <dd><code>{summary.result.manifestSha256}</code></dd>
                    </div>
                  </dl>
                  <ul className="research-export-center__file-list">
                    {summary.result.files.map((file) => (
                      <li key={`${file.displayName}:${file.sha256}`}>
                        <span>{file.displayName}</span>
                        <span>{byteFormatter.format(file.byteLength)} B</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <dl>
                    <div><dt>{copy.files}</dt><dd>{summary.result.entries.length}</dd></div>
                    <div><dt>{copy.bytes}</dt><dd>{byteFormatter.format(totalBytes)}</dd></div>
                    <div>
                      <dt>{copy.previewKind}</dt>
                      <dd>{summary.result.previewKind === 'html-intermediate'
                        ? copy.intermediateKind
                        : copy.candidateKind}</dd>
                    </div>
                  </dl>
                  <ul className="research-export-center__file-list">
                    {summary.result.entries.map((entry) => (
                      <li key={`${entry.displayName}:${entry.sha256}`}>
                        <span>{entry.displayName}</span>
                        <span>{byteFormatter.format(entry.byteLength)} B</span>
                        <span>{copy.previewChecksum}: <code>{entry.sha256}</code></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {summary.result.issues.length > 0 && (
                <ul className="research-export-center__issues">
                  {summary.result.issues.map((issue, index) => (
                    <li key={`${issue.code}:${issue.scope ?? 'all'}:${index}`}>
                      {copy.issue[issue.code] ?? copy.exportComplete}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <ul className="research-export-center__issues">
              {summary.result.issues.map((issue, index) => (
                <li key={`${issue.code}:${issue.scope ?? 'all'}:${index}`}>
                  {copy.issue[issue.code] ?? copy.exportFailed}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
