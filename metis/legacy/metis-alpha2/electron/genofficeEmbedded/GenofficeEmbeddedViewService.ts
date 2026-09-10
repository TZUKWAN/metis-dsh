import path from 'node:path';
import { BrowserWindow, WebContentsView } from 'electron';
import { appSubdirFor, type EmbeddedGenofficeKind, type EmbeddedViewSession } from './genofficeEmbeddedTypes.js';

export interface EmbeddedViewRoots {
  /** GenOffice staging root: dist-electron/genoffice (dev) or resources/genoffice (packaged). */
  genofficeRoot: string;
}

export interface EmbeddedOpenInput {
  token: string;
  kind: EmbeddedGenofficeKind;
  projectId: string;
  outcomeId: string;
  filePath: string;
  fileName: string;
  ownerWindow: BrowserWindow;
  debugPort?: number;
}

interface EmbeddedViewEntry {
  view: WebContentsView;
  owner: BrowserWindow;
  session: EmbeddedViewSession;
}

/**
 * Hosts one GenOffice renderer per embedded session as a WebContentsView
 * parented to the METIS main window. The view floats over the editor rect
 * reported by the renderer; bounds/visibility are driven through IPC.
 */
export class GenofficeEmbeddedViewService {
  private readonly entries = new Map<number, EmbeddedViewEntry>();

  constructor(private readonly roots: EmbeddedViewRoots) {}

  getSessionByWebContents(webContentsId: number): EmbeddedViewSession | undefined {
    return this.entries.get(webContentsId)?.session;
  }

  getSessionByOutcome(outcomeId: string): EmbeddedViewSession | undefined {
    for (const [, entry] of this.entries) {
      if (entry.session.outcomeId === outcomeId) return entry.session;
    }
    return undefined;
  }

  has(webContentsId: number): boolean {
    return this.entries.has(webContentsId);
  }

  /** Push METIS theme changes into every live embedded renderer. */
  broadcastTheme(value: string): void {
    for (const [, entry] of this.entries) {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send('app:theme-changed', value);
    }
  }

  async open(input: EmbeddedOpenInput): Promise<EmbeddedViewSession> {
    // One embedded surface per outcome; re-opening refocuses the live view.
    const existing = this.getSessionByOutcome(input.outcomeId);
    if (existing) {
      const existingEntry = this.entries.get(existing.viewId);
      if (existingEntry && !input.ownerWindow.isDestroyed()) {
        input.ownerWindow.contentView.addChildView(existingEntry.view);
        this.focus(existing.viewId);
        return existing;
      }
    }

    const subdir = appSubdirFor(input.kind);
    const appDir = path.join(this.roots.genofficeRoot, 'apps', subdir);
    const preloadPath = path.join(appDir, 'out', 'preload', 'index.js');
    const rendererPath = path.join(appDir, 'out', 'renderer', 'index.html');

    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        // A dedicated partition keeps GenOffice caches/localStorage away from
        // the host page and lets this view be torn down without side effects.
        partition: `genoffice-embedded-${input.token}`,
      },
    });
    view.setBackgroundColor('#ffffff');

    if (input.debugPort !== undefined && Number.isInteger(input.debugPort)) {
      view.webContents.debugger.attach('1.3');
    }

    const session: EmbeddedViewSession = {
      token: input.token,
      kind: input.kind,
      projectId: input.projectId,
      outcomeId: input.outcomeId,
      filePath: input.filePath,
      fileName: input.fileName,
      viewId: view.webContents.id,
      partition: `genoffice-embedded-${input.token}`,
    };

    this.entries.set(view.webContents.id, { view, owner: input.ownerWindow, session });
    input.ownerWindow.contentView.addChildView(view);

    await view.webContents.loadFile(rendererPath);
    // Same injection contract as standalone debug mode: the renderer reads the
    // session path from here when its own argv channel is unavailable.
    await view.webContents.executeJavaScript(
      `window.__metisStandaloneFilePath = ${JSON.stringify(input.filePath)}; true`,
      true,
    ).catch(() => undefined);

    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('console-message', (event) => {
      const detail = event as unknown as { level: number | string; message: string };
      const level = Number(detail.level) || 0;
      if (level >= 1) console.warn(`[genoffice-embedded:${input.kind}][console${level}]`, String(detail.message).slice(0, 400));
    });
    view.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`[genoffice-embedded:${input.kind}] preload failed: ${preloadPath}`, error instanceof Error ? error.message : error);
    });
    view.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[genoffice-embedded:${input.kind}] load failed (${code}): ${description} @ ${url}`);
    });
    view.webContents.on('did-finish-load', () => {
      console.info(`[genoffice-embedded:${input.kind}] renderer loaded`);
      view.webContents.executeJavaScript(
        `JSON.stringify({ prosemirror: !!document.querySelector('.editor-scroll .ProseMirror'), bodyChildren: document.body?.children.length ?? 0, title: document.title })`,
        true,
      ).then((state) => console.info(`[genoffice-embedded:${input.kind}] dom probe:`, state))
        .catch((error) => console.error(`[genoffice-embedded:${input.kind}] probe failed:`, error instanceof Error ? error.message : error));
    });
    return session;
  }

  /** Sync the floating view onto the renderer-reported editor rect (CSS px). */
  setBounds(ownerWindow: BrowserWindow, webContentsId: number, rect: { x: number; y: number; width: number; height: number }): void {
    const entry = this.entries.get(webContentsId);
    if (!entry || entry.owner.isDestroyed()) return;
    // renderer getBoundingClientRect() 是视口(DIP)坐标；WebContentsView 的
    // setBounds 以窗口内容区左上角为原点。内容区原点 = 窗口 bounds - 内容
    // bounds 的边框差。Windows 上 frame 窗口的边框差非零，直接加屏幕坐标
    // 会把视图推到右下角（首嵌实测复现），因此用边框差修正。
    const windowBounds = entry.owner.getBounds();
    const contentBounds = entry.owner.getContentBounds();
    const frameOffsetX = contentBounds.x - windowBounds.x;
    const frameOffsetY = contentBounds.y - windowBounds.y;
    entry.view.setBounds({
      x: Math.round(frameOffsetX + rect.x),
      y: Math.round(frameOffsetY + rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
  }

  hide(webContentsId: number): void {
    const entry = this.entries.get(webContentsId);
    if (!entry || entry.owner.isDestroyed()) return;
    entry.owner.contentView.removeChildView(entry.view);
  }

  show(ownerWindow: BrowserWindow | null, webContentsId: number): void {
    const entry = this.entries.get(webContentsId);
    if (!entry) return;
    const target = ownerWindow !== null && !ownerWindow.isDestroyed() ? ownerWindow : entry.owner;
    if (target.isDestroyed()) return;
    target.contentView.addChildView(entry.view);
  }

  focus(webContentsId: number): void {
    this.entries.get(webContentsId)?.view.webContents.focus();
  }

  closeByOutcome(outcomeId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.session.outcomeId !== outcomeId) continue;
      if (!entry.owner.isDestroyed()) entry.owner.contentView.removeChildView(entry.view);
      this.entries.delete(id);
      try {
        entry.view.webContents.close();
      } catch { /* already destroyed */ }
    }
  }

  shutdownAll(): void {
    for (const [, entry] of this.entries) {
      try {
        entry.view.webContents.close();
      } catch { /* already destroyed */ }
    }
    this.entries.clear();
  }
}
