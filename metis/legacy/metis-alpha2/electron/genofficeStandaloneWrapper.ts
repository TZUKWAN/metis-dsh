/**
 * METIS-owned launcher boundary for GenOffice standalone editors.
 *
 * GenOffice's unified shell registers the app-wide theme IPC handler, while the
 * standalone editor entry points intentionally do not. The renderer still
 * asks for that shared channel, so this wrapper supplies only the safe theme
 * bridge before loading the read-only GenOffice entry module.
 */
import { app, ipcMain, nativeTheme, webContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseGenofficeStandaloneArgs } from './genofficeStandaloneArgs.js';
import { encodeGenofficeReadyMessage } from './genofficeStandaloneProtocol.js';
import { readinessExpressionFor } from './genofficeStandaloneReadiness.js';
import { needsPdfStandaloneCompatibility } from './genofficeStandaloneCompatibility.js';

const parsed = parseGenofficeStandaloneArgs(process.argv);
const entry = parsed.entry;
const envFilePath = process.env.XLSX_OPEN_PATH?.trim();
const filePath = parsed.filePath ?? (envFilePath || null);
const kind = /[\\/]apps[\\/]docs[\\/]/iu.test(entry)
  ? 'word'
  : /[\\/]apps[\\/]slides[\\/]/iu.test(entry)
    ? 'ppt'
    : /[\\/]apps[\\/]sheets[\\/]/iu.test(entry)
      ? 'spreadsheet'
      : 'pdf';

// Metis Office: theme follows METIS. The initial value is injected by the
// launcher; per-app overrides are rejected so appearance stays aligned.
const metisTheme = process.env.METIS_UI_THEME === 'dark'
  ? 'dark'
  : process.env.METIS_UI_THEME === 'light'
    ? 'light'
    : nativeTheme.themeSource;
nativeTheme.themeSource = metisTheme;

// ── Metis Office: AI follows METIS's current provider connection ──
// The launcher injects the exact connection METIS is using (OpenAI-compatible)
// via environment; the editor's own settings UI is fed this fixed profile so
// there is no second place to configure models.
const metisAiBaseUrl = process.env.METIS_AI_BASE_URL?.trim() ?? '';
const metisAiApiKey = process.env.METIS_AI_API_KEY?.trim() ?? '';
const metisAiModel = process.env.METIS_AI_MODEL?.trim() ?? '';
const metisAiAligned = metisAiBaseUrl !== '' && metisAiApiKey !== '' && metisAiModel !== '';
const metisAiSettings = () => ({
  provider: 'custom' as const,
  gskToolsEnabled: false,
  providers: {
    ...({} as Record<string, { apiKey: string; model: string }>),
    custom: {
      apiKey: metisAiApiKey,
      model: metisAiModel,
      baseUrl: metisAiBaseUrl,
    },
  },
});

type MetisIpcOverride = {
  channel: string;
  handler: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown;
};

// Wrapper-owned IPC overrides. They must NOT be registered before the entry
// module loads: the GenOffice apps register their own handlers for the same
// channels (e.g. `ai:get-settings` in Docs) and a duplicate registration
// crashes the child at startup. Applying the overrides after the import —
// and re-asserting them on every window load — makes the METIS-owned behavior
// (theme lock, AI alignment, PDF isolation stubs) win deterministically.
const metisIpcOverrides: MetisIpcOverride[] = [
  {
    channel: 'app:get-theme',
    handler: () => metisTheme,
  },
  {
    channel: 'app:set-theme',
    handler: (_event, value: unknown) => {
      // Theme is owned by METIS; standalone changes are ignored by design.
      void value;
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) contents.send('app:theme-changed', metisTheme);
      }
      return true;
    },
  },
  ...(needsPdfStandaloneCompatibility(kind) ? ([
    {
      channel: 'project:resolveChat',
      handler: (_event, args: { tempChatId?: unknown }) => ({
        projectId: 'standalone',
        chatId: typeof args?.tempChatId === 'string' && args.tempChatId.length > 0
          ? args.tempChatId
          : `standalone-${Date.now()}`,
      }),
    },
    { channel: 'project:appendChat', handler: () => undefined },
    { channel: 'project:loadChat', handler: () => [] as never[] },
    { channel: 'project:rebindChat', handler: () => null },
  ] as MetisIpcOverride[]) : []),
  { channel: 'ai:gsk-status', handler: () => ({ loggedIn: false }) },
  {
    channel: 'ai:get-settings',
    handler: () => (metisAiAligned
      ? metisAiSettings()
      : { provider: 'genspark', gskToolsEnabled: false, providers: { genspark: { apiKey: '', model: '' } } }),
  },
  {
    channel: 'ai:set-settings',
    handler: () => {
      // Settings are owned by METIS; per-editor changes are ignored by design.
      return metisAiAligned ? metisAiSettings() : false;
    },
  },
];

