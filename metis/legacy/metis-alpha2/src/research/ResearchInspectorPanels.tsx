import {
  ArchiveRestore,
  Check,
  ChevronRight,
  CircleAlert,
  Link2,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  ResearchArtifactDto,
  ResearchClaimDto,
  ResearchEvidenceDto,
  ResearchNoteCodeDto,
  ResearchProjectDto,
  ResearchRunDto,
  ResearchSourceDto,
} from '../../engine/runtime/ResearchRuntimeContract';
import { useTranslation, type LocaleKey } from '../i18n';
import { showToast } from '../lib/toast';
import RecycleRestore from '../shell/RecycleRestore';
import {
  useResearchWorkspaceStore,
  type ResearchWorkspaceSelection,
} from './researchWorkspaceStore';
import ProjectTasksPanel from './ProjectTasksPanel';
import './ResearchWorkspace.css';

const INSPECTOR_COPY = {
  zh: {
    inspector: '研究检查器',
    chooseItem: '选择要检视的对象',
    project: '项目设计',
    source: '资料来源',
    evidence: '证据摘录',
    noteCode: '笔记与编码',
    claim: '论断',
    artifact: '研究成果',
    run: '执行记录',
    recycleBin: '回收站',
    empty: '当前视图暂无可检视内容。',
    loading: '正在载入项目内容…',
    snapshotUnavailable: '项目快照暂时不可用。',
    refresh: '刷新当前项目',
    title: '标题',
    lifecycle: '研究阶段',
    originalIntent: '原始意图',
    researchQuestion: '研究问题',
    methodology: '研究方法',
    discipline: '学科',
    updatedAt: '最近更新',
    kind: '类型',
    imageSource: '图片文件（安全校验）',
    imageSourceHint: '该资料为图片文件，不暴露本地路径或原始文件内容。',
    purgeImageTitle: '清理已删除图片',
    purgeImageEmpty: '没有可永久清理的已删除图片。',
    purgeImageConfirm: '永久删除后无法恢复，是否继续？',
    purgeImageReferenced: '该图片仍被引用，请先解除引用后再清理。',
    purgeImageFailed: '图片清理失败，请稍后重试。',
    purgeImageButton: '永久清理',
    purgeImageCancel: '取消',
    authors: '作者',
    year: '年份',
    venue: '来源',
    identifier: '标识符',
    externalUrl: '公开链接',
    tags: '标签',
    anchor: '定位锚点',
    sourceLabel: '所属资料',
    openInLibrary: '在资料库中打开',
    reconcileMetadata: '补全元数据',
    reconcilePrompt: '输入 DOI 或论文标题，从 CrossRef 重新匹配题录：',
    reconcileNoMatch: '未找到匹配的题录，请检查输入或换一个关键词。',
    reconcileError: '补全元数据失败，请稍后重试。',
    confidence: '置信度',
    relatedClaims: '关联论断',
    relatedEvidence: '关联证据',
    author: '提出者',
    acceptance: '审核状态',
    content: '内容',
    status: '状态',
    claimType: '论断类型',
    relation: '关系',
    weight: '权重',
    note: '说明',
    addEvidenceLink: '关联证据',
    linkEvidence: '建立关联',
    unlinkEvidence: '解除证据关联',
    noEvidenceToLink: '当前项目还没有可关联的证据。',
    artifactType: '成果类型',
    reviewStatus: '核验状态',
    version: '版本',
    reviewReason: '核验说明',
    reviewReasonPlaceholder: '记录本次审核依据',
    applyReview: '更新核验状态',
    runStatus: '执行状态',
    startedAt: '开始时间',
    completedAt: '完成时间',
    checkpoints: '检查点',
    decisions: '研究决策',
    currentStep: '当前步骤',
    currentStepAvailable: '执行步骤已记录',
    noCurrentStep: '暂无活动步骤',
    delete: '移入回收站',
    deleteConfirm: '再次确认移入回收站',
    cancel: '取消',
    restore: '恢复',
    accept: '接受',
    reject: '拒绝',
    pending: '待审核',
    deletedAt: '删除时间',
    recycledEmpty: '回收站为空。',
    mutationBusy: '正在保存变更…',
    mutationFailed: '变更未保存，请重试。',
    verifiedReasonRequired: '请填写核验说明。',
    unknown: '未提供',
  },
  en: {
    inspector: 'Research inspector',
    chooseItem: 'Choose an item to inspect',
    project: 'Project design',
    source: 'Source',
    evidence: 'Evidence',
    noteCode: 'Note & code',
    claim: 'Claim',
    artifact: 'Research output',
    run: 'Run',
    recycleBin: 'Recycle bin',
    empty: 'There is nothing to inspect in this view yet.',
    loading: 'Loading project context…',
    snapshotUnavailable: 'Project snapshot is temporarily unavailable.',
    refresh: 'Refresh active project',
    title: 'Title',
    lifecycle: 'Research stage',
    originalIntent: 'Original intent',
    researchQuestion: 'Research question',
    methodology: 'Methodology',
    discipline: 'Discipline',
    updatedAt: 'Last updated',
    kind: 'Kind',
    imageSource: 'Image file (security verified)',
    imageSourceHint: 'This source is an image file; local paths and raw bytes are not exposed.',
    purgeImageTitle: 'Purge deleted images',
    purgeImageEmpty: 'No deleted images can be permanently purged.',
    purgeImageConfirm: 'This action cannot be undone. Continue?',
    purgeImageReferenced: 'This image is still referenced; remove references before purging.',
    purgeImageFailed: 'Image purge failed. Try again later.',
    purgeImageButton: 'Purge permanently',
    purgeImageCancel: 'Cancel',
    authors: 'Authors',
    year: 'Year',
    venue: 'Venue',
    identifier: 'Identifier',
    externalUrl: 'Public link',
    tags: 'Tags',
    anchor: 'Anchor',
    sourceLabel: 'Source',
    openInLibrary: 'Open in library',
    reconcileMetadata: 'Fill in metadata',
    reconcilePrompt: 'Enter a DOI or paper title to re-match from CrossRef:',
    reconcileNoMatch: 'No matching record found. Check the input or try another keyword.',
    reconcileError: 'Metadata lookup failed. Please try again later.',
    confidence: 'Confidence',
    relatedClaims: 'Related claims',
    relatedEvidence: 'Related evidence',
    author: 'Author',
    acceptance: 'Review state',
    content: 'Content',
    status: 'Status',
    claimType: 'Claim type',
    relation: 'Relation',
    weight: 'Weight',
    note: 'Note',
    addEvidenceLink: 'Link evidence',
    linkEvidence: 'Create link',
    unlinkEvidence: 'Remove evidence link',
    noEvidenceToLink: 'This project has no evidence available to link.',
    artifactType: 'Output type',
    reviewStatus: 'Review status',
    version: 'Version',
    reviewReason: 'Review note',
    reviewReasonPlaceholder: 'Record the basis for this review',
    applyReview: 'Update review status',
    runStatus: 'Run status',
    startedAt: 'Started',
    completedAt: 'Completed',
    checkpoints: 'Checkpoints',
    decisions: 'Research decisions',
    currentStep: 'Current step',
    currentStepAvailable: 'An execution step is recorded',
    noCurrentStep: 'No active step',
    delete: 'Move to recycle bin',
    deleteConfirm: 'Confirm move to recycle bin',
    cancel: 'Cancel',
    restore: 'Restore',
    accept: 'Accept',
    reject: 'Reject',
    pending: 'Pending',
    deletedAt: 'Deleted',
    recycledEmpty: 'The recycle bin is empty.',
    mutationBusy: 'Saving change…',
    mutationFailed: 'The change was not saved. Try again.',
    verifiedReasonRequired: 'Enter a review note.',
    unknown: 'Not provided',
  },
} as const;

