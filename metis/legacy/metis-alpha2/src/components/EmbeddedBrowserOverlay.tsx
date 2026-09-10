/**
 * EmbeddedBrowserOverlay — 文献原文内嵌浏览浮层。
 *
 * 复用主进程 BrowserService（持久分区的 WebContentsView，登录态跨重启保留）。
 * 用户在浮层内登录 NCPSSD 等站点并手动点击下载；下载被拦截后弹确认条，
 * 确认保存即归入当前项目工作空间（projects/{id}/pdfs/）并按 DOI/标题
 * 回填文献条目 —— Metis 自身绝不自动抓取下载。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import './EmbeddedBrowserOverlay.css';

interface PendingDownloadView {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  pageUrl: string;
  pageTitle: string;
}

interface BrowserStateView {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface EmbeddedBrowserOverlayProps {
  /** 初始地址（文献原文页）。 */
  url: string;
  /** 关闭回调（父组件卸载浮层）。 */
  onClose: () => void;
  /** 下载归档目标项目；null 时存全局 papers 目录。 */
  projectId: string | null;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export default function EmbeddedBrowserOverlay({ url, onClose, projectId }: EmbeddedBrowserOverlayProps) {
  const { t } = useTranslation();
  const metis = window.metis;
  const webRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(url);
  const [state, setState] = useState<BrowserStateView | null>(null);
  const [downloads, setDownloads] = useState<PendingDownloadView[]>([]);
  const [savedNotice, setSavedNotice] = useState('');
  const [saveError, setSaveError] = useState('');

  // Sync the native WebContentsView bounds with the placeholder container.
  const syncBounds = useCallback(() => {
    const node = webRef.current;
    if (!node || !metis?.browserSetBounds) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    void metis.browserSetBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, [metis]);

  // Open: navigate + show, then keep bounds in sync with layout changes.
  useEffect(() => {
    if (!metis?.browserNavigate || !metis?.browserShow) return;
    let alive = true;
    const startup = async () => {
      await metis.browserNavigate!(normalizeUrl(url));
      if (!alive) return;
      await metis.browserShow!({ x: 0, y: 0, width: 10, height: 10 });
      syncBounds();
    };
    void startup();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncBounds()) : null;
    if (observer && webRef.current) observer.observe(webRef.current);
    window.addEventListener('resize', syncBounds);
    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Hide the native view when the overlay closes (login session persists).
  useEffect(() => {
    return () => {
      void window.metis?.browserHide?.();
    };
  }, []);

  // Browser state + download requests.
  useEffect(() => {
    if (!metis) return;
    const offState = metis.onBrowserState?.((next) => {
      setState(next);
      setAddress((current) => (next.url && next.url !== 'about:blank' ? next.url : current));
    });
    const offDownload = metis.onBrowserDownloadRequest?.((download) => {
      setSavedNotice('');
      setSaveError('');
      setDownloads((current) => (current.some((d) => d.id === download.id) ? current : [...current, download]));
    });
    void metis.browserListDownloads?.().then((pending) => {
      if (pending && Array.isArray(pending)) setDownloads(pending as PendingDownloadView[]);
    });
    return () => {
      offState?.();
      offDownload?.();
    };
  }, [metis]);

  const navigate = useCallback((target: string) => {
    const next = normalizeUrl(target);
    if (!next) return;
    void metis?.browserNavigate?.(next);
  }, [metis]);

  const acceptDownload = useCallback(async (download: PendingDownloadView) => {
    if (!metis?.browserAcceptDownload) return;
    const result = await metis.browserAcceptDownload(download.id, projectId);
    if (result.ok) {
      setDownloads((current) => current.filter((d) => d.id !== download.id));
      setSavedNotice(t('browserOverlay.savedToProject', { filename: download.filename }));
      setSaveError('');
    } else {
      setSaveError(t('browserOverlay.saveFailed'));
    }
  }, [metis, projectId, t]);

  const cancelDownload = useCallback(async (download: PendingDownloadView) => {
    await metis?.browserCancelDownload?.(download.id);
    setDownloads((current) => current.filter((d) => d.id !== download.id));
  }, [metis]);

  const canBrowser = Boolean(metis?.browserNavigate && metis?.browserShow);

  return (
    <div className="browser-overlay" data-testid="browser-overlay" role="dialog" aria-label={t('browserOverlay.title')}>
      <div className="browser-overlay__panel">
        <div className="browser-overlay__bar">
          <button type="button" className="btn-sm btn-secondary" disabled={!state?.canGoBack} onClick={() => void metis?.browserBack?.()} aria-label={t('browserOverlay.back')} data-testid="browser-overlay-back">←</button>
          <button type="button" className="btn-sm btn-secondary" disabled={!state?.canGoForward} onClick={() => void metis?.browserForward?.()} aria-label={t('browserOverlay.forward')} data-testid="browser-overlay-forward">→</button>
          <button type="button" className="btn-sm btn-secondary" disabled={!state || state.loading} onClick={() => void metis?.browserReload?.()} aria-label={t('browserOverlay.reload')} data-testid="browser-overlay-reload">⟳</button>
          <form
            className="browser-overlay__address-form"
            onSubmit={(event) => { event.preventDefault(); navigate(address); }}
          >
            <input
              className="settings-input browser-overlay__address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              aria-label={t('browserOverlay.address')}
              data-testid="browser-overlay-address"
              spellCheck={false}
            />
          </form>
          <button
            type="button"
            className="btn-sm btn-secondary"
            onClick={() => { if (state?.url) window.dispatchEvent(new CustomEvent('metis:open-external-url', { detail: { url: state.url } })); }}
            data-testid="browser-overlay-external"
          >
            {t('browserOverlay.openExternal')}
          </button>
          <button type="button" className="btn-sm btn-secondary" onClick={onClose} data-testid="browser-overlay-close">{t('browserOverlay.close')}</button>
        </div>

        {(savedNotice || saveError) && (
          <div className={`browser-overlay__notice ${saveError ? 'browser-overlay__notice--error' : ''}`} role="status" data-testid="browser-overlay-notice">
            {saveError || savedNotice}
          </div>
        )}

        {downloads.length > 0 && (
          <div className="browser-overlay__downloads" data-testid="browser-overlay-downloads">
            {downloads.map((download) => (
              <div key={download.id} className="browser-overlay__download" data-testid="browser-overlay-download">
                <span className="browser-overlay__download-name" title={download.url}>{download.filename}</span>
                <span className="browser-overlay__download-hint">{t('browserOverlay.downloadHint')}</span>
                <button type="button" className="btn-sm btn-primary" onClick={() => void acceptDownload(download)} data-testid="browser-overlay-accept">
                  {projectId ? t('browserOverlay.saveToProject') : t('browserOverlay.saveToLibrary')}
                </button>
                <button type="button" className="btn-sm btn-secondary" onClick={() => void cancelDownload(download)} data-testid="browser-overlay-cancel">
                  {t('browserOverlay.discard')}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="browser-overlay__web" ref={webRef} data-testid="browser-overlay-web">
          {!canBrowser && <div className="browser-overlay__unavailable">{t('browserOverlay.unavailable')}</div>}
          {state?.loading && <div className="browser-overlay__loading" data-testid="browser-overlay-loading">{t('browserOverlay.loading')}</div>}
        </div>
      </div>
    </div>
  );
}
