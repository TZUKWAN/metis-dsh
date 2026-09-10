/**
 * ImportCreateDialog — modal wizard for creating a research project or importing files.
 *
 * Supports:
 *   • Step-by-step form (start → create / import → progress → result)
 *   • Drag-and-drop file upload for JSON / Markdown / CSV
 *   • Per-file read progress, validation errors, and recovery
 *   • Loading / empty / error / success states with retry
 *   • Keyboard focus trap, Escape to close, arrow navigation on start choices
 *   • RTL via CSS logical properties
 *   • forced-colors and prefers-reduced-motion support
 *   • data-responsive-band narrow/medium/wide adaptation
 *
 * All backend-dependent actions are exposed through props callbacks; this component
 * never fakes a server result.
 */

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderPlus,
  LoaderCircle,
  RotateCcw,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import './ImportCreateDialog.css';

export interface CreateProjectPayload {
  name: string;
  description: string;
}

export interface CreateProjectResult {
  success: boolean;
  projectId?: string;
  error?: string;
}

export interface ImportFileError {
  fileName: string;
  message: string;
}

export interface ImportFilesResult {
  success: boolean;
  imported?: string[];
  errors?: ImportFileError[];
}

export interface ImportCreateDialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Called when the dialog requests to close. */
  onClose: () => void;
  /** Called to create a project. Required for the create path. */
  onCreateProject?: (payload: CreateProjectPayload) => Promise<CreateProjectResult>;
  /** Called to import the selected files. Required for the import path. */
  onImportFiles?: (files: File[], meta: { projectId?: string }) => Promise<ImportFilesResult>;
  /** Which mode to open initially; if omitted a start chooser is shown. */
  initialMode?: 'create' | 'import';
  /** Optional project id to associate imports with. */
  projectId?: string;
  /** Accessible dialog title. */
  title?: string;
  /** Additional CSS class on the root element. */
  className?: string;
}

type Step = 'start' | 'create' | 'import' | 'progress' | 'result';
type ImportFileStatus = 'pending' | 'reading' | 'ready' | 'importing' | 'success' | 'error';
type ResponsiveBand = 'wide' | 'medium' | 'narrow';

interface ImportFileItem {
  id: string;
  file: File;
  status: ImportFileStatus;
  progress: number;
  error?: string;
  preview?: string;
}

interface ImportResultState {
  type: 'success' | 'error';
  title: string;
  message: string;
  details?: string[];
}

