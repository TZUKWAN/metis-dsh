/**
 * ArtifactPreviewPane — 生成物预览栏（2026-08-31 刘总布局重构）。
 *
 * 在科研项目页最右侧以整列呈现生成物内容：完整 Markdown 排版 + Prism
 * 代码高亮 + 全高度滚动，替代右栏里 max-height 400px 的内联小卡片。
 * 布局联动（项目清单收缩、聊天区减半）由 ProjectsPage 负责，本组件只管
 * 内容呈现与关闭。
 */
import { useState } from 'react';
import { useTranslation } from '../i18n';
import { presentArtifactName } from '../presentation/executionPresentation';
import { SafeMarkdown, type SafeMarkdownMode } from '../presentation/SafeMarkdown';
import { CodeBlock } from './CodeBlock';

export interface ArtifactPreviewPaneProps {
  title: string;
  content: string;
  uiMode: SafeMarkdownMode;
  locale: 'en' | 'zh';
  onClose: () => void;
  /** 把当前预览内容（Markdown）导出为 DOCX；由宿主接 IPC。 */
  onExportDocx?: () => Promise<{ ok: boolean; fileName?: string; message?: string }>;
}

export default function ArtifactPreviewPane({ title, content, uiMode, locale, onClose, onExportDocx }: ArtifactPreviewPaneProps) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');

  const handleExport = async () => {
    if (!onExportDocx || exporting) return;
    setExporting(true);
    setExportNotice('');
    try {
      const result = await onExportDocx();
      setExportNotice(result.ok
        ? t('previewPane.exportSuccess', { fileName: result.fileName ?? '' })
        : (result.message || t('previewPane.exportFailed', { message: 'unknown' })));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="artifact-preview-pane" data-testid="artifact-preview-pane">
      <div className="artifact-preview-pane__header">
        <span className="artifact-preview-pane__title" title={title}>
          {presentArtifactName(title, locale)}
        </span>
        {onExportDocx && (
          <button
            type="button"
            className="artifact-preview-pane__export"
            onClick={() => void handleExport()}
            disabled={exporting}
            data-testid="artifact-preview-export-docx"
          >
            {exporting ? t('previewPane.exporting') : t('previewPane.exportWord')}
          </button>
        )}
        <button
          type="button"
          className="artifact-preview-pane__close"
          onClick={onClose}
          aria-label={t('browserOverlay.close')}
          data-testid="artifact-preview-close"
        >
          ✕
        </button>
      </div>
      {exportNotice && (
        <div className="artifact-preview-pane__notice" data-testid="artifact-preview-notice">{exportNotice}</div>
      )}
      <div className="artifact-preview-pane__body">
        <SafeMarkdown
          content={content}
          uiMode={uiMode}
          locale={locale}
          codeComponent={({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const code = String(children).replace(/\n$/, '');
            if (match && match[1]) {
              return <CodeBlock language={match[1]} code={code} />;
            }
            return <code className="inline-code" {...props}>{children}</code>;
          }}
        />
      </div>
    </div>
  );
}
