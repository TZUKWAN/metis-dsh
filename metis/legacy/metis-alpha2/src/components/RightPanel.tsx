import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '../i18n';
import { presentArtifactName } from '../presentation/executionPresentation';
import {
  SafeMarkdown,
  presentSafeMarkdownText,
  type SafeMarkdownMode,
} from '../presentation/SafeMarkdown';
import { CheckIcon, CrossIcon, FileTypeIcon } from './Icons';

interface TaskItem {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  /** 步骤提示词/说明（2026-08-29 刘总要求：清单点击展开查看）。 */
  detail?: string;
}

interface ArtifactItem {
  id: string;
  name: string;
  type: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'md' | 'latex' | 'other';
  size?: string;
  contentAvailable: boolean;
}

export type RightPanelTab = 'tasks' | 'artifacts';

export interface RightPanelProps {
  activeTab: RightPanelTab;
  onActiveTabChange: (tab: RightPanelTab) => void;
  tasks?: TaskItem[];
  artifacts?: ArtifactItem[];
  onUpload?: () => void;
  onTaskClick?: (id: string) => void;
  onArtifactClick?: (item: ArtifactItem) => void;
  className?: string;
  /** Render without a nested complementary landmark when hosted by ProjectShell. */
  embedded?: boolean;
  /** Live preview content (Markdown) for the artifact being generated/selected.
   *  The parent owns tab transitions; this component only renders the supplied preview. */
  previewContent?: string;
  previewTitle?: string;
  artifactError?: string;
  uiMode?: SafeMarkdownMode;
  /** 预览内容改由独立预览栏呈现（projects 模式）时，抑制这里的内联小卡片。 */
  suppressInlinePreview?: boolean;
}

const statusClass: Record<TaskItem['status'], string> = {
  pending: 'task-status-pending',
  running: 'task-status-running',
  completed: 'task-status-completed',
  failed: 'task-status-failed',
};

function StatusIcon({ status }: { status: TaskItem['status'] }) {
  if (status === 'completed') return <span aria-hidden="true"><CheckIcon size={14} /></span>;
  if (status === 'failed') return <span aria-hidden="true"><CrossIcon size={14} /></span>;
  if (status === 'running') {
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="40 20" fill="none" />
      </svg>
    );
  }
  return <span aria-hidden="true" style={{ width: 14, height: 14, border: '2px solid currentColor', borderRadius: '50%', display: 'inline-block', opacity: 0.5 }} />;
}

