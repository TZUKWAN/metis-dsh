/**
 * METIS design-token smoke contract.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readComputedDesignTokens } from '../../src/shell/designTokens.js';

const themeCss = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'AcademicTheme.css'),
  'utf8',
);

describe('METIS computed design tokens', () => {
  beforeEach(() => {
    document.head.innerHTML = `<style>${themeCss}</style>`;
    document.documentElement.removeAttribute('data-theme');
  });

  it('uses the rational blue accent in light mode', () => {
    const tokens = readComputedDesignTokens();
    expect(tokens.accentPrimary).toBe('#2563EB');
    expect(tokens.accentHover).toBe('#1F5ED0');
  });

  it('uses the dark-mode blue accent in dark mode', () => {
    document.documentElement.dataset.theme = 'dark';
    const tokens = readComputedDesignTokens();
    expect(tokens.accentPrimary).toBe('#3B82F6');
    expect(tokens.accentHover).toBe('#60A5FA');
  });

  it('exposes eight distinct semantic chart colors and retains chart blue', () => {
    const light = readComputedDesignTokens();
    expect(light.chartPalette).toHaveLength(8);
    expect(new Set(light.chartPalette).size).toBe(8);
    expect(light.chartPalette[0]).toBe(light.accentPrimary);
    expect(light.chartPalette[3]).toBe('#4F7396');

    document.documentElement.dataset.theme = 'dark';
    expect(readComputedDesignTokens().chartPalette[3]).toBe('#7FAAD4');
  });

  it('provides separate legal focus color and shadow values', () => {
    const tokens = readComputedDesignTokens();
    expect(tokens.focusRingColor).toMatch(/^rgba?\(/u);
    expect(tokens.focusRingShadow).toMatch(/^0 0 0 2px rgba?\(/u);
  });

  it('keeps the rational type and radius scale', () => {
    const tokens = readComputedDesignTokens();
    expect(tokens.fontSans).toContain('Inter');
    expect(tokens.fontSans).toContain('Noto Sans SC');
    expect(tokens.fontSerif).toContain('Source Han Serif SC');
    expect(tokens.fontMono).toContain('JetBrains Mono');
    expect(tokens.radiusSm).toBe('6px');
    expect(tokens.radiusCard).toBe('8px');
    expect(tokens.radiusMd).toBe('12px');
  });

  it('AA contrast: accent-on-card meets WCAG 4.5:1 minimum', () => {
    const tokens = readComputedDesignTokens();
    const accent = tokens.accentPrimary;
    const bg = tokens.bgCard;
    const ratio = contrastRatio(accent, bg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('AA contrast: text-heading on background meets WCAG 4.5:1', () => {
    const tokens = readComputedDesignTokens();
    const ratio = contrastRatio(tokens.textHeading, tokens.bgMain);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('AA contrast: text-on-accent on accent meets WCAG 3:1 (large text)', () => {
    const tokens = readComputedDesignTokens();
    const ratio = contrastRatio(tokens.textOnAccent, tokens.accentPrimary);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it('token parity: TS tokens match CSS custom properties', () => {
    const tokens = readComputedDesignTokens();
    const style = getComputedStyle(document.documentElement);
    expect(tokens.accentPrimary).toBe(style.getPropertyValue('--accent').trim());
    expect(tokens.bgMain).toBe(style.getPropertyValue('--bg-main').trim());
    expect(tokens.textHeading).toBe(style.getPropertyValue('--text-heading').trim());
    expect(tokens.textOnAccent).toBe(style.getPropertyValue('--text-on-accent').trim());
  });

  it('focus-ring derives from the active accent', () => {
    const style = getComputedStyle(document.documentElement);
    const ring = style.getPropertyValue('--focus-ring').trim();
    expect(ring).toMatch(/^0 0 0 2px rgba?\(/);
  });

  it('dark mode: accent-on-card meets WCAG 4.5:1', () => {
    document.documentElement.dataset.theme = 'dark';
    const tokens = readComputedDesignTokens();
    const ratio = contrastRatio(tokens.accentPrimary, tokens.bgCard);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex);
  if (!m) throw new Error(`Invalid hex: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function parseRgba(color: string): [number, number, number] | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function relativeLuminance(color: string): number {
  let rgb: [number, number, number];
  if (color.startsWith('#')) {
    rgb = hexToRgb(color);
  } else {
    const parsed = parseRgba(color);
    if (!parsed) throw new Error(`Cannot parse color: ${color}`);
    rgb = parsed;
  }
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(c1: string, c2: string): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
