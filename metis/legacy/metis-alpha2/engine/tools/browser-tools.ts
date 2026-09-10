/**
 * Research-browser tool bridge — lets the agent drive the embedded browser
 * (kimi-bridge style: navigate, click, type, scroll, screenshot, extract,
 * collect). The main process injects a real bridge backed by BrowserService;
 * in non-Electron contexts the tools fail closed.
 */

import type { ToolHandler } from './ToolDispatcher.js';

export interface BrowserControlBridge {
  navigate(url: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  back(): void;
  forward(): void;
  reload(): void;
  click(x: number, y: number): void;
  type(text: string): void;
  scroll(deltaX: number, deltaY: number): void;
  screenshot(): Promise<{ ok: boolean; imageBase64?: string; error?: string }>;
  extract(): Promise<{ ok: boolean; page?: { title: string; text: string; url: string; links: string[] }; error?: string }>;
  collect(): Promise<{ ok: boolean; paper?: { paperId: string; merged: boolean; title: string }; error?: string }>;
}

let bridge: BrowserControlBridge | null = null;

export function setBrowserControlBridge(next: BrowserControlBridge | null): void {
  bridge = next;
}

export function getBrowserControlBridge(): BrowserControlBridge | null {
  return bridge;
}

function requireBridge(): BrowserControlBridge {
  if (!bridge) throw new Error('browser control unavailable');
  return bridge;
}

function resultText(value: { ok: boolean; error?: string }): string {
  return value.ok ? 'ok' : `error: ${value.error ?? 'unknown'}`;
}

export const browserNavigateHandler: ToolHandler = async (args) => {
  const url = String(args.url ?? '');
  if (!url) throw new Error('No url provided.');
  return resultText(await requireBridge().navigate(url));
};

export const browserBackHandler: ToolHandler = async () => {
  requireBridge().back();
  return 'ok';
};

export const browserForwardHandler: ToolHandler = async () => {
  requireBridge().forward();
  return 'ok';
};

export const browserReloadHandler: ToolHandler = async () => {
  requireBridge().reload();
  return 'ok';
};

export const browserClickHandler: ToolHandler = async (args) => {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid click coordinates.');
  requireBridge().click(x, y);
  return 'ok';
};

export const browserTypeHandler: ToolHandler = async (args) => {
  const text = String(args.text ?? '');
  if (!text) throw new Error('No text provided.');
  requireBridge().type(text);
  return 'ok';
};

export const browserScrollHandler: ToolHandler = async (args) => {
  const deltaX = Number(args.deltaX) || 0;
  const deltaY = Number(args.deltaY) || 0;
  requireBridge().scroll(deltaX, deltaY);
  return 'ok';
};

export const browserScreenshotHandler: ToolHandler = async () => {
  const shot = await requireBridge().screenshot();
  if (!shot.ok || !shot.imageBase64) return `error: ${shot.error ?? 'screenshot failed'}`;
  return JSON.stringify({ dataUrl: `data:image/png;base64,${shot.imageBase64}` });
};

export const browserExtractHandler: ToolHandler = async () => {
  const extracted = await requireBridge().extract();
  if (!extracted.ok || !extracted.page) return `error: ${extracted.error ?? 'extract failed'}`;
  const page = extracted.page;
  return JSON.stringify({
    url: page.url,
    title: page.title,
    text: page.text.slice(0, 20000),
    links: page.links.slice(0, 50),
  });
};

export const browserCollectHandler: ToolHandler = async () => {
  const collected = await requireBridge().collect();
  if (!collected.ok || !collected.paper) return `error: ${collected.error ?? 'collection failed'}`;
  return JSON.stringify({
    paperId: collected.paper.paperId,
    merged: collected.paper.merged,
    title: collected.paper.title,
    note: collected.paper.merged
      ? 'already in library — merged'
      : 'collected into the library',
  });
};
