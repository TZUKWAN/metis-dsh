import { useEffect, useMemo, useRef, useState } from 'react';
import {
  WORKSPACE_AGENTS_LIMITS,
  WorkspaceAgentsContentSchema,
  type WorkspaceAgentsMutationResult,
  type WorkspaceAgentsView,
} from '../../engine/runtime/WorkspaceAgentsContract.js';
import { useTranslation } from '../i18n';

type EditorStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'conflict' | 'error';

interface CachedProjectDraft {
  content: string;
  expectedVersion: number;
  diskContent: string;
  diskVersion: number;
  dirty: boolean;
}

interface EditorState extends CachedProjectDraft {
  projectId: string | null;
  status: EditorStatus;
  message: string;
  blocked: boolean;
}

const EMPTY_STATE: EditorState = {
  projectId: null,
  content: '',
  expectedVersion: 0,
  diskContent: '',
  diskVersion: 0,
  dirty: false,
  status: 'idle',
  message: '',
  blocked: false,
};

const COPY = {
  zh: {
    eyebrow: '权威项目规则',
    heading: '当前项目 Metis.md',
    description: '直接编辑活动项目的权威规则。内容通过主进程按版本比较保存，不是普通 project 规则定义。',
    project: '活动项目',
    noActiveProject: '没有活动项目',
    noProject: '请先打开或创建一个研究项目。当前项目 Metis.md 已禁用。',
    field: '当前项目 Metis.md 内容',
    loading: '正在读取磁盘版本…',
    saved: 'Metis.md 已保存。',
    save: '保存 Metis.md',
    saving: '正在保存…',
    serviceUnavailable: '项目规则服务不可用。你的草稿未被保存。',
    loadFailed: '无法读取当前项目的 Metis.md。你的本地草稿已保留。',
    saveFailed: 'Metis.md 保存失败。你的本地草稿已保留。',
    projectMissing: '活动项目已不存在。你的本地草稿已保留。',
    conflict: '检测到更新的磁盘版本。你的本地草稿已保留；请选择保留本地或采用磁盘版本。',
    integrityConflict: '项目规则完整性检查失败。编辑已阻止；请先恢复一致的项目规则状态。',
    responseMismatch: '项目规则响应与活动项目不匹配。编辑已阻止。',
    invalidControls: 'Metis.md 含有不允许的 C0/C1 控制字符；制表符、换行和回车除外。',
    tooLong: `Metis.md 不能超过 ${WORKSPACE_AGENTS_LIMITS.maxChars.toLocaleString()} 个字符。`,
    keepLocal: '保留本地',
    useDisk: '采用磁盘版本',
    version: (version: number) => `磁盘版本 v${version}`,
  },
  en: {
    eyebrow: 'AUTHORITATIVE PROJECT RULES',
    heading: 'Current project Metis.md',
    description: 'Edit the active project’s authoritative rules through main-process compare-and-swap. This is not a regular project-scoped definition.',
    project: 'Active project',
    noActiveProject: 'No active project',
    noProject: 'Open or create a research project first. Current project Metis.md is disabled.',
    field: 'Current project Metis.md content',
    loading: 'Reading the disk version…',
    saved: 'Metis.md saved.',
    save: 'Save Metis.md',
    saving: 'Saving…',
    serviceUnavailable: 'Project-rule service unavailable. Your draft was not saved.',
    loadFailed: 'Could not read the current project Metis.md. Your local draft is preserved.',
    saveFailed: 'Metis.md save failed. Your local draft is preserved.',
    projectMissing: 'The active project no longer exists. Your local draft is preserved.',
    conflict: 'A newer disk version exists. Your local draft is preserved; keep it or adopt the disk version.',
    integrityConflict: 'Project-rule integrity validation failed. Editing is blocked until the project-rule state is repaired.',
    responseMismatch: 'The project-rule response does not match the active project. Editing is blocked.',
    invalidControls: 'Metis.md contains forbidden C0/C1 control characters; tab, line feed, and carriage return remain allowed.',
    tooLong: `Metis.md cannot exceed ${WORKSPACE_AGENTS_LIMITS.maxChars.toLocaleString()} characters.`,
    keepLocal: 'Keep Local Draft',
    useDisk: 'Use Disk Version',
    version: (version: number) => `Disk version v${version}`,
  },
} as const;

function cachedDraft(state: EditorState): CachedProjectDraft {
  return {
    content: state.content,
    expectedVersion: state.expectedVersion,
    diskContent: state.diskContent,
    diskVersion: state.diskVersion,
    dirty: state.dirty,
  };
}

