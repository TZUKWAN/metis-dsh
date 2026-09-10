/**
 * METIS research browser — embedded WebContentsView with persistent login
 * state, user self-service navigation, AI control, literature collection and
 * PDF download-to-project.
 *
 * Design notes:
 *  - One WebContentsView lives as a child of the main window's content view.
 *    The renderer reports its host element bounds via `browser:setBounds`;
 *    the view is only visible while the browser tab is active.
 *  - The session is a persistent partition (`persist:metis-browser`) whose
 *    storage path is pinned under the configurable DATA_DIR, so login
 *    cookies/localStorage survive restarts AND follow the storage location
 *    (no data stranded on the system drive).
 *  - The view has no preload and no privileged APIs. New windows open inside
 *    the same view. Downloads are intercepted and routed through a
 *    user-confirmed save-to-project flow.
 *  - AI control mirrors the kimi-bridge capability set: navigate/back/forward,
 *    click/type/scroll, screenshot, and DOM extraction — all via IPC, never
 *    through a privileged page context.
 */

import { BrowserWindow, WebContentsView, session, type Session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import { searchWorks, getWorkByDoi, type CrossrefMetadata } from '../engine/research/CrossrefClient.js';

const BROWSER_PARTITION = 'persist:metis-browser';
const MAX_EXTRACT_CHARS = 60_000;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ExtractedPage {
  title: string;
  text: string;
  url: string;
  links: string[];
}

export interface CollectedPaper {
  paperId: string;
  merged: boolean;
  title: string;
  doi?: string;
  /**
   * Metadata provenance tier (O2), surfaced to the UI so users understand why a
   * collected item may lack DOI/PDF:
   *  - 'complete'         : page meta + DOI (best)
   *  - 'crossref_enriched': page had no DOI but title matched CrossRef
   *  - 'meta_only'        : page meta tags only, no DOI resolved
   *  - 'webpage'          : not a recognized academic source, saved as a record
   */
  metaSource?: 'complete' | 'crossref_enriched' | 'meta_only' | 'webpage';
}

interface PendingDownload {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  pageUrl: string;
  pageTitle: string;
}

const DOWNLOADABLE_MIME = /^application\/pdf\b|^application\/octet-stream\b/i;

export class BrowserService {
  private readonly window: BrowserWindow;
  private readonly dataDir: string;
  private readonly store: PersistenceStore | null;
  private view: WebContentsView | null = null;
  private session: Session | null = null;
  private attached = false;
  private bounds: BrowserBounds | null = null;
  private currentUrl = '';
  private currentTitle = '';
  private pendingDownloads = new Map<string, PendingDownload>();
  /**
   * 任务2 上下文隔离：共享浏览器当前页的归属标记（由导航调用方显式声明）。
   * null 表示归属未知——AI 消费该页内容时必须显式声明「归属未知」，不得
   * 默认其属于当前项目。
   */
  private ownership: { projectId: string | null; markedAt: number } | null = null;

  constructor(options: { window: BrowserWindow; dataDir: string; store: PersistenceStore | null }) {
    this.window = options.window;
    this.dataDir = options.dataDir;
    this.store = options.store;
  }

  /** 导航调用方声明当前页归属（切项目/未知来源导航时传 null）。 */
  setActiveOwnership(projectId: string | null): void {
    this.ownership = { projectId: projectId?.trim() || null, markedAt: Date.now() };
  }

  getActiveOwnership(): { projectId: string | null; markedAt: number } | null {
    return this.ownership ? { ...this.ownership } : null;
  }

  /**
   * 带归属校验的页面提取（任务2）：请求项目与页面归属都已知且不一致时拒绝
   * （browser_scope_mismatch，fail-closed）；归属未知时放行但携带
   * ownershipKnown:false，由调用方显式声明，绝不静默当作本项目内容。
   */
  async extractScoped(requestProjectId: string | null): Promise<
    | { ok: true; page: ExtractedPage; ownershipKnown: boolean }
    | { ok: false; error: string; scopeMismatch?: boolean }
  > {
    const owned = this.ownership?.projectId?.trim() || null;
    const requested = requestProjectId?.trim() || null;
    if (owned && requested && owned !== requested) {
      return { ok: false, error: 'browser_scope_mismatch', scopeMismatch: true };
    }
    const result = await this.extract();
    if (!result.ok || !result.page) return { ok: false, error: result.error ?? 'browser_extract_failed' };
    return { ok: true, page: result.page, ownershipKnown: Boolean(owned) };
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    // Persistent partition: login cookies/localStorage survive restarts. The
    // partition's session data itself lives under userData (KB scale — Electron
    // has no per-session storage path in this version); every bulk artifact
    // (downloaded PDFs, collected metadata) goes into DATA_DIR below.
    const ses = session.fromPartition(BROWSER_PARTITION);
    this.session = ses;

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // No preload: remote pages must never gain privileged APIs.
      },
    });
    this.view = view;
    view.setBackgroundColor('#ffffff');
    view.webContents.setWindowOpenHandler(({ url }) => {
      // Open everything inside the research browser (no popups).
      if (/^https?:/i.test(url)) {
        void this.navigate(url);
      }
      return { action: 'deny' };
    });
    view.webContents.on('did-navigate', (_event, url) => {
      this.currentUrl = url;
      this.emitState();
    });
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      this.currentUrl = url;
      this.emitState();
    });
    view.webContents.on('page-title-updated', (_event, title) => {
      this.currentTitle = title;
      this.emitState();
    });
    view.webContents.on('did-start-loading', () => this.emitState());
    view.webContents.on('did-stop-loading', () => this.emitState());

    // Download interception → user-confirmed save-to-project flow.
    ses.on('will-download', (event, item) => {
      const url = item.getURL();
      const filename = item.getFilename() || 'download';
      if (!/^https?:/i.test(url)) {
        event.preventDefault();
        return;
      }
      const mimeType = item.getMimeType() || '';
      if (DOWNLOADABLE_MIME.test(mimeType)) {
        event.preventDefault();
        // Read the view's LIVE url/title at interception time: the cached
        // currentUrl/currentTitle lag behind the latest navigation events, so
        // papers saved right after navigation used to inherit the previous
        // page's title (e.g. the browser home page).
        const liveUrl = this.view?.webContents.getURL() || this.currentUrl || '';
        const liveTitle = this.view?.webContents.getTitle() || this.currentTitle || '';
        this.requestDownloadDecision({
          id: `dl-${randomUUID()}`,
          url,
          filename,
          mimeType,
          pageUrl: liveUrl,
          pageTitle: liveTitle,
        });
      }
      // Non-downloadable (html etc.) — let Chromium handle it in the view.
    });

    // External navigation hardening for the browser view itself.
    view.webContents.on('will-navigate', (event, url) => {
      if (!/^https?:/i.test(url) && url !== 'about:blank') {
        event.preventDefault();
      }
    });
  }

  /** Attach the view to the window at the given bounds (visible only then). */
  show(bounds: BrowserBounds): void {
    this.attach();
    this.bounds = bounds;
    if (!this.view) return;
    this.view.setBounds({ ...bounds, x: Math.round(bounds.x), y: Math.round(bounds.y) });
    this.window.contentView.addChildView(this.view);
    if (!this.currentUrl) {
      void this.navigate('https://scholar.google.com');
    } else {
      this.view.webContents.focus();
    }
  }

  hide(): void {
    if (this.view && this.window.contentView.children.includes(this.view)) {
      this.window.contentView.removeChildView(this.view);
    }
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = bounds;
    if (this.view && this.window.contentView.children.includes(this.view)) {
      this.view.setBounds({ ...bounds, x: Math.round(bounds.x), y: Math.round(bounds.y) });
    }
  }

  isVisible(): boolean {
    return Boolean(this.view && this.window.contentView.children.includes(this.view));
  }

  // ─── Navigation ─────────────────────────────────────────────

  async navigate(rawUrl: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (!this.view) return { ok: false, error: 'browser_unavailable' };
    const url = normalizeHttpUrl(rawUrl);
    if (!url) return { ok: false, error: 'browser_invalid_url' };
    try {
      await this.view.webContents.loadURL(url);
      this.currentUrl = url;
      return { ok: true, url };
    } catch {
      // loadURL rejects on ERR_ABORTED (redirects) — treat as accepted.
      return { ok: true, url: this.view.webContents.getURL() || url };
    }
  }

  goBack(): void { this.view?.webContents.goBack(); }
  goForward(): void { this.view?.webContents.goForward(); }
  reload(): void { this.view?.webContents.reload(); }
  stop(): void { this.view?.webContents.stop(); }

  /**
   * 枚举当前页面可见表单字段（投稿门户字段级填单的 DOM 抽取层）。
   * 返回结构化纯数据（可克隆），selectorHint 为尽力而为的选择器猜测；
   * 页面无视图/脚本失败时结构化报错，绝不编造字段。
   */
  async enumerateFormFields(timeoutMs = 5_000): Promise<{
    ok: boolean;
    fields?: Array<{ key: string; label: string; kind: string; required: boolean; currentValue: string; selectorHint: string }>;
    error?: string;
  }> {
    const script = `(() => {
      const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
      const els = Array.from(document.querySelectorAll('input, select, textarea'));
      const out = [];
      let seq = 0;
      for (const el of els) {
        try {
          if (el.disabled) continue;
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (SKIP_TYPES.has(type)) continue;
          seq += 1;
          if (out.length >= 200) break;
          let kind = 'text';
          if (el.tagName === 'SELECT') kind = 'select';
          else if (el.tagName === 'TEXTAREA') kind = 'textarea';
          else if (type === 'file') kind = 'file';
          else if (type === 'checkbox') kind = 'checkbox';
          else if (type === 'radio') kind = 'radio';
          // 标签：label[for] > aria-label > placeholder > name（尽力而为）。
          let label = '';
          if (el.id) {
            const lab = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
            if (lab) label = lab.textContent || '';
          }
          if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
          const currentValue = kind === 'checkbox' ? (el.checked ? 'true' : '') : String(el.value ?? '').slice(0, 200);
          out.push({
            key: el.id || el.getAttribute('name') || ('field_' + seq),
            label: label.replace(/\\s+/gu, ' ').trim().slice(0, 300),
            kind,
            required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
            currentValue,
            selectorHint: el.id ? ('#' + CSS.escape(el.id)) : (el.getAttribute('name') ? ('[name="' + el.getAttribute('name') + '"]') : ''),
          });
        } catch { /* 单元素异常跳过，不影响其余 */ }
      }
      return { ok: true, fields: out };
    })()`;
    return await this.evaluateInView(script, timeoutMs);
  }

  getState(): BrowserState {
    const wc = this.view?.webContents;
    return {
      url: this.currentUrl || wc?.getURL() || '',
      title: this.currentTitle || wc?.getTitle() || '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    };
  }

  // ─── AI control (kimi-bridge capability set) ────────────────

  /** Physical click inside the browser view. */
  click(x: number, y: number): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    wc.focus();
    const point = this.toViewPoint(x, y);
    if (!point) return;
    wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  type(text: string): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    wc.focus();
    for (const char of text) {
      wc.sendInputEvent({ type: 'char', keyCode: char });
    }
  }

  key(keyCode: string): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  }

  scroll(deltaX: number, deltaY: number): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    wc.focus();
    const point = this.centerPoint();
    if (!point) return;
    wc.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY });
  }

  async screenshot(): Promise<{ ok: boolean; imageBase64?: string; error?: string }> {
    const wc = this.view?.webContents;
    if (!wc) return { ok: false, error: 'browser_unavailable' };
    try {
      const image = await wc.capturePage();
      if (image.isEmpty()) return { ok: false, error: 'browser_capture_empty' };
      return { ok: true, imageBase64: image.toPNG().toString('base64') };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  }

  async extract(): Promise<{ ok: boolean; page?: ExtractedPage; error?: string }> {
    const wc = this.view?.webContents;
    if (!wc) return { ok: false, error: 'browser_unavailable' };
    try {
      const result = await wc.executeJavaScript(`
        (() => {
          const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();
          const links = [...document.querySelectorAll('a[href]')]
            .map((a) => a.href)
            .filter((h) => /^https?:/i.test(h))
            .slice(0, 200);
          return { title: document.title, text, links };
        })()
      `);
      return {
        ok: true,
        page: {
          title: String(result?.title ?? ''),
          text: String(result?.text ?? '').slice(0, MAX_EXTRACT_CHARS),
          url: this.currentUrl || wc.getURL(),
          links: Array.isArray(result?.links) ? result.links : [],
        },
      };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  }

  /**
   * 在浏览器视图内执行一段 JS 源码（webContents.executeJavaScript 的薄封装）。
   * 仅供 SubmissionPortalService 等受信调用方做选择器级填表——坐标级 click/type
   * 无法按 CSS 选择器精确命中表单字段。带超时与错误捕获；返回值必须可结构化克隆。
   * 安全边界：绝不用于绕过 CAPTCHA/2FA、支付、法律确认或最终提交——这些只允许
   * 人类在视图中亲自操作。
   */
  async evaluateInView<T>(fn: string, timeoutMs = 5_000): Promise<{ ok: boolean; value?: T; error?: string }> {
    const wc = this.view?.webContents;
    if (!wc) return { ok: false, error: 'browser_unavailable' };
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const value = await Promise.race([
        wc.executeJavaScript(fn, true),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('evaluate_timeout')), timeoutMs);
        }),
      ]);
      return { ok: true, value: value as T };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error).slice(0, 300) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Collection ─────────────────────────────────────────────

  /** Extract paper metadata from the current page and save into the library. */
  async collect(): Promise<{ ok: boolean; paper?: CollectedPaper; error?: string }> {
    if (!this.store) return { ok: false, error: 'library_unavailable' };
    const extracted = await this.extract();
    if (!extracted.ok || !extracted.page) {
      return { ok: false, error: extracted.error ?? 'browser_extract_failed' };
    }
    const { title, text, url } = extracted.page;
    const meta = await this.extractMeta();
    let doi = meta.doi ?? detectDoi(text) ?? detectDoi(url);
    const cleanTitle = meta.title ?? title ?? '';
    if (!cleanTitle.trim()) return { ok: false, error: 'browser_no_title' };

    // O2: multi-source metadata fallback. If the page exposes no DOI, try to
    // enrich via CrossRef title search before giving up and saving meta-only.
    let enriched: Partial<CrossrefMetadata> | undefined;
    let metaSource: CollectedPaper['metaSource'] = doi ? 'complete' : 'meta_only';
    if (!doi && cleanTitle.length >= 8) {
      try {
        const candidate = await this.enrichByTitle(cleanTitle);
        if (candidate) {
          enriched = candidate;
          doi = candidate.doi;
          metaSource = 'crossref_enriched';
        } else if (!meta.title) {
          // Not even a usable title from meta — this is a generic web page.
          metaSource = 'webpage';
        }
      } catch {
        // Network/CrossRef failure is non-fatal: keep the meta-only record.
      }
    }

    const existing = this.findExisting(doi ?? '', cleanTitle);
    if (existing) {
      return {
        ok: true,
        paper: { paperId: existing.id, merged: true, title: existing.title, doi: existing.doi ?? undefined, metaSource },
      };
    }
    const paperId = `paper-${randomUUID()}`;
    this.store.savePaper({
      id: paperId,
      title: cleanTitle.trim().slice(0, 500),
      authors: enriched?.authors?.length ? enriched.authors : meta.authors,
      year: enriched?.year ?? meta.year ?? 0,
      venue: enriched?.venue ?? meta.venue ?? '',
      abstract: (enriched?.abstract ?? meta.abstract ?? text.slice(0, 1200)).slice(0, 8000),
      doi: doi ?? '',
      tags: ['collected'],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      pdfUrl: url,
      referenceIds: [],
      addedAt: Date.now(),
    });
    return {
      ok: true,
      paper: { paperId, merged: false, title: cleanTitle.trim().slice(0, 500), doi, metaSource },
    };
  }

  /**
   * O2: best-effort CrossRef enrichment when a collected page exposes no DOI.
   * Searches by title and returns the first match whose title is similar enough
   * (case-insensitive token overlap ≥ 0.6) to avoid false positives. Also
   * re-fetches the full work by DOI when possible for the richest metadata.
   */
  private async enrichByTitle(title: string): Promise<CrossrefMetadata | null> {
    const trimmed = title.trim();
    if (trimmed.length < 8) return null;
    const { works } = await searchWorks({ query: trimmed, limit: 3 });
    if (works.length === 0) return null;
    for (const work of works) {
      if (scoreTitleOverlap(trimmed, work.title) >= 0.6) {
        if (work.doi) {
          try {
            const full = await getWorkByDoi(work.doi);
            if (full) return full;
          } catch {
            // Fall back to the search hit.
          }
        }
        return work;
      }
    }
    return null;
  }

  // ─── Downloads ──────────────────────────────────────────────

  listPendingDownloads(): PendingDownload[] {
    return [...this.pendingDownloads.values()];
  }

  /** Resolve a pending download to a project; saves the PDF there and links it. */
  async acceptDownload(options: {
    id: string;
    projectId: string | null;
    paperId?: string;
    /** 项目自定义目录（metadata.projectDir）：PDF 优先归档到这里。 */
    projectDir?: string | null;
  }): Promise<{ ok: boolean; error?: string; savedPath?: string; paperId?: string }> {
    const pending = this.pendingDownloads.get(options.id);
    if (!pending) return { ok: false, error: 'download_not_found' };
    const ses = this.session;
    if (!ses) return { ok: false, error: 'browser_unavailable' };

    try {
      const outDir = options.projectDir
        ? path.join(options.projectDir, 'pdfs')
        : options.projectId
          ? path.join(this.dataDir, 'projects', options.projectId, 'pdfs')
          : path.join(this.dataDir, 'papers');
      fs.mkdirSync(outDir, { recursive: true });
      const safeName = pending.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
      const destPath = path.join(outDir, safeName);

      const cookieHeader = await this.cookieHeaderFor(pending.url);
      const response = await fetch(pending.url, {
        headers: downloadRequestHeaders(pending, cookieHeader),
        redirect: 'follow',
      });
      if (!response.ok) return { ok: false, error: `download_http_${response.status}` };
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(destPath, buffer);
      this.pendingDownloads.delete(pending.id);

      // Persist the paper (merge by DOI/URL when possible).
      let paperId = options.paperId;
      if (this.store && !paperId) {
        const meta = await this.extractMeta();
        const doi = meta.doi ?? detectDoi(pending.pageUrl);
        const title = resolveDownloadTitle(meta.title, pending.pageTitle, pending.filename);
        const existing = this.findExisting(doi ?? '', title);
        if (existing) {
          paperId = existing.id;
          const full = this.store.getPapers().find((row) => row.id === existing.id);
          if (full) this.store.savePaper({ ...full, pdfPath: destPath });
        } else {
          paperId = `paper-${randomUUID()}`;
          this.store.savePaper({
            id: paperId,
            title: title.slice(0, 500),
            authors: meta.authors,
            year: meta.year ?? 0,
            venue: meta.venue ?? '',
            abstract: meta.abstract ?? '',
            doi: doi ?? '',
            tags: ['downloaded'],
            notes: '',
            readStatus: 'unread',
            rating: 0,
            pdfPath: destPath,
            referenceIds: [],
            addedAt: Date.now(),
          });
        }
      }
      return { ok: true, savedPath: destPath, paperId };
    } catch (error) {
      return { ok: false, error: `download_failed:${String((error as Error).message ?? error).slice(0, 200)}` };
    }
  }

  cancelDownload(id: string): void {
    this.pendingDownloads.delete(id);
  }

  // ─── Helpers ────────────────────────────────────────────────

  private requestDownloadDecision(pending: PendingDownload): void {
    this.pendingDownloads.set(pending.id, pending);
    this.window.webContents.send('browser:download-request', pending);
  }

  private emitState(): void {
    this.window.webContents.send('browser:state', this.getState());
  }

  private toViewPoint(x: number, y: number): { x: number; y: number } | null {
    if (!this.bounds) return null;
    return { x: Math.round(x - this.bounds.x), y: Math.round(y - this.bounds.y) };
  }

  private centerPoint(): { x: number; y: number } | null {
    if (!this.bounds) return null;
    return {
      x: Math.round(this.bounds.width / 2),
      y: Math.round(this.bounds.height / 2),
    };
  }

  private async extractMeta(): Promise<{
    title?: string;
    authors: string[];
    year?: number;
    venue?: string;
    abstract?: string;
    doi?: string;
  }> {
    const wc = this.view?.webContents;
    if (!wc) return { authors: [] };
    try {
      const result = await wc.executeJavaScript(`
        (() => {
          const get = (name) => {
            const el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
            return el ? el.getAttribute('content') ?? '' : '';
          };
          const citation = (name) => get('citation_' + name);
          return {
            title: citation('title') || get('og:title') || '',
            authors: (() => {
              const els = document.querySelectorAll('meta[name="citation_author"]');
              return [...els].map((e) => e.getAttribute('content') ?? '').filter(Boolean);
            })(),
            year: citation('publication_date') || citation('date') || '',
            venue: citation('journal_title') || citation('conference_title') || '',
            abstract: citation('abstract') || '',
            doi: citation('doi') || '',
          };
        })()
      `);
      const yearMatch = String(result?.year ?? '').match(/(19|20)\\d{2}/);
      return {
        title: String(result?.title ?? '') || undefined,
        authors: Array.isArray(result?.authors) ? result.authors : [],
        year: yearMatch ? Number(yearMatch[0]) : undefined,
        venue: String(result?.venue ?? '') || undefined,
        abstract: String(result?.abstract ?? '') || undefined,
        doi: String(result?.doi ?? '') || undefined,
      };
    } catch {
      return { authors: [] };
    }
  }

  private findExisting(doi: string, title: string): { id: string; title: string; doi?: string } | null {
    if (!this.store) return null;
    for (const paper of this.store.getPapers()) {
      if (doi && paper.doi && paper.doi.toLowerCase() === doi.toLowerCase()) {
        return { id: paper.id, title: paper.title, doi: paper.doi ?? undefined };
      }
      if (title && paper.title && paper.title.toLowerCase() === title.toLowerCase()) {
        return { id: paper.id, title: paper.title, doi: paper.doi ?? undefined };
      }
    }
    return null;
  }

  private async cookieHeaderFor(url: string): Promise<string> {
    const ses = this.session;
    if (!ses) return '';
    try {
      const cookies = await ses.cookies.get({ url });
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return '';
    }
  }
}