type InspectorCopy = (typeof INSPECTOR_COPY)[LocaleKey];
type CoreEntityKind = Exclude<NonNullable<ResearchWorkspaceSelection>['kind'], 'run'>;

interface InspectorOption {
  kind: NonNullable<ResearchWorkspaceSelection>['kind'];
  id: string;
  label: string;
}

interface DefinitionRowProps {
  label: string;
  children: ReactNode;
}

function DefinitionRow({ label, children }: DefinitionRowProps) {
  return (
    <div className="research-definition-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function formatDate(timestamp: number | null, locale: LocaleKey): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  } catch {
    return '—';
  }
}

function publicUrlLabel(value: string, locale: LocaleKey): string {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    return `${url.hostname}${path === '/' ? '' : path}`;
  } catch {
    return locale === 'zh' ? '公开链接不可用' : 'Public link unavailable';
  }
}

function anchorLabel(
  item: ResearchEvidenceDto,
  copy: InspectorCopy,
  locale: LocaleKey,
): string {
  if (item.anchorType === 'page' && item.pageNumber !== null) {
    return `p. ${item.pageNumber}`;
  }
  if (item.anchorStart !== null && item.anchorEnd !== null) {
    return `${domainLabel(item.anchorType, locale)} ${item.anchorStart}–${item.anchorEnd}`;
  }
  if (item.anchorStart !== null) {
    return `${domainLabel(item.anchorType, locale)} ${item.anchorStart}`;
  }
  return item.anchorType === 'none'
    ? copy.unknown
    : domainLabel(item.anchorType, locale);
}

function domainLabel(value: string, locale: LocaleKey): string {
  const labels: Record<string, { zh: string; en: string }> = {
    paper: { zh: '论文', en: 'Paper' },
    book: { zh: '图书', en: 'Book' },
    pdf: { zh: 'PDF 文档', en: 'PDF document' },
    web: { zh: '网页', en: 'Web page' },
    archive: { zh: '档案', en: 'Archive' },
    image: { zh: '图像', en: 'Image' },
    audio: { zh: '音频', en: 'Audio' },
    data: { zh: '数据', en: 'Data' },
    other: { zh: '其他', en: 'Other' },
    assertion: { zh: '陈述', en: 'Assertion' },
    hypothesis: { zh: '假设', en: 'Hypothesis' },
    finding: { zh: '发现', en: 'Finding' },
    limitation: { zh: '局限', en: 'Limitation' },
    manuscript: { zh: '文稿', en: 'Manuscript' },
    chart: { zh: '图表', en: 'Chart' },
    table: { zh: '表格', en: 'Table' },
    report: { zh: '报告', en: 'Report' },
    network: { zh: '网络图', en: 'Network' },
    page: { zh: '页码', en: 'Page' },
    char_range: { zh: '字符范围', en: 'Character range' },
    timestamp: { zh: '时间点', en: 'Timestamp' },
    region: { zh: '区域', en: 'Region' },
    row: { zh: '数据行', en: 'Row' },
    none: { zh: '未定位', en: 'Unanchored' },
  };
  return labels[value]?.[locale] ?? value.replaceAll('_', ' ');
}

function statusLabel(status: string, locale: LocaleKey): string {
  const labels: Record<string, { zh: string; en: string }> = {
    draft: { zh: '草稿', en: 'Draft' },
    clarified: { zh: '已澄清', en: 'Clarified' },
    planned: { zh: '已规划', en: 'Planned' },
    approved: { zh: '已批准', en: 'Approved' },
    running: { zh: '执行中', en: 'Running' },
    reviewing: { zh: '审核中', en: 'Reviewing' },
    completed: { zh: '已完成', en: 'Completed' },
    archived: { zh: '已归档', en: 'Archived' },
    awaiting_approval: { zh: '等待批准', en: 'Awaiting approval' },
    paused: { zh: '已暂停', en: 'Paused' },
    failed: { zh: '失败', en: 'Failed' },
    cancelled: { zh: '已取消', en: 'Cancelled' },
    pending: { zh: '待审核', en: 'Pending' },
    accepted: { zh: '已接受', en: 'Accepted' },
    rejected: { zh: '已拒绝', en: 'Rejected' },
    partial: { zh: '部分核验', en: 'Partially verified' },
    verified: { zh: '已核验', en: 'Verified' },
    stale: { zh: '需要更新', en: 'Stale' },
    unsupported: { zh: '证据不足', en: 'Unsupported' },
    supported: { zh: '有证据支持', en: 'Supported' },
    contested: { zh: '存在争议', en: 'Contested' },
    refuted: { zh: '已反驳', en: 'Refuted' },
    supports: { zh: '支持', en: 'Supports' },
    contradicts: { zh: '反驳', en: 'Contradicts' },
    qualifies: { zh: '限定', en: 'Qualifies' },
  };
  return labels[status]?.[locale] ?? status.replaceAll('_', ' ');
}