function applyMetisIpcOverrides(): void {
  for (const { channel, handler } of metisIpcOverrides) {
    try {
      ipcMain.removeHandler(channel);
    } catch { /* nothing registered yet */ }
    try {
      ipcMain.handle(channel, handler as never);
    } catch { /* a just-registered app handler wins this channel */ }
  }
}

let ready = false;
const emitReady = () => {
  if (ready) return;
  ready = true;
  process.stdout.write(encodeGenofficeReadyMessage({ entry, filePath, editorReady: true }));
};

const brandTitle = `Metis Office — ${filePath ? path.basename(filePath) : kind}`;
// The host renderer keeps its own document.title, legacy "Genspark" brand
// strings, and the original vendor logo SVG (rounded-square mark inside
// .rb-big-icon / .ai-panel-title). Rewrite all three so the visible chrome is
// Metis Office only: texts become "Metis" and both logo marks become the
// Metis twin-sparkle star. The MutationObserver converges: rewrites only touch
// nodes that still carry the old brand.
const brandScript = `(() => {
  try {
    // A brand mark is the icon of a control whose entire visible text is the
    // brand name itself (Metis AI / Genspark AI / Metis), or the legacy vendor
    // logo path. Feature controls (AI 美化, AI 配图, scissors, ...) never match
    // and keep their own icons untouched.
    const BRAND_TEXTS = { 'metis ai': 1, 'genspark ai': 1, 'metis': 1, 'genspark': 1 };
    const isBrandMark = (svg) => {
      if (!svg || !svg.querySelector) return false;
      const path = svg.querySelector('path');
      if (path && (path.getAttribute('d') || '').indexOf('M105.115') === 0) return true;
      let host = svg.closest('button') || svg.closest('[role="button"]') || svg.parentElement;
      for (let hop = 0; host && hop < 3; hop += 1) {
        const text = (host.textContent || '').trim().toLowerCase();
        if (BRAND_TEXTS[text]) return true;
        if (text && !BRAND_TEXTS[text]) return false;
        host = host.parentElement;
      }
      return false;
    };
    const swapStars = () => {
      for (const svg of document.querySelectorAll('svg')) {
        if (!isBrandMark(svg) || svg.getAttribute('data-metis-star') === '1') continue;
        const firstPath = svg.querySelector('path');
        const fill = firstPath ? firstPath.getAttribute('fill') : null;
        const attr = fill ? ' fill="' + fill + '"' : '';
        svg.innerHTML =
          '<path' + attr + ' d="M65 8C70.5 44 86 59.5 122 65C86 70.5 70.5 86 65 122C59.5 86 44 70.5 8 65C44 59.5 59.5 44 65 8Z"/>' +
          '<path' + attr + ' d="M27 82C29.3 94.5 33 98.2 45.5 100.5C33 102.8 29.3 106.5 27 119C24.7 106.5 21 102.8 8.5 100.5C21 98.2 24.7 94.5 27 82Z"/>';
        svg.setAttribute('data-metis-star', '1');
      }
    };
    const rewrite = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.includes('Genspark')) {
          node.textContent = node.textContent.split('Genspark').join('Metis');
        }
      }
    };
    const apply = () => { rewrite(document.body); swapStars(); };
    apply();
    new MutationObserver(apply)
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch {}
  try { document.title = ${JSON.stringify(brandTitle)}; } catch {}
  return true;
})()`;