export function normalizeHttpUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

export function detectDoi(text: string): string | undefined {
  const match = text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].replace(/[.,;)]+$/u, '') : undefined;
}

/**
 * O2: token-overlap similarity score in [0,1] between two titles.
 * Tokens shorter than 3 chars are ignored; case-insensitive. Used to decide
 * whether a CrossRef search hit is similar enough to the page title to accept
 * its metadata, avoiding false-positive enrichment.
 */
export function scoreTitleOverlap(target: string, candidate: string): number {
  const targetTokens = new Set(target.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const candTokens = new Set(candidate.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  if (targetTokens.size === 0 || candTokens.size === 0) return 0;
  let overlap = 0;
  for (const tok of targetTokens) if (candTokens.has(tok)) overlap++;
  return overlap / Math.max(1, Math.min(targetTokens.size, candTokens.size));
}

/** A desktop-Chrome UA so anti-leech endpoints treat the re-fetch as a real browser. */
const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Title preference for a downloaded paper: page metadata → live page title →
 * filename stem. Falsy/empty values fall through so a paper never lands in
 * the library with a blank or stale-home title.
 */
export function resolveDownloadTitle(
  metaTitle: string | undefined,
  pageTitle: string | undefined,
  filename: string,
): string {
  const stem = filename.replace(/\.pdf$/i, '');
  return (metaTitle && metaTitle.trim())
    || (pageTitle && pageTitle.trim())
    || stem
    || 'download';
}

/**
 * Headers for the download re-fetch in acceptDownload. Many academic and
 * publisher sites validate the Referer (anti-leech / "应用来源" checks) and
 * the User-Agent; re-requesting without them makes those sites reject the
 * download even though the in-app browser itself could fetch it. We replay
 * the page URL as Referer (falling back to the file's own origin) and send a
 * real browser UA plus the session cookies.
 */
export function downloadRequestHeaders(
  pending: { url: string; pageUrl?: string },
  cookieHeader: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DOWNLOAD_USER_AGENT,
    Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
  };
  let referer = (pending.pageUrl || '').trim();
  if (!/^https?:\/\//i.test(referer)) {
    try {
      referer = new URL(pending.url).origin + '/';
    } catch {
      referer = '';
    }
  }
  if (referer) headers.Referer = referer;
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}