function StatusPill({ status, locale }: { status: string; locale: LocaleKey }) {
  return <span className={`research-status-pill is-${status}`}>{statusLabel(status, locale)}</span>;
}

function ConfidenceMeter({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="research-confidence">
      <span
        className="research-confidence__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </span>
      <span>{percent}%</span>
    </span>
  );
}

function EmptyInspector({ copy }: { copy: InspectorCopy }) {
  return (
    <div className="research-inspector-empty">
      <CircleAlert size={22} aria-hidden="true" />
      <p>{copy.empty}</p>
    </div>
  );
}

interface EntityMutationControlsProps {
  kind: CoreEntityKind;
  id: string;
  projectId: string;
  deleted: boolean;
  loading: boolean;
  copy: InspectorCopy;
}

function EntityMutationControls({
  kind,
  id,
  projectId,
  deleted,
  loading,
  copy,
}: EntityMutationControlsProps) {
  const applyCrud = useResearchWorkspaceStore((state) => state.applyCrud);
  const applyRestore = useResearchWorkspaceStore((state) => state.applyRestore);
  const [confirming, setConfirming] = useState(false);

  if (deleted) {
    return (
      <div className="research-inspector-actions" role="group" aria-label={copy.restore}>
        <button
          type="button"
          className="research-button research-button--primary"
          disabled={loading}
          onClick={() => void applyRestore({
            operation: 'restore',
            projectId,
            entityKind: kind,
            entityId: id,
          })}
        >
          <ArchiveRestore size={15} aria-hidden="true" />
          {copy.restore}
        </button>
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="research-inspector-actions">
        <button
          type="button"
          className="research-button research-button--danger-quiet"
          disabled={loading}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={15} aria-hidden="true" />
          {copy.delete}
        </button>
      </div>
    );
  }

  return (
    <div className="research-delete-confirm" role="group" aria-label={copy.deleteConfirm}>
      <span>{copy.deleteConfirm}</span>
      <button
        type="button"
        className="research-button research-button--danger"
        disabled={loading}
        onClick={() => void applyCrud({
          operation: 'delete',
          entityKind: kind,
          projectId,
          entityId: id,
        })}
      >
        <Trash2 size={14} aria-hidden="true" />
        {copy.delete}
      </button>
      <button
        type="button"
        className="research-icon-button research-icon-button--quiet"
        onClick={() => setConfirming(false)}
        aria-label={copy.cancel}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function InspectorHeader({
  eyebrow,
  title,
  status,
  locale,
}: {
  eyebrow: string;
  title: string;
  status?: string;
  locale: LocaleKey;
}) {
  return (
    <header className="research-inspector-card__header">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      {status && <StatusPill status={status} locale={locale} />}
    </header>
  );
}

function ProjectPanel({
  project,
  copy,
  locale,
  loading,
}: {
  project: ResearchProjectDto;
  copy: InspectorCopy;
  locale: LocaleKey;
  loading: boolean;
}) {
  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.project} title={project.title} status={project.lifecycle} locale={locale} />
      <dl className="research-definition-list">
        <DefinitionRow label={copy.researchQuestion}>{project.researchQuestion || copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.originalIntent}>{project.originalIntent || copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.methodology}>{project.methodology || copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.discipline}>{project.discipline || copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.updatedAt}>{formatDate(project.updatedAt, locale)}</DefinitionRow>
      </dl>
      <EntityMutationControls
        key={project.id}
        kind="project"
        id={project.id}
        projectId={project.id}
        deleted={project.deletedAt !== null}
        loading={loading}
        copy={copy}
      />
    </article>
  );
}

