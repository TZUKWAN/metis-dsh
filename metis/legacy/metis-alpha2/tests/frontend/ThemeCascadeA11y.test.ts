import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function luminance(rgb: [number, number, number]): number {
  const linear = rgb.map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('FIX-METIS-476 final CSS cascade and selector contracts', () => {
  it('loads AcademicTheme before App and keeps App consumers token-based', () => {
    const entry = read('src/main.tsx');
    expect(entry.indexOf("import './AcademicTheme.css'")).toBeGreaterThan(-1);
    expect(entry.indexOf("import App from './App.tsx'")).toBeGreaterThan(entry.indexOf("import './AcademicTheme.css'"));
    expect(read('src/App.tsx')).toContain("import './App.css'");

    const app = read('src/App.css');
    const consumer = app.match(/\.chat-textarea:focus-visible,[\s\S]*?\.timeline-filter-search:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(consumer).toContain('var(--focus-ring-color)');
    expect(consumer).not.toMatch(/rgba\(176,\s*88,\s*50/);
  });

  it('keeps the dark focus token above the 3:1 non-text contrast floor', () => {
    const theme = read('src/AcademicTheme.css');
    const dark = theme.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const focus = dark.match(/--focus-ring-color:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    const bgHex = dark.match(/--bg-main:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(focus).toBeTruthy();
    expect(bgHex).toBeTruthy();
    const bg: [number, number, number] = [channel(bgHex!, 1), channel(bgHex!, 3), channel(bgHex!, 5)];
    const alpha = Number(focus![4]);
    const ring: [number, number, number] = [1, 2, 3].map((i) => Math.round(Number(focus![i]) * alpha + bg[i - 1] * (1 - alpha))) as [number, number, number];
    expect(contrast(ring, bg)).toBeGreaterThanOrEqual(3);
  });

  it('uses system-color semantics and covers every App focus consumer in forced colors', () => {
    const theme = read('src/AcademicTheme.css');
    expect(theme).toContain('--border: ButtonBorder');
    expect(theme).toContain('--text-body: CanvasText');
    expect(theme).toContain('--focus-ring-color: Highlight');

    const app = read('src/App.css');
    const forced = app.match(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const selector of ['chat-textarea', 'search-input', 'settings-input', 'message-edit', 'note-title-input', 'note-content-input', 'timeline-filter-search']) {
      expect(forced).toContain(selector);
    }
    expect(forced).toContain('Highlight');
  });

  it('keeps forced-color selectors aligned with real page JSX classes', () => {
    const chatCss = read('src/pages/ChatPage.css');
    const chatTsx = read('src/pages/ChatPage.tsx');
    for (const className of ['message-content', 'chat-textarea']) {
      expect(chatCss).toContain(`.${className}`);
      expect(chatTsx).toContain(className);
    }
    expect(chatCss).not.toContain('.message-bubble');
    expect(chatCss).not.toMatch(/\.chat-input(?:[^\w-]|$)/u);

  });

});