function validViewForProject(view: WorkspaceAgentsView, projectId: string): boolean {
  return view.projectId === projectId
    && WorkspaceAgentsContentSchema.safeParse(view.content).success;
}

export interface ProjectMetisRulesEditorProps {
  projectId: string | null;
}

export default function ProjectMetisRulesEditor({ projectId }: ProjectMetisRulesEditorProps) {
  const { locale } = useTranslation();
  const copy = COPY[locale];
  const [editor, setEditor] = useState<EditorState>(EMPTY_STATE);
  const draftCache = useRef<Map<string, CachedProjectDraft>>(new Map());
  const activeProjectRef = useRef<string | null>(projectId);
  const loadSequence = useRef(0);
  const saveSequence = useRef(0);
  const alertRef = useRef<HTMLDivElement>(null);
  const validationRef = useRef<HTMLParagraphElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const validation = useMemo(
    () => WorkspaceAgentsContentSchema.safeParse(editor.content),
    [editor.content],
  );
  const validationMessage = validation.success
    ? ''
    : editor.content.length > WORKSPACE_AGENTS_LIMITS.maxChars
      ? copy.tooLong
      : copy.invalidControls;

  useEffect(() => {
    activeProjectRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if ((editor.status === 'conflict' || editor.status === 'error') && editor.message) {
      alertRef.current?.focus();
    }
  }, [editor.message, editor.status]);

  useEffect(() => {
    if (validationMessage) validationRef.current?.focus();
  }, [validationMessage]);

  useEffect(() => {
    const nextProjectId = projectId;
    const sequence = ++loadSequence.current;
    saveSequence.current += 1;

    if (!nextProjectId) {
      queueMicrotask(() => {
        if (sequence === loadSequence.current && activeProjectRef.current === null) {
          setEditor(EMPTY_STATE);
        }
      });
      return;
    }

    const cached = draftCache.current.get(nextProjectId);
    queueMicrotask(() => {
      if (sequence !== loadSequence.current || activeProjectRef.current !== nextProjectId) return;
      setEditor({
        projectId: nextProjectId,
        content: cached?.content ?? '',
        expectedVersion: cached?.expectedVersion ?? 0,
        diskContent: cached?.diskContent ?? '',
        diskVersion: cached?.diskVersion ?? 0,
        dirty: cached?.dirty ?? false,
        status: 'loading',
        message: copy.loading,
        blocked: true,
      });
    });

    const getRules = window.metis?.getWorkspaceAgents;
    if (!getRules) {
      queueMicrotask(() => {
        if (sequence !== loadSequence.current || activeProjectRef.current !== nextProjectId) return;
        setEditor((current) => ({
          ...current,
          projectId: nextProjectId,
          status: 'error',
          message: copy.serviceUnavailable,
          blocked: true,
        }));
      });
      return;
    }

    void getRules(nextProjectId).then((view) => {
      if (sequence !== loadSequence.current || activeProjectRef.current !== nextProjectId) return;
      setEditor((current) => {
        const currentDraft = draftCache.current.get(nextProjectId) ?? cachedDraft(current);
        if (!validViewForProject(view, nextProjectId)) {
          return {
            ...current,
            projectId: nextProjectId,
            status: 'error',
            message: copy.responseMismatch,
            blocked: true,
          };
        }
        if (view.externalConflict) {
          const next: EditorState = {
            ...currentDraft,
            projectId: nextProjectId,
            diskContent: view.content,
            diskVersion: view.version,
            status: 'error',
            message: copy.integrityConflict,
            blocked: true,
          };
          draftCache.current.set(nextProjectId, cachedDraft(next));
          return next;
        }
        if (currentDraft.dirty) {
          const conflicted = currentDraft.expectedVersion !== view.version;
          const next: EditorState = {
            ...currentDraft,
            projectId: nextProjectId,
            diskContent: view.content,
            diskVersion: view.version,
            status: conflicted ? 'conflict' : 'idle',
            message: conflicted ? copy.conflict : '',
            blocked: false,
          };
          draftCache.current.set(nextProjectId, cachedDraft(next));
          return next;
        }
        const next: EditorState = {
          projectId: nextProjectId,
          content: view.content,
          expectedVersion: view.version,
          diskContent: view.content,
          diskVersion: view.version,
          dirty: false,
          status: 'idle',
          message: '',
          blocked: false,
        };
        draftCache.current.set(nextProjectId, cachedDraft(next));
        return next;
      });
    }).catch(() => {
      if (sequence !== loadSequence.current || activeProjectRef.current !== nextProjectId) return;
      setEditor((current) => ({
        ...current,
        projectId: nextProjectId,
        status: 'error',
        message: copy.loadFailed,
        blocked: true,
      }));
    });
  }, [copy.conflict, copy.integrityConflict, copy.loadFailed, copy.loading, copy.responseMismatch, copy.serviceUnavailable, projectId]);

  const updateEditor = (next: EditorState) => {
    setEditor(next);
    if (next.projectId) draftCache.current.set(next.projectId, cachedDraft(next));
  };

  const handleChange = (content: string) => {
    if (!projectId || editor.projectId !== projectId) return;
    updateEditor({
      ...editor,
      content,
      dirty: content !== editor.diskContent,
      status: 'idle',
      message: '',
    });
  };

  const handleKeepLocal = () => {
    if (!projectId || editor.projectId !== projectId) return;
    const next: EditorState = {
      ...editor,
      expectedVersion: editor.diskVersion,
      dirty: editor.content !== editor.diskContent,
      status: 'idle',
      message: '',
      blocked: false,
    };
    updateEditor(next);
    textareaRef.current?.focus();
  };

  const handleUseDisk = () => {
    if (!projectId || editor.projectId !== projectId) return;
    const next: EditorState = {
      ...editor,
      content: editor.diskContent,
      expectedVersion: editor.diskVersion,
      dirty: false,
      status: 'idle',
      message: '',
      blocked: false,
    };
    updateEditor(next);
    textareaRef.current?.focus();
  };

  const handleSave = async () => {
    if (!projectId || editor.projectId !== projectId || !editor.dirty || !validation.success
      || editor.blocked || editor.status === 'conflict') return;
    const setRules = window.metis?.setWorkspaceAgents;
    const getRules = window.metis?.getWorkspaceAgents;
    if (!setRules || !getRules) {
      updateEditor({ ...editor, status: 'error', message: copy.serviceUnavailable, blocked: true });
      return;
    }

    const snapshot = {
      projectId,
      content: editor.content,
      expectedVersion: editor.expectedVersion,
    };
    const sequence = ++saveSequence.current;
    updateEditor({ ...editor, status: 'saving', message: '', blocked: false });

    let result: WorkspaceAgentsMutationResult;
    try {
      result = await setRules(snapshot.projectId, snapshot.content, snapshot.expectedVersion);
    } catch {
      if (sequence === saveSequence.current && activeProjectRef.current === snapshot.projectId) {
        setEditor((current) => ({ ...current, status: 'error', message: copy.saveFailed, blocked: false }));
      }
      return;
    }

    if (result.success) {
      const cached = draftCache.current.get(snapshot.projectId);
      if (cached && cached.expectedVersion === snapshot.expectedVersion) {
        const contentUnchanged = cached.content === snapshot.content;
        draftCache.current.set(snapshot.projectId, {
          content: cached.content,
          expectedVersion: result.version,
          diskContent: snapshot.content,
          diskVersion: result.version,
          dirty: !contentUnchanged,
        });
      }
      if (sequence !== saveSequence.current || activeProjectRef.current !== snapshot.projectId) return;
      setEditor((current) => {
        if (current.projectId !== snapshot.projectId) return current;
        const contentUnchanged = current.content === snapshot.content;
        const next: EditorState = {
          ...current,
          expectedVersion: result.version,
          diskContent: snapshot.content,
          diskVersion: result.version,
          dirty: !contentUnchanged,
          status: contentUnchanged ? 'saved' : 'idle',
          message: contentUnchanged ? copy.saved : '',
          blocked: false,
        };
        draftCache.current.set(snapshot.projectId, cachedDraft(next));
        return next;
      });
      return;
    }

    if (result.code === 'cas_conflict') {
      let view: WorkspaceAgentsView;
      try {
        view = await getRules(snapshot.projectId);
      } catch {
        if (sequence === saveSequence.current && activeProjectRef.current === snapshot.projectId) {
          setEditor((current) => ({ ...current, status: 'error', message: copy.loadFailed, blocked: true }));
        }
        return;
      }
      if (sequence !== saveSequence.current || activeProjectRef.current !== snapshot.projectId) return;
      setEditor((current) => {
        if (current.projectId !== snapshot.projectId) return current;
        if (!validViewForProject(view, snapshot.projectId)) {
          return { ...current, status: 'error', message: copy.responseMismatch, blocked: true };
        }
        if (view.externalConflict) {
          return { ...current, status: 'error', message: copy.integrityConflict, blocked: true };
        }
        const next: EditorState = {
          ...current,
          diskContent: view.content,
          diskVersion: view.version,
          status: 'conflict',
          message: copy.conflict,
          blocked: false,
        };
        draftCache.current.set(snapshot.projectId, cachedDraft(next));
        return next;
      });
      return;
    }

    if (sequence !== saveSequence.current || activeProjectRef.current !== snapshot.projectId) return;
    const message = result.code === 'project_not_found'
      ? copy.projectMissing
      : result.code === 'external_conflict'
        ? copy.integrityConflict
        : result.code === 'agents_unavailable'
          ? copy.serviceUnavailable
          : copy.saveFailed;
    setEditor((current) => ({
      ...current,
      status: 'error',
      message,
      blocked: result.code === 'external_conflict' || result.code === 'project_not_found',
    }));
  };

  const readyProject = Boolean(projectId && editor.projectId === projectId);
  const saveDisabled = !readyProject || !editor.dirty || !validation.success || editor.blocked
    || editor.status === 'loading' || editor.status === 'saving' || editor.status === 'conflict';
  const messageIsAlert = editor.status === 'error' || editor.status === 'conflict';

  return (
    <section
      className="personalization-installer personalization-project-rules"
      aria-labelledby="project-metis-rules-heading"
      aria-busy={editor.status === 'loading' || editor.status === 'saving'}
      data-testid="authoritative-project-metis-rules"
    >
      <div className="personalization-installer__header">
        <div>
          <span className="personalization-eyebrow">{copy.eyebrow}</span>
          <h2 id="project-metis-rules-heading">{copy.heading}</h2>
        </div>
        <span id="project-metis-rules-description">{copy.description}</span>
      </div>

      <div className="personalization-boundary personalization-project-rules__identity">
        <strong>{copy.project}</strong>
        {projectId ? <code>{projectId}</code> : <span>{copy.noActiveProject}</span>}
      </div>

      <label htmlFor="project-metis-rules-textarea">
        <span>{copy.field}</span>
        <textarea
          ref={textareaRef}
          id="project-metis-rules-textarea"
          data-testid="project-metis-rules-textarea"
          rows={18}
          maxLength={WORKSPACE_AGENTS_LIMITS.maxChars}
          value={readyProject ? editor.content : ''}
          disabled={!readyProject || editor.status === 'loading' || editor.blocked}
          aria-invalid={!validation.success}
          aria-describedby="project-metis-rules-description project-metis-rules-validation project-metis-rules-message"
          onChange={(event) => handleChange(event.target.value)}
        />
      </label>

      <p
        ref={validationRef}
        id="project-metis-rules-validation"
        className="personalization-project-rules__validation"
        role={validationMessage ? 'alert' : 'status'}
        aria-live={validationMessage ? 'assertive' : 'polite'}
        tabIndex={validationMessage ? -1 : undefined}
      >
        {validationMessage}
      </p>

      <div className="personalization-project-rules__footer">
        <span className="personalization-project-rules__count">
          {editor.content.length.toLocaleString()} / {WORKSPACE_AGENTS_LIMITS.maxChars.toLocaleString()}
          {readyProject && editor.diskVersion > 0 ? ` · ${copy.version(editor.diskVersion)}` : ''}
        </span>
        <button
          type="button"
          className="btn-primary"
          data-testid="project-metis-rules-save"
          data-status={editor.status}
          disabled={saveDisabled}
          onClick={() => { void handleSave(); }}
        >
          {editor.status === 'saving' ? copy.saving : copy.save}
        </button>
      </div>

      <div
        ref={alertRef}
        id="project-metis-rules-message"
        className={`personalization-project-rules__message${messageIsAlert ? ' is-alert' : ''}`}
        role={messageIsAlert ? 'alert' : 'status'}
        aria-live={messageIsAlert ? 'assertive' : 'polite'}
        tabIndex={messageIsAlert ? -1 : undefined}
      >
        {!projectId ? copy.noProject : editor.message}
      </div>

      {editor.status === 'conflict' && (
        <div className="personalization-project-rules__conflict-actions">
          <button type="button" className="btn-secondary" onClick={handleKeepLocal}>{copy.keepLocal}</button>
          <button type="button" className="btn-primary" onClick={handleUseDisk}>{copy.useDisk}</button>
        </div>
      )}
    </section>
  );
}