function SourcePanel({
  source,
  copy,
  locale,
  loading,
}: {
  source: ResearchSourceDto;
  copy: InspectorCopy;
  locale: LocaleKey;
  loading: boolean;
}) {
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileInput, setReconcileInput] = useState(source.identifier || source.title);

  const reconcile = async () => {
    const input = reconcileInput.trim();
    if (!input) return;
    const isDoi = /^10\./.test(input);
    setReconcileOpen(false);
    try {
      const result = await window.metis?.reconcilePaper({
        paperId: source.libraryPaperId ?? source.id,
        doi: isDoi ? input : undefined,
        title: isDoi ? undefined : input,
      });
      if (result?.ok) {
        window.location.reload();
      } else {
        showToast({ kind: 'error', text: result?.error === 'no_match' ? copy.reconcileNoMatch : copy.reconcileError });
      }
    } catch {
      showToast({ kind: 'error', text: copy.reconcileError });
    }
  };

  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.source} title={source.title} locale={locale} />
      <dl className="research-definition-list">
        <DefinitionRow label={copy.kind}>
          {source.kind === 'image' ? (
            <span className="research-image-source-badge">
              {domainLabel(source.kind, locale)}
              <span className="research-image-source-badge__hint" aria-label={copy.imageSourceHint}>
                {copy.imageSource}
              </span>
            </span>
          ) : (
            domainLabel(source.kind, locale)
          )}
        </DefinitionRow>
        <DefinitionRow label={copy.authors}>{source.authors.join(', ') || copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.year}>{source.year ?? copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.venue}>{source.venue || copy.unknown}</DefinitionRow>
        {source.kind !== 'image' && (
          <DefinitionRow label={copy.identifier}>{source.identifier || copy.unknown}</DefinitionRow>
        )}
        <DefinitionRow label={copy.externalUrl}>
          {source.externalUrl ? publicUrlLabel(source.externalUrl, locale) : copy.unknown}
        </DefinitionRow>
        <DefinitionRow label={copy.tags}>
          {source.tags.length > 0 ? (
            <span className="research-tag-list">
              {source.tags.map((tag) => <span key={tag}>{tag}</span>)}
            </span>
          ) : copy.unknown}
        </DefinitionRow>
        <DefinitionRow label={copy.updatedAt}>{formatDate(source.updatedAt, locale)}</DefinitionRow>
      </dl>
      {source.kind === 'paper' && (
        <>
          <button
            className="btn-sm btn-secondary"
            style={{ marginTop: 8, marginRight: 8 }}
            data-testid="source-open-in-library"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('metis:open-paper', {
                detail: { paperId: source.libraryPaperId ?? source.id },
              }));
            }}
          >
            {copy.openInLibrary}
          </button>
          <button
            className="btn-sm btn-secondary"
            style={{ marginTop: 8 }}
            data-testid="source-reconcile"
            onClick={() => {
              setReconcileInput(source.identifier || source.title);
              setReconcileOpen(true);
            }}
          >
            {copy.reconcileMetadata}
          </button>
        </>
      )}
      {reconcileOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="reconcile-title">
          <div className="modal-content">
            <h3 id="reconcile-title">{copy.reconcileMetadata}</h3>
            <p style={{ fontSize: 14, color: 'var(--text-body)', marginBottom: 12 }}>{copy.reconcilePrompt}</p>
            <input
              className="settings-input"
              value={reconcileInput}
              onChange={(event) => setReconcileInput(event.target.value)}
              autoFocus
              data-testid="source-reconcile-input"
            />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setReconcileOpen(false)}>{copy.cancel}</button>
              <button type="button" className="btn-primary" onClick={() => void reconcile()} disabled={!reconcileInput.trim()}>{copy.reconcileMetadata}</button>
            </div>
          </div>
        </div>
      )}
      <EntityMutationControls
        key={source.id}
        kind="source"
        id={source.id}
        projectId={source.projectId}
        deleted={source.deletedAt !== null}
        loading={loading}
        copy={copy}
      />
    </article>
  );
}

function EvidencePanel({
  evidence,
  source,
  relatedClaims,
  copy,
  locale,
  loading,
}: {
  evidence: ResearchEvidenceDto;
  source: ResearchSourceDto | undefined;
  relatedClaims: ResearchClaimDto[];
  copy: InspectorCopy;
  locale: LocaleKey;
  loading: boolean;
}) {
  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.evidence} title={source?.title ?? copy.evidence} locale={locale} />
      <blockquote className="research-evidence-quote">{evidence.snippet || copy.unknown}</blockquote>
      <dl className="research-definition-list">
        <DefinitionRow label={copy.sourceLabel}>{source?.title ?? copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.anchor}>{anchorLabel(evidence, copy, locale)}</DefinitionRow>
        <DefinitionRow label={copy.confidence}>
          <ConfidenceMeter value={evidence.confidence} label={copy.confidence} />
        </DefinitionRow>
        <DefinitionRow label={copy.relatedClaims}>
          {relatedClaims.length > 0 ? (
            <ul className="research-related-list">
              {relatedClaims.map((claim) => <li key={claim.id}>{claim.statement}</li>)}
            </ul>
          ) : copy.unknown}
        </DefinitionRow>
        <DefinitionRow label={copy.updatedAt}>{formatDate(evidence.updatedAt, locale)}</DefinitionRow>
      </dl>
      <EntityMutationControls
        key={evidence.id}
        kind="evidence"
        id={evidence.id}
        projectId={evidence.projectId}
        deleted={evidence.deletedAt !== null}
        loading={loading}
        copy={copy}
      />
    </article>
  );
}

function NoteCodePanel({
  noteCode,
  evidence,
  copy,
  locale,
  loading,
}: {
  noteCode: ResearchNoteCodeDto;
  evidence: ResearchEvidenceDto | undefined;
  copy: InspectorCopy;
  locale: LocaleKey;
  loading: boolean;
}) {
  const applyReview = useResearchWorkspaceStore((state) => state.applyReview);
  const review = (decision: ResearchNoteCodeDto['accepted']) => applyReview({
    operation: 'review',
    reviewKind: 'note_code',
    projectId: noteCode.projectId,
    entityId: noteCode.id,
    decision,
    reason: '',
  });

  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.noteCode} title={noteCode.code || copy.noteCode} status={noteCode.accepted} locale={locale} />
      <p className="research-inspector-prose">{noteCode.content || copy.unknown}</p>
      <dl className="research-definition-list">
        <DefinitionRow label={copy.author}>{noteCode.author === 'ai' ? 'AI' : locale === 'zh' ? '研究者' : 'Researcher'}</DefinitionRow>
        <DefinitionRow label={copy.confidence}>
          <ConfidenceMeter value={noteCode.confidence} label={copy.confidence} />
        </DefinitionRow>
        <DefinitionRow label={copy.evidence}>{evidence?.snippet || copy.unknown}</DefinitionRow>
        <DefinitionRow label={copy.tags}>
          {noteCode.tags.length > 0 ? (
            <span className="research-tag-list">
              {noteCode.tags.map((tag) => <span key={tag}>{tag}</span>)}
            </span>
          ) : copy.unknown}
        </DefinitionRow>
      </dl>
      {noteCode.deletedAt === null && (
        <div className="research-review-actions" role="group" aria-label={copy.acceptance}>
          <button
            type="button"
            className={noteCode.accepted === 'accepted' ? 'is-selected' : ''}
            onClick={() => void review('accepted')}
            disabled={loading}
          >
            <Check size={14} aria-hidden="true" />
            {copy.accept}
          </button>
          <button
            type="button"
            className={noteCode.accepted === 'pending' ? 'is-selected' : ''}
            onClick={() => void review('pending')}
            disabled={loading}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {copy.pending}
          </button>
          <button
            type="button"
            className={noteCode.accepted === 'rejected' ? 'is-selected is-rejected' : ''}
            onClick={() => void review('rejected')}
            disabled={loading}
          >
            <X size={14} aria-hidden="true" />
            {copy.reject}
          </button>
        </div>
      )}
      <EntityMutationControls
        key={noteCode.id}
        kind="note_code"
        id={noteCode.id}
        projectId={noteCode.projectId}
        deleted={noteCode.deletedAt !== null}
        loading={loading}
        copy={copy}
      />
    </article>
  );
}