const COPY = {
  zh: {
    dialogTitle: '导入 / 创建',
    close: '关闭对话框',
    startTitle: '选择操作',
    startHint: '创建新项目，或从本地文件导入资料。',
    createProject: '创建项目',
    createProjectDesc: '新建一个研究项目，用于持续积累资料与证据。',
    importFiles: '导入文件',
    importFilesDesc: '导入 JSON、Markdown 或 CSV 文件到当前工作台。',
    next: '下一步',
    back: '返回',
    cancel: '取消',
    retry: '重试',
    done: '完成',
    projectName: '项目名称',
    projectNamePlaceholder: '例如：生成式 AI 对科研写作的影响',
    projectDescription: '研究描述（可选）',
    projectDescriptionPlaceholder: '一句话记录研究目标或背景',
    requiredName: '请输入项目名称。',
    createFailed: '项目创建失败',
    createHandlerMissing: '创建接口尚未接入，无法保存项目。',
    projectCreated: '项目已创建',
    projectCreatedMessage: (name: string) => `项目“${name}”已创建。`,
    dropHint: '拖拽文件到此处，或点击选择文件',
    dropActiveHint: '松开以添加文件',
    acceptedFormats: '支持 JSON、Markdown、CSV',
    fileListTitle: '待导入文件',
    emptyFileList: '尚未选择文件。拖入或点击上方区域添加。',
    removeFile: '移除',
    fileReady: '已就绪',
    fileReading: '读取中…',
    fileImporting: '导入中…',
    fileSuccess: '导入成功',
    fileError: '校验失败',
    unsupportedFile: '不支持的文件格式，仅接受 JSON / Markdown / CSV。',
    fileTooLarge: '文件过大，请拆分为更小的文件。',
    readFailed: '文件读取失败，请检查文件是否损坏。',
    invalidJson: 'JSON 格式无效。',
    importFailed: '导入失败',
    importHandlerMissing: '导入接口尚未接入，无法上传文件。',
    importSuccess: '导入完成',
    importedNFiles: (count: number) => `已成功导入 ${count} 个文件。`,
    importProgressTitle: '正在导入…',
    resultErrorHint: '请检查文件后重试，或取消并稍后操作。',
    loading: '处理中…',
    noDetails: '无详细信息',
  },
  en: {
    dialogTitle: 'Import / Create',
    close: 'Close dialog',
    startTitle: 'Choose an action',
    startHint: 'Create a new project or import local files.',
    createProject: 'Create project',
    createProjectDesc: 'Create a research project to collect sources and evidence.',
    importFiles: 'Import files',
    importFilesDesc: 'Import JSON, Markdown, or CSV files into the workspace.',
    next: 'Next',
    back: 'Back',
    cancel: 'Cancel',
    retry: 'Retry',
    done: 'Done',
    projectName: 'Project name',
    projectNamePlaceholder: 'Example: How generative AI changes research writing',
    projectDescription: 'Description (optional)',
    projectDescriptionPlaceholder: 'Capture the research goal in one sentence',
    requiredName: 'Enter a project name.',
    createFailed: 'Failed to create project',
    createHandlerMissing: 'The create interface is not connected; the project cannot be saved.',
    projectCreated: 'Project created',
    projectCreatedMessage: (name: string) => `Project “${name}” was created.`,
    dropHint: 'Drag files here, or click to select',
    dropActiveHint: 'Drop files to add them',
    acceptedFormats: 'JSON, Markdown, CSV supported',
    fileListTitle: 'Files to import',
    emptyFileList: 'No files selected. Drag files here or click the area above.',
    removeFile: 'Remove',
    fileReady: 'Ready',
    fileReading: 'Reading…',
    fileImporting: 'Importing…',
    fileSuccess: 'Imported',
    fileError: 'Invalid',
    unsupportedFile: 'Unsupported format. Only JSON, Markdown, and CSV are accepted.',
    fileTooLarge: 'File is too large; please split it into smaller files.',
    readFailed: 'Failed to read the file; it may be corrupted.',
    invalidJson: 'Invalid JSON.',
    importFailed: 'Import failed',
    importHandlerMissing: 'The import interface is not connected; files cannot be uploaded.',
    importSuccess: 'Import complete',
    importedNFiles: (count: number) => `${count} files imported successfully.`,
    importProgressTitle: 'Importing…',
    resultErrorHint: 'Check the files and retry, or cancel and try again later.',
    loading: 'Processing…',
    noDetails: 'No details',
  },
} as const;

type CopyKey = keyof typeof COPY;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  json: ['json'],
  markdown: ['md', 'markdown'],
  csv: ['csv'],
};

function getFileKind(name: string): 'json' | 'markdown' | 'csv' | null {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  for (const [kind, extensions] of Object.entries(ALLOWED_EXTENSIONS)) {
    if (extensions.includes(ext)) return kind as 'json' | 'markdown' | 'csv';
  }
  return null;
}

function isAllowedFile(name: string): boolean {
  return getFileKind(name) !== null;
}

function fileIcon(kind: 'json' | 'markdown' | 'csv' | null): LucideIcon {
  if (kind === 'json') return FileJson;
  if (kind === 'csv') return FileSpreadsheet;
  if (kind === 'markdown') return FileText;
  return FileType;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',');
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hidden && !element.closest('[inert]'),
  );
}