const targetLoaded = async (window: Electron.BrowserWindow): Promise<boolean> => {
  if (!filePath || window.webContents.isDestroyed()) return false;
  const expression = readinessExpressionFor(kind, path.basename(filePath));
  try {
    return await window.webContents.executeJavaScript(`Boolean(${expression})`, true) as boolean;
  } catch {
    return false;
  }
};

app.on('browser-window-created', (_event, window) => {
  // The editor renderer drives document.title (e.g. per-document filenames);
  // keep the OS window on the Metis Office brand instead.
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    if (window.getTitle() !== brandTitle) window.setTitle(brandTitle);
  });
  // Re-assert the overrides in case the entry deferred part of its IPC
  // registration past the import; removeHandler+handle is idempotent.
  window.webContents.once('did-finish-load', () => {
    applyMetisIpcOverrides();
    // Metis Office branding: the host window is branded and the visible
    // legacy brand strings are rewritten; the one-time AI-rewrite
    // acknowledgement (Docs) is pre-accepted so no onboarding prompts appear.
    try { window.setTitle(brandTitle); } catch { /* window may be gone */ }
    void window.webContents.executeJavaScript(brandScript, true).catch(() => undefined);
    if (kind === 'word') {
      void window.webContents.executeJavaScript(
        `try { localStorage.setItem('docs-ai-rewrite-ack', '1'); } catch {} true`,
        true,
      ).catch(() => undefined);
    }
    if (process.env.METIS_GENOFFICE_DEBUG === '1' && process.env.METIS_GENOFFICE_DEBUG_PORT && filePath) {
      void window.webContents.executeJavaScript(
        `window.__metisStandaloneFilePath = ${JSON.stringify(filePath)}; true`,
        true,
      ).catch(() => undefined);
    }
    let openRetry: ReturnType<typeof setInterval> | undefined;
    if (kind === 'spreadsheet') {
      // Standalone Sheets starts with an in-memory blank workbook. Its renderer
      // owns the open state transition, so route through its real menu action.
      const requestOpen = () => {
        if (!ready && !window.webContents.isDestroyed()) window.webContents.send('menu:action', 'open');
      };
      openRetry = setInterval(requestOpen, 500);
      setTimeout(requestOpen, 100);
    }
    const deadline = Date.now() + 30_000;
    const wait = async (): Promise<void> => {
      if (ready) return;
      if (Date.now() > deadline) {
        console.error('[METIS GenOffice] target document did not become ready');
        app.exit(1);
        return;
      }
      if (await targetLoaded(window)) {
        if (openRetry) clearInterval(openRetry);
        emitReady();
      } else setTimeout(() => void wait(), 100);
    };
    void wait();
  });
  window.webContents.once('did-fail-load', (_loadEvent, errorCode, errorDescription) => {
    if (ready) return;
    console.error(`[METIS GenOffice] renderer failed to load (${errorCode}): ${errorDescription}`);
    app.exit(1);
  });
});

void app.whenReady().then(async () => {
  try {
    // Electron keeps its own switches and the wrapper path in argv. Normalize
    // the remaining application argv before loading a standalone GenOffice
    // entry so its existing file consumers see the same shape as a direct
    // `electron <editor-entry> <document>` launch.
    process.argv = filePath
      ? [process.argv[0] ?? 'electron', process.argv[1] ?? entry, filePath]
      : [process.argv[0] ?? 'electron', process.argv[1] ?? entry];
    await import(pathToFileURL(entry).href);
    applyMetisIpcOverrides();
    // A few entries finish their own registration inside queued whenReady
    // callbacks; re-assert once the current microtask queue drains so the
    // METIS-owned channels still end up owned by this wrapper.
    setTimeout(applyMetisIpcOverrides, 0);
  } catch (error) {
    console.error('[METIS GenOffice] standalone entry failed to load', error);
    app.exit(1);
  }
});