function makeLinkId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `link-${crypto.randomUUID()}`;
    }
  } catch {
    // Use a bounded local fallback.
  }
  return `link-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ClaimPanel({
  claim,
  evidenceItems,
  copy,
  locale,
  loading,
}: {
  claim: ResearchClaimDto;
  evidenceItems: ResearchEvidenceDto[];
  copy: InspectorCopy;
  locale: LocaleKey;
  loading: boolean;
}) {
  const snapshot = useResearchWorkspaceStore((state) => state.snapshot);
  const applyLink = useResearchWorkspaceStore((state) => state.applyLink);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(evidenceItems[0]?.id ?? '');
  const evidenceId = evidenceItems.find((item) => item.id === selectedEvidenceId)?.id
    ?? evidenceItems[0]?.id
    ?? '';
  const [relation, setRelation] = useState<'supports' | 'contradicts' | 'qualifies'>('supports');
  const [weight, setWeight] = useState(1);
  const [note, setNote] = useState('');
  const relationLabelId = useId();

  const links = snapshot?.claimEvidenceLinks.filter((link) => link.claimId === claim.id) ?? [];

  const submitLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!evidenceId) return;
    const result = await applyLink({
      operation: 'link',
      projectId: claim.projectId,
      link: {
        id: makeLinkId(),
        claimId: claim.id,
        evidenceId,
        relation,
        weight,
        note: note.trim(),
      },
    });
    if (result.success) setNote('');
  };

  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.claim} title={claim.statement} status={claim.status} locale={locale} />
      <dl className="research-definition-list">
        <DefinitionRow label={copy.claimType}>{domainLabel(claim.claimType, locale)}</DefinitionRow>
        <DefinitionRow label={copy.confidence}>
          <ConfidenceMeter value={claim.confidence} label={copy.confidence} />
        </DefinitionRow>
        <DefinitionRow label={copy.relatedEvidence}>
          {links.length > 0 ? (
            <ul className="research-link-list">
              {links.map((link) => {
                const evidence = evidenceItems.find((item) => item.id === link.evidenceId);
                return (
                  <li key={link.id}>
                    <span>
                      <StatusPill status={link.relation} locale={locale} />
                      {evidence?.snippet || copy.evidence}
                    </span>
                    <button
                      type="button"
                      className="research-icon-button research-icon-button--quiet"
                      disabled={loading}
                      onClick={() => void applyLink({
                        operation: 'unlink',
                        projectId: claim.projectId,
                        linkId: link.id,
                      })}
                      aria-label={copy.unlinkEvidence}
                    >
                      <Unlink size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : copy.unknown}
        </DefinitionRow>
      </dl>

      {claim.deletedAt === null && (
        <form className="research-link-form" onSubmit={(event) => void submitLink(event)} aria-labelledby={relationLabelId}>
          <strong id={relationLabelId}>
            <Link2 size={15} aria-hidden="true" />
            {copy.addEvidenceLink}
          </strong>
          {evidenceItems.length === 0 ? (
            <p>{copy.noEvidenceToLink}</p>
          ) : (
            <>
              <label>
                <span>{copy.evidence}</span>
                <select value={evidenceId} onChange={(event) => setSelectedEvidenceId(event.target.value)}>
                  {evidenceItems.map((item) => (
                    <option key={item.id} value={item.id}>{item.snippet || copy.evidence}</option>
                  ))}
                </select>
              </label>
              <div className="research-link-form__row">
                <label>
                  <span>{copy.relation}</span>
                  <select
                    value={relation}
                    onChange={(event) => setRelation(event.target.value as typeof relation)}
                  >
                    <option value="supports">{locale === 'zh' ? '支持' : 'Supports'}</option>
                    <option value="contradicts">{locale === 'zh' ? '反驳' : 'Contradicts'}</option>
                    <option value="qualifies">{locale === 'zh' ? '限定' : 'Qualifies'}</option>
                  </select>
                </label>
                <label>
                  <span>{copy.weight}: {weight.toFixed(1)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={weight}
                    onChange={(event) => setWeight(Number(event.target.value))}
                  />
                </label>
              </div>
              <label>
                <span>{copy.note}</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={8_000} rows={2} />
              </label>
              <button type="submit" className="research-button research-button--primary" disabled={loading || !evidenceId}>
                <Link2 size={14} aria-hidden="true" />
                {copy.linkEvidence}
              </button>
            </>
          )}
        </form>
      )}

      <EntityMutationControls
        key={claim.id}
        kind="claim"
        id={claim.id}
        projectId={claim.projectId}
        deleted={claim.deletedAt !== null}
        loading={loading}
        copy={copy}
      />
    </article>
  );
}

function ArtifactPanel({
  artifact,
  copy,
  locale,
  loading,
}: {
  artifact: ResearchArtifactDto;
  copy: InspectorCopy;
  locale: LocaleKey;
  loading: boolean;
}) {
  const applyReview = useResearchWorkspaceStore((state) => state.applyReview);
  const [status, setStatus] = useState<ResearchArtifactDto['reviewStatus']>(artifact.reviewStatus);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const reasonId = useId();

  const submitReview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      setFormError(copy.verifiedReasonRequired);
      return;
    }
    const result = await applyReview({
      operation: 'review',
      reviewKind: 'artifact',
      projectId: artifact.projectId,
      entityId: artifact.id,
      expectedVersion: artifact.version,
      toStatus: status,
      reason: normalizedReason,
    });
    if (result.success) {
      setReason('');
      setFormError('');
    }
  };

  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.artifact} title={artifact.title} status={artifact.reviewStatus} locale={locale} />
      <dl className="research-definition-list">
        <DefinitionRow label={copy.artifactType}>{domainLabel(artifact.artifactType, locale)}</DefinitionRow>
        <DefinitionRow label={copy.version}>{artifact.version}</DefinitionRow>
        <DefinitionRow label={copy.updatedAt}>{formatDate(artifact.updatedAt, locale)}</DefinitionRow>
      </dl>
      {artifact.deletedAt === null && (
        <form className="research-review-form" onSubmit={(event) => void submitReview(event)}>
          <label>
            <span>{copy.reviewStatus}</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ResearchArtifactDto['reviewStatus'])}
            >
              {(['draft', 'pending', 'partial', 'verified', 'stale'] as const).map((value) => (
                <option key={value} value={value}>{statusLabel(value, locale)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{copy.reviewReason}</span>
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (formError) setFormError('');
              }}
              rows={3}
              maxLength={8_000}
              placeholder={copy.reviewReasonPlaceholder}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? reasonId : undefined}
            />
          </label>
          {formError && <p id={reasonId} className="research-workspace-form-error" role="alert">{formError}</p>}
          <button type="submit" className="research-button research-button--primary" disabled={loading}>
            <Check size={14} aria-hidden="true" />
            {copy.applyReview}
          </button>
        </form>
      )}
      <EntityMutationControls
        key={artifact.id}
        kind="artifact"
        id={artifact.id}
        projectId={artifact.projectId}
        deleted={artifact.deletedAt !== null}
        loading={loading}
        copy={copy}
      />
    </article>
  );
}

function ManagedImagePurgePanel({
  projectId,
  sources,
  copy,
  loading,
}: {
  projectId: string;
  sources: ResearchSourceDto[];
  copy: InspectorCopy;
  loading: boolean;
}) {
  const applyPurgeMedia = useResearchWorkspaceStore((state) => state.applyPurgeMedia);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{ id: string; code: string } | null>(null);

  if (sources.length === 0) {
    return (
      <div className="research-inspector-empty">
        <CircleAlert size={22} aria-hidden="true" />
        <p>{copy.purgeImageEmpty}</p>
      </div>
    );
  }

  return (
    <section className="research-image-purge-panel" aria-labelledby="research-image-purge-title">
      <strong id="research-image-purge-title">{copy.purgeImageTitle}</strong>
      <ul className="research-image-purge-list" role="list" aria-label={copy.purgeImageTitle}>
        {sources.map((source) => {
          const confirming = confirmingId === source.id;
          const error = errorState?.id === source.id
            ? (errorState.code === 'research_media_referenced' ? copy.purgeImageReferenced : copy.purgeImageFailed)
            : null;
          return (
            <li key={source.id} className="research-image-purge-item">
              <span className="research-image-purge-item__name">{source.title}</span>
              {!confirming ? (
                <button
                  type="button"
                  className="research-button research-button--danger-quiet"
                  disabled={loading}
                  onClick={() => {
                    setErrorState(null);
                    setConfirmingId(source.id);
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  {copy.purgeImageButton}
                </button>
              ) : (
                <div className="research-delete-confirm research-image-purge-confirm" role="group" aria-label={copy.purgeImageConfirm}>
                  <span>{copy.purgeImageConfirm}</span>
                  <button
                    type="button"
                    className="research-button research-button--danger"
                    disabled={loading}
                    onClick={() => void (async () => {
                      const result = await applyPurgeMedia({
                        projectId,
                        sourceId: source.id,
                      });
                      if (!result.success) {
                        setErrorState({ id: source.id, code: result.code ?? 'research_media_unavailable' });
                        setConfirmingId(null);
                        return;
                      }
                      setErrorState(null);
                      setConfirmingId(null);
                    })()}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    {copy.purgeImageButton}
                  </button>
                  <button
                    type="button"
                    className="research-icon-button research-icon-button--quiet"
                    onClick={() => setConfirmingId(null)}
                    aria-label={copy.purgeImageCancel}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {error && (
                <p className="research-workspace-form-error" role="alert">
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RunPanel({
  run,
  copy,
  locale,
}: {
  run: ResearchRunDto;
  copy: InspectorCopy;
  locale: LocaleKey;
}) {
  const snapshot = useResearchWorkspaceStore((state) => state.snapshot);
  const checkpoints = snapshot?.checkpoints.filter((item) => item.runId === run.id) ?? [];
  const decisions = snapshot?.decisions.filter((item) => item.runId === run.id) ?? [];
  return (
    <article className="research-inspector-card">
      <InspectorHeader eyebrow={copy.run} title={statusLabel(run.status, locale)} status={run.status} locale={locale} />
      <dl className="research-definition-list">
        <DefinitionRow label={copy.startedAt}>{formatDate(run.createdAt, locale)}</DefinitionRow>
        <DefinitionRow label={copy.completedAt}>{formatDate(run.completedAt, locale)}</DefinitionRow>
        <DefinitionRow label={copy.currentStep}>
          {run.currentStepId ? copy.currentStepAvailable : copy.noCurrentStep}
        </DefinitionRow>
        <DefinitionRow label={copy.checkpoints}>{checkpoints.length}</DefinitionRow>
        <DefinitionRow label={copy.decisions}>{decisions.length}</DefinitionRow>
      </dl>
      {checkpoints.length > 0 && (
        <ol className="research-timeline-list">
          {checkpoints.slice(-5).map((checkpoint) => (
            <li key={checkpoint.id}>
              <span aria-hidden="true" />
              <div>
                <strong>{statusLabel(checkpoint.lifecycle, locale)}</strong>
                <small>{formatDate(checkpoint.createdAt, locale)}</small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export interface ResearchInspectorPanelsProps {
  className?: string;
}

export default function ResearchInspectorPanels({ className = '' }: ResearchInspectorPanelsProps) {
  const { locale } = useTranslation();
  const copy = INSPECTOR_COPY[locale];
  const snapshot = useResearchWorkspaceStore((state) => state.snapshot);
  const section = useResearchWorkspaceStore((state) => state.activeSection);
  const selection = useResearchWorkspaceStore((state) => state.selection);
  const loading = useResearchWorkspaceStore((state) => state.loading);
  const error = useResearchWorkspaceStore((state) => state.error);
  const selectItem = useResearchWorkspaceStore((state) => state.selectItem);
  const refreshActiveProject = useResearchWorkspaceStore((state) => state.refreshActiveProject);
  const applyRestore = useResearchWorkspaceStore((state) => state.applyRestore);
  const applyCrud = useResearchWorkspaceStore((state) => state.applyCrud);
  const clearSelectedIds = useResearchWorkspaceStore((state) => state.clearSelectedIds);
  const pickerId = useId();

  const options = useMemo<InspectorOption[]>(() => {
    if (!snapshot) return [];
    if (section === 'project') return [{ kind: 'project', id: snapshot.project.id, label: snapshot.project.title }];
    if (section === 'sources') return snapshot.sources
      .filter((item) => item.deletedAt === null)
      .map((item) => ({ kind: 'source', id: item.id, label: item.title }));
    if (section === 'evidence') return snapshot.evidence
      .filter((item) => item.deletedAt === null)
      .map((item) => ({ kind: 'evidence', id: item.id, label: item.snippet || copy.evidence }));
    if (section === 'note_codes') return snapshot.noteCodes
      .filter((item) => item.deletedAt === null)
      .map((item) => ({ kind: 'note_code', id: item.id, label: item.code || copy.noteCode }));
    if (section === 'claims') return snapshot.claims
      .filter((item) => item.deletedAt === null)
      .map((item) => ({ kind: 'claim', id: item.id, label: item.statement }));
    if (section === 'artifacts') return snapshot.artifacts
      .filter((item) => item.deletedAt === null)
      .map((item) => ({ kind: 'artifact', id: item.id, label: item.title }));
    if (section === 'runs') return snapshot.runs
      .filter((item) => item.deletedAt === null)
      .map((item, index) => ({
        kind: 'run',
        id: item.id,
        label: `${statusLabel(item.status, locale)} · ${formatDate(item.createdAt, locale)} · ${index + 1}`,
      }));
    return [];
  }, [copy.evidence, copy.noteCode, locale, section, snapshot]);

  const effectiveOption = options.find((option) => (
    option.id === selection?.id && option.kind === selection?.kind
  )) ?? options[0];

  const recycleItems = useMemo(() => {
    if (!snapshot) return [];
    const items: import('../shell/RecycleRestore').RecycleItem[] = [];
    const add = (
      kind: import('../shell/RecycleRestore').RecycleEntityType,
      entity: { id: string; title?: string; statement?: string; snippet?: string; code?: string; deletedAt: number | null; projectId?: string },
      allowPermanentDelete = true,
    ) => {
      if (entity.deletedAt === null) return;
      const title = entity.title ?? entity.statement ?? entity.snippet ?? entity.code ?? '—';
      items.push({
        id: entity.id,
        title,
        entityType: kind,
        deletedAt: entity.deletedAt,
        originalLocation: snapshot.project.title,
        ...(allowPermanentDelete ? {} : { allowPermanentDelete: false }),
      });
    };
    add('project', snapshot.project);
    snapshot.sources.forEach((source) => add('source', source, source.kind !== 'image'));
    snapshot.evidence.forEach((evidence) => add('evidence', evidence));
    snapshot.noteCodes.forEach((noteCode) => add('note', noteCode));
    snapshot.claims.forEach((claim) => add('analysis', claim));
    snapshot.artifacts.forEach((artifact) => add('write', artifact));
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  }, [snapshot]);

  const deletedImageSources = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.sources
      .filter((source): source is typeof source & { deletedAt: number } => (
        source.kind === 'image' && source.deletedAt !== null
      ))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }, [snapshot]);

  useEffect(() => {
    if (!effectiveOption) {
      if (selection !== null && section !== 'recycle_bin') selectItem(null);
      return;
    }
    if (selection?.id !== effectiveOption.id || selection?.kind !== effectiveOption.kind) {
      selectItem({ kind: effectiveOption.kind, id: effectiveOption.id });
    }
  }, [effectiveOption, section, selectItem, selection]);

  let content: ReactNode = <EmptyInspector copy={copy} />;
  if (snapshot && section === 'goals') {
    content = <ProjectTasksPanel projectId={snapshot.project.id} />;
  } else if (snapshot && section === 'recycle_bin') {
    content = (
      <>
        <RecycleRestore
          items={recycleItems}
          loading={loading.snapshot}
          error={error?.operation === 'load_snapshot' ? copy.snapshotUnavailable : null}
          onRefresh={refreshActiveProject}
          onRestore={async (ids) => {
          for (const id of ids) {
            const item = recycleItems.find((candidate) => candidate.id === id);
            if (!item) continue;
            const kindMap: Record<string, import('../shell/RecycleRestore').RecycleEntityType> = {
              project: 'project',
              source: 'source',
              evidence: 'evidence',
              note: 'note_code',
              analysis: 'claim',
              write: 'artifact',
            };
            const entityKind = kindMap[item.entityType] ?? 'source';
            await applyRestore({
              operation: 'restore',
              projectId: snapshot.project.id,
              entityKind: entityKind as 'project' | 'source' | 'evidence' | 'note_code' | 'claim' | 'artifact',
              entityId: item.id,
            });
          }
          clearSelectedIds();
        }}
        onDeleteForever={async (ids) => {
          for (const id of ids) {
            const item = recycleItems.find((candidate) => candidate.id === id);
            if (!item) continue;
            const kindMap: Record<string, import('../shell/RecycleRestore').RecycleEntityType> = {
              project: 'project',
              source: 'source',
              evidence: 'evidence',
              note: 'note_code',
              analysis: 'claim',
              write: 'artifact',
            };
            const entityKind = kindMap[item.entityType] ?? 'source';
            if (
              entityKind === 'source'
              && snapshot.sources.some((source) => source.id === id && source.kind === 'image')
            ) {
              throw new Error('Image sources require the managed media purge flow');
            }
            const result = await applyCrud({
              operation: 'delete',
              projectId: snapshot.project.id,
              entityKind: entityKind as 'project' | 'source' | 'evidence' | 'note_code' | 'claim' | 'artifact',
              entityId: item.id,
            });
            if (!result.success) throw new Error('Permanent deletion is unavailable');
          }
          clearSelectedIds();
        }}
      />
        <div className="research-image-purge-separator" role="separator" aria-label={copy.purgeImageTitle} />
        <ManagedImagePurgePanel
          projectId={snapshot.project.id}
          sources={deletedImageSources}
          copy={copy}
          loading={loading.mutation}
        />
      </>
    );
  } else if (snapshot && effectiveOption?.kind === 'project') {
    content = <ProjectPanel project={snapshot.project} copy={copy} locale={locale} loading={loading.mutation} />;
  } else if (snapshot && effectiveOption?.kind === 'source') {
    const source = snapshot.sources.find((item) => item.id === effectiveOption.id);
    if (source) content = <SourcePanel source={source} copy={copy} locale={locale} loading={loading.mutation} />;
  } else if (snapshot && effectiveOption?.kind === 'evidence') {
    const evidence = snapshot.evidence.find((item) => item.id === effectiveOption.id);
    if (evidence) {
      const links = snapshot.claimEvidenceLinks.filter((link) => link.evidenceId === evidence.id);
      const relatedClaims = links
        .map((link) => snapshot.claims.find((claim) => claim.id === link.claimId))
        .filter((claim): claim is ResearchClaimDto => claim !== undefined);
      content = (
        <EvidencePanel
          evidence={evidence}
          source={snapshot.sources.find((item) => item.id === evidence.sourceId)}
          relatedClaims={relatedClaims}
          copy={copy}
          locale={locale}
          loading={loading.mutation}
        />
      );
    }
  } else if (snapshot && effectiveOption?.kind === 'note_code') {
    const noteCode = snapshot.noteCodes.find((item) => item.id === effectiveOption.id);
    if (noteCode) {
      content = (
        <NoteCodePanel
          noteCode={noteCode}
          evidence={noteCode.evidenceId
            ? snapshot.evidence.find((item) => item.id === noteCode.evidenceId)
            : undefined}
          copy={copy}
          locale={locale}
          loading={loading.mutation}
        />
      );
    }
  } else if (snapshot && effectiveOption?.kind === 'claim') {
    const claim = snapshot.claims.find((item) => item.id === effectiveOption.id);
    if (claim) {
      content = (
        <ClaimPanel
          claim={claim}
          evidenceItems={snapshot.evidence.filter((item) => item.deletedAt === null)}
          copy={copy}
          locale={locale}
          loading={loading.mutation}
        />
      );
    }
  } else if (snapshot && effectiveOption?.kind === 'artifact') {
    const artifact = snapshot.artifacts.find((item) => item.id === effectiveOption.id);
    if (artifact) content = <ArtifactPanel key={artifact.id} artifact={artifact} copy={copy} locale={locale} loading={loading.mutation} />;
  } else if (snapshot && effectiveOption?.kind === 'run') {
    const run = snapshot.runs.find((item) => item.id === effectiveOption.id);
    if (run) content = <RunPanel run={run} copy={copy} locale={locale} />;
  }

  return (
    <section className={`research-inspector ${className}`.trim()} aria-label={copy.inspector}>
      <div className="research-inspector-toolbar">
        <div>
          <span>{copy.inspector}</span>
          <strong>{snapshot?.project.title ?? copy.empty}</strong>
        </div>
        <button
          type="button"
          className="research-icon-button"
          onClick={() => void refreshActiveProject()}
          disabled={!snapshot || loading.snapshot}
          aria-label={copy.refresh}
        >
          <RefreshCw size={15} className={loading.snapshot ? 'is-spinning' : undefined} aria-hidden="true" />
        </button>
      </div>

      {loading.snapshot && !snapshot ? (
        <div className="research-workspace-loading" role="status">
          <LoaderCircle size={16} className="is-spinning" aria-hidden="true" />
          {copy.loading}
        </div>
      ) : (
        <>
          {section !== 'recycle_bin' && options.length > 1 && (
            <label className="research-inspector-picker" htmlFor={pickerId}>
              <span>{copy.chooseItem}</span>
              <span className="research-inspector-picker__control">
                <select
                  id={pickerId}
                  value={effectiveOption ? `${effectiveOption.kind}:${effectiveOption.id}` : ''}
                  onChange={(event) => {
                    const next = options.find((option) => `${option.kind}:${option.id}` === event.target.value);
                    if (next) selectItem({ kind: next.kind, id: next.id });
                  }}
                >
                  {options.map((option) => (
                    <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronRight size={14} aria-hidden="true" />
              </span>
            </label>
          )}
          <div className="research-inspector-scroll">{content}</div>
        </>
      )}

      <div className="research-inspector-live" role="status" aria-live="polite" aria-atomic="true">
        {loading.mutation ? (
          <><LoaderCircle size={13} className="is-spinning" aria-hidden="true" /> {copy.mutationBusy}</>
        ) : error?.operation && !['load_projects', 'load_snapshot'].includes(error.operation) ? (
          <><CircleAlert size={13} aria-hidden="true" /> {copy.mutationFailed}</>
        ) : null}
      </div>
    </section>
  );
}

export { INSPECTOR_COPY };