export default function ImportCreateDialog({
  open,
  onClose,
  onCreateProject,
  onImportFiles,
  initialMode,
  projectId,
  title,
  className = '',
}: ImportCreateDialogProps) {
  // Use Chinese copy by default to match the rest of the research workspace.
  const copy = COPY.zh;
  const instanceId = useId().replace(/:/g, '');
  const dialogTitleId = `${instanceId}-icd-title`;
  const liveRegionId = `${instanceId}-icd-live`;

  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const startButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [step, setStep] = useState<Step>(initialMode ?? 'start');
  const [mode, setMode] = useState<'create' | 'import'>(initialMode ?? 'create');
  const [projectName, setProjectName] = useState('');
  const [description, setDescription] = useState('');
  const [projectError, setProjectError] = useState('');
  const [projectLoading, setProjectLoading] = useState(false);
  const [files, setFiles] = useState<ImportFileItem[]>([]);
  const [importError, setImportError] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [result, setResult] = useState<ImportResultState | null>(null);
  const [responsiveBand, setResponsiveBand] = useState<ResponsiveBand>('wide');
  const [dragOver, setDragOver] = useState(false);



  useEffect(() => {
    if (!open) return;
    if (step === 'start') {
      requestAnimationFrame(() => startButtonRefs.current[0]?.focus());
    } else if (step === 'create') {
      requestAnimationFrame(() => nameInputRef.current?.focus());
    } else if (step === 'import') {
      requestAnimationFrame(() => fileInputRef.current?.focus());
    }
  }, [open, step]);

  useEffect(() => {
    if (!open || !panelRef.current || typeof ResizeObserver === 'undefined') return;

    const updateBand = () => {
      const width = panelRef.current?.clientWidth ?? 0;
      if (width <= 0) return;
      const nextBand: ResponsiveBand = width <= 480 ? 'narrow' : width <= 720 ? 'medium' : 'wide';
      setResponsiveBand((current) => (current === nextBand ? current : nextBand));
    };

    updateBand();
    const observer = new ResizeObserver(updateBand);
    const target = panelRef.current;
    observer.observe(target);
    window.addEventListener('resize', updateBand);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBand);
    };
  }, [open]);

  const handleClose = useCallback(() => {
    if (projectLoading || importLoading) return;
    onClose();
  }, [importLoading, onClose, projectLoading]);

  const handleFocusTrap = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        handleClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = panelRef.current;
      if (!container) return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const active = document.activeElement as HTMLElement;
      const activeIndex = focusable.indexOf(active);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    },
    [handleClose],
  );

  const handleStartKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        return;
      }
      event.preventDefault();
      const buttons = startButtonRefs.current.filter(Boolean);
      const count = buttons.length;
      if (count === 0) return;
      const rtl = panelRef.current ? getComputedStyle(panelRef.current).direction === 'rtl' : false;
      let delta = 0;
      if (event.key === 'ArrowRight') delta = rtl ? -1 : 1;
      if (event.key === 'ArrowLeft') delta = rtl ? 1 : -1;
      if (event.key === 'ArrowDown') delta = 1;
      if (event.key === 'ArrowUp') delta = -1;
      const nextIndex = (index + delta + count) % count;
      buttons[nextIndex]?.focus();
    },
    [],
  );

  const readFileItem = useCallback(
    (item: ImportFileItem) => {
      setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: 'reading', progress: 0 } : f)));
      const reader = new FileReader();
      reader.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const progress = Math.round((event.loaded / event.total) * 100);
        setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, progress } : f)));
      };
      reader.onload = () => {
        const text = String(reader.result ?? '');
        const preview = text.slice(0, 500);
        let validationError: string | undefined;
        if (getFileKind(item.file.name) === 'json') {
          try {
            JSON.parse(text);
          } catch {
            validationError = copy.invalidJson;
          }
        }
        setFiles((prev) =>
          prev.map((f) =>
            f.id === item.id
              ? {
                  ...f,
                  status: validationError ? 'error' : 'ready',
                  progress: 100,
                  preview,
                  error: validationError,
                }
              : f,
          ),
        );
      };
      reader.onerror = () => {
        setFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, status: 'error', progress: 0, error: copy.readFailed } : f)),
        );
      };
      reader.readAsText(item.file);
    },
    [copy.invalidJson, copy.readFailed],
  );

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const incoming: ImportFileItem[] = [];
      for (const file of Array.from(fileList)) {
        if (!isAllowedFile(file.name)) {
          incoming.push({ id: generateId(), file, status: 'error', progress: 0, error: copy.unsupportedFile });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          incoming.push({ id: generateId(), file, status: 'error', progress: 0, error: copy.fileTooLarge });
          continue;
        }
        incoming.push({ id: generateId(), file, status: 'pending', progress: 0 });
      }
      if (incoming.length === 0) return;
      setFiles((prev) => [...prev, ...incoming]);
      incoming.forEach((item) => {
        if (item.status === 'pending') {
          readFileItem(item);
        }
      });
    },
    [copy.fileTooLarge, copy.unsupportedFile, readFileItem],
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragOver(false);
      addFiles(event.dataTransfer.files);
    },
    [addFiles],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
  }, []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(event.target.files);
      event.target.value = '';
    },
    [addFiles],
  );

  const handleCreateSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = projectName.trim();
      if (!name) {
        setProjectError(copy.requiredName);
        return;
      }
      if (!onCreateProject) {
        setResult({ type: 'error', title: copy.createFailed, message: copy.createHandlerMissing });
        setStep('result');
        return;
      }
      setProjectLoading(true);
      setProjectError('');
      try {
        const response = await onCreateProject({ name, description: description.trim() });
        setProjectLoading(false);
        if (response.success) {
          setResult({
            type: 'success',
            title: copy.projectCreated,
            message: copy.projectCreatedMessage(name),
          });
          setStep('result');
        } else {
          setProjectError(response.error ?? copy.createFailed);
        }
      } catch {
        setProjectLoading(false);
        setProjectError(copy.createFailed);
      }
    },
    [copy, description, onCreateProject, projectName],
  );

  const readyFiles = useMemo(() => files.filter((f) => f.status === 'ready'), [files]);

  const handleImportSubmit = useCallback(async () => {
    if (readyFiles.length === 0) return;
    if (!onImportFiles) {
      setResult({ type: 'error', title: copy.importFailed, message: copy.importHandlerMissing });
      setStep('result');
      return;
    }
    setImportLoading(true);
    setImportError('');
    setFiles((prev) => prev.map((f) => (f.status === 'ready' ? { ...f, status: 'importing', progress: 0 } : f)));
    setStep('progress');
    try {
      const response = await onImportFiles(
        readyFiles.map((f) => f.file),
        { projectId },
      );
      setImportLoading(false);
      if (response.success) {
        setFiles((prev) =>
          prev.map((f) => (f.status === 'importing' ? { ...f, status: 'success', progress: 100 } : f)),
        );
        setResult({
          type: 'success',
          title: copy.importSuccess,
          message: copy.importedNFiles(response.imported?.length ?? readyFiles.length),
        });
      } else {
        const errorList = response.errors ?? [];
        setFiles((prev) =>
          prev.map((f) => {
            if (f.status !== 'importing') return f;
            const match = errorList.find((e) => e.fileName === f.file.name);
            return match
              ? { ...f, status: 'error', progress: 0, error: match.message }
              : { ...f, status: 'error', progress: 0, error: copy.importFailed };
          }),
        );
        setResult({
          type: 'error',
          title: copy.importFailed,
          message: errorList[0]?.message ?? copy.importFailed,
          details: errorList.map((e) => `${e.fileName}: ${e.message}`),
        });
      }
    } catch {
      setImportLoading(false);
      setFiles((prev) => prev.map((f) => (f.status === 'importing' ? { ...f, status: 'error', error: copy.importFailed } : f)));
      setResult({ type: 'error', title: copy.importFailed, message: copy.importFailed });
    }
    setStep('result');
  }, [copy, onImportFiles, projectId, readyFiles]);

  const handleRetry = useCallback(() => {
    if (mode === 'create') {
      setStep('create');
      setResult(null);
    } else {
      setStep('import');
      setResult(null);
    }
  }, [mode]);

  if (!open) return null;

  const header = (
    <div className="import-create-dialog__header">
      <div className="import-create-dialog__title" id={dialogTitleId}>
        {title ?? copy.dialogTitle}
      </div>
      <button
        ref={closeButtonRef}
        type="button"
        className="import-create-dialog__icon-button"
        aria-label={copy.close}
        onClick={handleClose}
        disabled={projectLoading || importLoading}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );

  const startStep = (
    <div className="import-create-dialog__step import-create-dialog__step--start">
      <p className="import-create-dialog__hint">{copy.startHint}</p>
      <div className="import-create-dialog__choices" role="group" aria-label={copy.startTitle}>
        <button
          ref={(el) => { startButtonRefs.current[0] = el; }}
          type="button"
          className="import-create-dialog__choice"
          onClick={() => { setMode('create'); setStep('create'); }}
          onKeyDown={(event) => handleStartKeyDown(event, 0)}
        >
          <span className="import-create-dialog__choice-icon">
            <FolderPlus size={24} aria-hidden="true" />
          </span>
          <span className="import-create-dialog__choice-text">
            <strong>{copy.createProject}</strong>
            <small>{copy.createProjectDesc}</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button
          ref={(el) => { startButtonRefs.current[1] = el; }}
          type="button"
          className="import-create-dialog__choice"
          onClick={() => { setMode('import'); setStep('import'); }}
          onKeyDown={(event) => handleStartKeyDown(event, 1)}
        >
          <span className="import-create-dialog__choice-icon">
            <Upload size={24} aria-hidden="true" />
          </span>
          <span className="import-create-dialog__choice-text">
            <strong>{copy.importFiles}</strong>
            <small>{copy.importFilesDesc}</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  const createStep = (
    <form className="import-create-dialog__step import-create-dialog__form" onSubmit={handleCreateSubmit} noValidate>
      <div className="import-create-dialog__field">
        <label htmlFor={`${instanceId}-project-name`}>{copy.projectName}</label>
        <input
          ref={nameInputRef}
          id={`${instanceId}-project-name`}
          type="text"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          placeholder={copy.projectNamePlaceholder}
          aria-invalid={projectError ? 'true' : 'false'}
          aria-describedby={projectError ? `${instanceId}-project-error` : undefined}
          autoComplete="off"
        />
      </div>
      {projectError && (
        <div id={`${instanceId}-project-error`} className="import-create-dialog__field-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{projectError}</span>
        </div>
      )}
      <div className="import-create-dialog__field">
        <label htmlFor={`${instanceId}-project-desc`}>{copy.projectDescription}</label>
        <textarea
          id={`${instanceId}-project-desc`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={copy.projectDescriptionPlaceholder}
          rows={3}
        />
      </div>
      <div className="import-create-dialog__actions">
        {initialMode ? (
          <button type="button" className="import-create-dialog__button" onClick={handleClose} disabled={projectLoading}>
            {copy.cancel}
          </button>
        ) : (
          <button type="button" className="import-create-dialog__button" onClick={() => setStep('start')} disabled={projectLoading}>
            <ChevronLeft size={16} aria-hidden="true" />
            {copy.back}
          </button>
        )}
        <button
          type="submit"
          className="import-create-dialog__button import-create-dialog__button--primary"
          disabled={projectLoading}
        >
          {projectLoading ? <LoaderCircle size={16} className="import-create-dialog__spin" aria-hidden="true" /> : null}
          {projectLoading ? copy.loading : copy.createProject}
        </button>
      </div>
    </form>
  );

  const dropZone = (
    <div
      className={`import-create-dialog__dropzone ${dragOver ? 'is-active' : ''}`}
      onClick={() => fileInputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      role="button"
      tabIndex={0}
      aria-label={copy.dropHint}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          fileInputRef.current?.click();
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".json,.md,.markdown,.csv"
        className="import-create-dialog__file-input"
        onChange={handleFileInputChange}
        aria-hidden="true"
        tabIndex={-1}
      />
      <Upload size={28} aria-hidden="true" />
      <span>{dragOver ? copy.dropActiveHint : copy.dropHint}</span>
      <small>{copy.acceptedFormats}</small>
    </div>
  );

  const fileList = (
    <div className="import-create-dialog__file-list">
      <div className="import-create-dialog__file-list-header">
        <strong>{copy.fileListTitle}</strong>
        <span>{files.length}</span>
      </div>
      {files.length === 0 ? (
        <div className="import-create-dialog__empty">
          <FileType size={20} aria-hidden="true" />
          <span>{copy.emptyFileList}</span>
        </div>
      ) : (
        <ul role="list">
          {files.map((item) => {
            const kind = getFileKind(item.file.name);
            const Icon = fileIcon(kind);
            const statusText: Record<ImportFileStatus, string> = {
              pending: copy.fileReading,
              reading: copy.fileReading,
              ready: copy.fileReady,
              importing: copy.fileImporting,
              success: copy.fileSuccess,
              error: copy.fileError,
            };
            return (
              <li key={item.id} className={`import-create-dialog__file-item is-${item.status}`}>
                <span className="import-create-dialog__file-icon">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <div className="import-create-dialog__file-meta">
                  <span className="import-create-dialog__file-name" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="import-create-dialog__file-size">{formatBytes(item.file.size)}</span>
                </div>
                <span className="import-create-dialog__file-status">{statusText[item.status]}</span>
                {(item.status === 'reading' || item.status === 'importing') && (
                  <div className="import-create-dialog__progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
                    <div className="import-create-dialog__progress-fill" style={{ width: `${item.progress}%` }} />
                  </div>
                )}
                {item.error && (
                  <span className="import-create-dialog__file-error" role="alert">
                    <AlertTriangle size={12} aria-hidden="true" />
                    {item.error}
                  </span>
                )}
                <button
                  type="button"
                  className="import-create-dialog__icon-button import-create-dialog__icon-button--danger"
                  aria-label={`${copy.removeFile}: ${item.file.name}`}
                  onClick={() => removeFile(item.id)}
                  disabled={item.status === 'importing'}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {importError && (
        <div className="import-create-dialog__step-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {importError}
        </div>
      )}
    </div>
  );

  const importStep = (
    <div className="import-create-dialog__step import-create-dialog__step--import">
      {dropZone}
      {fileList}
      <div className="import-create-dialog__actions">
        {initialMode ? (
          <button type="button" className="import-create-dialog__button" onClick={handleClose} disabled={importLoading}>
            {copy.cancel}
          </button>
        ) : (
          <button type="button" className="import-create-dialog__button" onClick={() => setStep('start')} disabled={importLoading}>
            <ChevronLeft size={16} aria-hidden="true" />
            {copy.back}
          </button>
        )}
        <button
          type="button"
          className="import-create-dialog__button import-create-dialog__button--primary"
          onClick={handleImportSubmit}
          disabled={importLoading || readyFiles.length === 0}
        >
          {importLoading ? <LoaderCircle size={16} className="import-create-dialog__spin" aria-hidden="true" /> : null}
          {importLoading ? copy.loading : copy.next}
        </button>
      </div>
    </div>
  );

  const progressStep = (
    <div className="import-create-dialog__step import-create-dialog__step--progress">
      <div className="import-create-dialog__progress-heading">
        <LoaderCircle size={24} className="import-create-dialog__spin" aria-hidden="true" />
        <strong>{copy.importProgressTitle}</strong>
      </div>
      <div className="import-create-dialog__progress-summary">
        {files.map((item) => (
          <div key={item.id} className="import-create-dialog__progress-row">
            <span className="import-create-dialog__progress-name" title={item.file.name}>
              {item.file.name}
            </span>
            <div className="import-create-dialog__progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
              <div className="import-create-dialog__progress-fill" style={{ width: `${item.progress}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const resultStep = (
    <div className="import-create-dialog__step import-create-dialog__step--result">
      {result?.type === 'success' ? (
        <div className="import-create-dialog__result import-create-dialog__result--success">
          <CheckCircle2 size={32} aria-hidden="true" />
          <strong>{result.title}</strong>
          <p>{result.message}</p>
        </div>
      ) : (
        <div className="import-create-dialog__result import-create-dialog__result--error">
          <AlertCircle size={32} aria-hidden="true" />
          <strong>{result?.title ?? copy.createFailed}</strong>
          <p>{result?.message ?? copy.resultErrorHint}</p>
          {result?.details && result.details.length > 0 && (
            <ul className="import-create-dialog__result-details">
              {result.details.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="import-create-dialog__actions">
        {(result?.type === 'error' || mode === 'import') && result?.type === 'error' && (
          <button type="button" className="import-create-dialog__button" onClick={handleRetry}>
            <RotateCcw size={16} aria-hidden="true" />
            {copy.retry}
          </button>
        )}
        <button type="button" className="import-create-dialog__button import-create-dialog__button--primary" onClick={handleClose}>
          {copy.done}
        </button>
      </div>
    </div>
  );

  const stepContent: Record<Step, React.ReactNode> = {
    start: startStep,
    create: createStep,
    import: importStep,
    progress: progressStep,
    result: resultStep,
  };

  return (
    <div
      className={`import-create-dialog ${className}`.trim()}
      data-responsive-band={responsiveBand}
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
      aria-describedby={liveRegionId}
    >
      <div className="import-create-dialog__overlay" onClick={handleClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="import-create-dialog__panel"
        tabIndex={-1}
        onKeyDown={handleFocusTrap}
      >
        {header}
        <div className="import-create-dialog__body">
          {stepContent[step]}
        </div>
        <div id={liveRegionId} className="import-create-dialog__live-region" aria-live="polite" aria-atomic="true">
          {result?.message ?? ''}
        </div>
      </div>
    </div>
  );
}

export type {
  CopyKey,
  ImportFileItem,
  ImportFileStatus,
  ImportResultState,
  ResponsiveBand,
  Step,
};