export default function RightPanel({
  activeTab,
  onActiveTabChange,
  tasks = [],
  artifacts = [],
  onUpload,
  onTaskClick,
  onArtifactClick,
  className = '',
  embedded = false,
  previewContent,
  previewTitle,
  artifactError,
  uiMode = 'normal',
  suppressInlinePreview = false,
}: RightPanelProps) {
  const { t, locale } = useTranslation();
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const instanceId = useId().replace(/:/g, '');
  const tabRefs = useRef<Partial<Record<RightPanelTab, HTMLButtonElement | null>>>({});

  const tabs: { id: RightPanelTab; label: string }[] = [
    { id: 'tasks', label: t('rightPanel.tasks') },
    { id: 'artifacts', label: t('rightPanel.artifacts') },
  ];

  function handleTabKeyDown(event: KeyboardEvent, current: RightPanelTab) {
    const currentIndex = tabs.findIndex((tab) => tab.id === current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex]?.id;
    if (!nextTab) return;
    onActiveTabChange(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  const Root = embedded ? 'div' : 'aside';

  return (
    <Root className={`right-panel ${embedded ? 'right-panel--embedded' : ''} ${className}`}>
      <div className="right-panel-tabs" role="tablist" aria-label={t('rightPanel.views')}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => { tabRefs.current[tab.id] = element; }}
            id={`${instanceId}-right-panel-tab-${tab.id}`}
            className={`right-panel-tab ${activeTab === tab.id ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${instanceId}-right-panel-content`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => onActiveTabChange(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id={`${instanceId}-right-panel-content`}
        className="right-panel-content"
        role="tabpanel"
        aria-labelledby={`${instanceId}-right-panel-tab-${activeTab}`}
      >
        {activeTab === 'tasks' && (
          <div className="right-panel-section">
            <div className="right-panel-header">
              <h3>{t('rightPanel.taskList')}</h3>
              <span className="right-panel-count">{tasks.length}</span>
            </div>
            {tasks.length === 0 ? (
              <div className="right-panel-empty">{t('rightPanel.noTasks')}</div>
            ) : (
              <ul className="right-panel-list task-list">
                {tasks.map((task) => {
                  const progress = task.progress === undefined
                    ? undefined
                    : Math.min(100, Math.max(0, Number.isFinite(task.progress) ? task.progress : 0));
                  const safeTitle = presentSafeMarkdownText(task.title, uiMode, locale);
                  const expanded = expandedTaskId === task.id;
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={`right-panel-item task-item ${statusClass[task.status]}`}
                        onClick={() => {
                          setExpandedTaskId(expanded ? null : task.id);
                          onTaskClick?.(task.id);
                        }}
                        disabled={!onTaskClick && !task.detail}
                      >
                        <span className="task-status-icon"><StatusIcon status={task.status} /></span>
                        <div className="task-info">
                          <span className="task-title">{safeTitle}</span>
                          <span className="sr-only">{t(`rightPanel.status.${task.status}`)}</span>
                          {task.status === 'running' && progress !== undefined && (
                            <div
                              className="task-progress-bar"
                              role="progressbar"
                              aria-label={safeTitle}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={progress}
                            >
                              <div className="task-progress-fill" style={{ width: `${progress}%` }} />
                            </div>
                          )}
                        </div>
                      </button>
                      {expanded && task.detail && (
                        <div className="task-detail" data-testid="task-detail">
                          <SafeMarkdown content={task.detail} uiMode={uiMode} locale={locale} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {activeTab === 'artifacts' && (
          <div className="right-panel-section">
            {/* Live preview (Claude-Artifacts-style): renders Markdown in real time.
                projects 模式下预览由最右侧整列 ArtifactPreviewPane 承担，这里抑制。 */}
            {previewContent && !suppressInlinePreview && (
              <div className="artifact-live-preview">
                {previewTitle && <div className="artifact-preview-title">{presentArtifactName(previewTitle, locale)}</div>}
                <div className="artifact-preview-body">
                  <SafeMarkdown content={previewContent} uiMode={uiMode} locale={locale} />
                </div>
              </div>
            )}
            <div className="right-panel-header">
              <h3>{t('rightPanel.artifactPreview')}</h3>
              {onUpload && (
                <button className="right-panel-action" onClick={onUpload}>
                  {t('rightPanel.upload')}
                </button>
              )}
            </div>
            {artifactError && (
              <div className="right-panel-empty" role="alert">{artifactError}</div>
            )}
            {artifacts.length === 0 ? (
              <div className="right-panel-empty">{t('rightPanel.noArtifacts')}</div>
            ) : (
              <ul className="right-panel-list artifact-list">
                {artifacts.map((item) => {
                  const displayName = presentArtifactName(item.name, locale);
                  const canOpenContent = item.contentAvailable && onArtifactClick !== undefined;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="right-panel-item artifact-item"
                        aria-label={displayName}
                        onClick={() => { if (canOpenContent) onArtifactClick(item); }}
                        disabled={!canOpenContent}
                      >
                        <span className="artifact-icon"><FileTypeIcon type={item.type} size={22} /></span>
                        <div className="artifact-info">
                          <span className="artifact-name">{displayName}</span>
                          {item.size && <span className="artifact-meta">{item.size}</span>}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

      </div>
    </Root>
  );
}
