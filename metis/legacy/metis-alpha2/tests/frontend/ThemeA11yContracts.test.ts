/**
 * METIS theme and accessibility regression contracts.
 *
 * @vitest-environment jsdom
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DESIGN_TOKEN_PROPERTIES,
  readComputedDesignTokens,
} from '../../src/shell/designTokens.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const THEME_PATH = join(REPO_ROOT, 'src', 'AcademicTheme.css');
const TOKEN_SOURCE_PATH = join(REPO_ROOT, 'src', 'shell', 'designTokens.ts');
const THEME_CSS = readFileSync(THEME_PATH, 'utf8');

function collectCssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectCssFiles(path);
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
  });
}

const CONSUMER_CSS_FILES = [
  join(REPO_ROOT, 'src', 'App.css'),
  ...collectCssFiles(join(REPO_ROOT, 'src', 'shell')),
  ...collectCssFiles(join(REPO_ROOT, 'src', 'research')),
];

function declarationsForSelector(css: string, selector: string): Map<string, string> {
  const declarations = new Map<string, string>();
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector !== selector) return;
    if (rule.parent?.type === 'atrule') return;
    rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

function resolveCustomProperties(value: string, properties: Map<string, string>): string {
  let resolved = value;
  for (let pass = 0; pass < 12 && resolved.includes('var('); pass += 1) {
    const next = resolved.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/gu, (_match, name: string, fallback?: string) => {
      return properties.get(name) ?? fallback ?? `var(${name})`;
    });
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe('METIS single-source theme contract', () => {
  beforeEach(() => {
    document.head.innerHTML = `<style>${THEME_CSS}</style>`;
    document.documentElement.removeAttribute('data-theme');
  });

  it('reads light and dark token values from computed CSS instead of a mirrored TS palette', () => {
    const light = readComputedDesignTokens(document.documentElement);
    expect(light.accentPrimary).toBe('#2563EB');
    expect(light.chartPalette[3]).toBe('#4F7396');

    document.documentElement.dataset.theme = 'dark';
    const dark = readComputedDesignTokens(document.documentElement);
    expect(dark.accentPrimary).toBe('#3B82F6');
    expect(dark.chartPalette[3]).toBe('#7FAAD4');
  });

  it('keeps TS as a property-name adapter with no duplicated theme values', () => {
    const source = readFileSync(TOKEN_SOURCE_PATH, 'utf8');
    expect(source).not.toMatch(/\b(?:LIGHT|DARK)_TOKENS\b/u);
    expect(source).not.toContain('applyDesignTokens');
    expect(source).not.toMatch(/#[\da-f]{3,8}|rgba?\(/iu);

    const lightDeclarations = declarationsForSelector(THEME_CSS, ':root');
    for (const property of Object.values(DESIGN_TOKEN_PROPERTIES)) {
      if (Array.isArray(property)) {
        for (const chartProperty of property) expect(lightDeclarations.has(chartProperty)).toBe(true);
      } else {
        expect(lightDeclarations.has(property)).toBe(true);
      }
    }
  });
});

describe('METIS focus and color contracts', () => {
  it('separates focus color from focus shadow and defines the legacy primary text alias', () => {
    const light = declarationsForSelector(THEME_CSS, ':root');
    const dark = declarationsForSelector(THEME_CSS, '[data-theme="dark"]');
    for (const declarations of [light, dark]) {
      expect(declarations.get('--focus-ring-color')).toMatch(/^rgba?\(/u);
      expect(declarations.get('--focus-ring-shadow')).toMatch(/^0 0 0 2px rgba?\(/u);
    }
    expect(light.get('--text-on-primary')).toBe('var(--text-on-accent)');
  });

  it('resolves every focus outline consumer to a legal width/style/color value', () => {
    const themeProperties = declarationsForSelector(THEME_CSS, ':root');
    const checked: string[] = [];

    for (const path of CONSUMER_CSS_FILES) {
      const root = postcss.parse(readFileSync(path, 'utf8'), { from: path });
      const properties = new Map(themeProperties);
      root.walkDecls(/^--/u, (declaration) => properties.set(declaration.prop, declaration.value));
      root.walkDecls('outline', (declaration) => {
        if (!declaration.value.includes('focus')) return;
        const resolved = resolveCustomProperties(declaration.value, properties);
        checked.push(`${relative(REPO_ROOT, path)}:${declaration.source?.start?.line ?? 0}`);
        expect(resolved, checked.at(-1)).toMatch(/^\d+(?:\.\d+)?px solid (?:#[\da-f]{3,8}|rgba?\([^)]*\)|CanvasText|ButtonText|ButtonBorder|Highlight)$/iu);
      });
    }

    expect(checked.length).toBeGreaterThanOrEqual(25);
  });

  it('meets WCAG AA contrast for small body, muted, and accent text in both themes', () => {
    const light = readComputedDesignTokens(document.documentElement);
    document.documentElement.dataset.theme = 'dark';
    const dark = readComputedDesignTokens(document.documentElement);

    const pairs = [
      [light.textBody, light.bgMain],
      [light.textMuted, light.bgMain],
      [light.textMuted, light.bgCard],
      [light.textOnAccent, light.accentPrimary],
      [light.accentPrimary, light.bgMain],
      [dark.textBody, dark.bgMain],
      [dark.textMuted, dark.bgCard],
      [dark.textOnAccent, dark.accentPrimary],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(contrastRatio(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('accent theme matrix (light/dark × gold/blue/green/gray)', () => {
  const ACCENTS = ['gold', 'blue', 'green', 'gray'] as const;
  const EXPECTED_ACCENT = {
    light: { gold: '#A16207', blue: '#2563EB', green: '#15803D', gray: '#52525B' },
    dark: { gold: '#D97706', blue: '#3B82F6', green: '#22C55E', gray: '#A1A1AA' },
  } as const;

  beforeEach(() => {
    document.head.innerHTML = `<style>${THEME_CSS}</style>`;
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-accent');
  });

  afterAll(() => {
    document.documentElement.removeAttribute('data-accent');
  });

  it('resolves the expected accent per mode and meets WCAG AA on surfaces and on-accent text', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const accent of ACCENTS) {
        if (mode === 'dark') {
          document.documentElement.dataset.theme = 'dark';
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
        document.documentElement.dataset.accent = accent;
        const tokens = readComputedDesignTokens(document.documentElement);
        expect(tokens.accentPrimary, `${mode}/${accent} accent`).toBe(EXPECTED_ACCENT[mode][accent]);
        expect(
          contrastRatio(tokens.accentPrimary, tokens.bgMain),
          `${mode}/${accent} accent on bg-main`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(tokens.accentPrimary, tokens.bgCard),
          `${mode}/${accent} accent on bg-card`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(tokens.textOnAccent, tokens.accentPrimary),
          `${mode}/${accent} text-on-accent`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the no-accent fallback identical to the pre-accent defaults', () => {
    expect(readComputedDesignTokens(document.documentElement).accentPrimary).toBe('#2563EB');
    document.documentElement.dataset.theme = 'dark';
    expect(readComputedDesignTokens(document.documentElement).accentPrimary).toBe('#3B82F6');
  });

  it('blue accent reproduces the default look exactly', () => {
    document.documentElement.dataset.accent = 'blue';
    expect(readComputedDesignTokens(document.documentElement).accentPrimary).toBe('#2563EB');
    document.documentElement.dataset.theme = 'dark';
    expect(readComputedDesignTokens(document.documentElement).accentPrimary).toBe('#3B82F6');
  });
});

describe('METIS visual-residue contracts', () => {
  it('contains no obsolete blue accent fallback outside the semantic chart palette', () => {
    const forbidden = /#(?:89b4fa|3b82f6|2c5282|1a365d|1e5a9e|ebf4ff|90cdf4)|rgba?\(\s*(?:137\s*,\s*180\s*,\s*250|59\s*,\s*130\s*,\s*246)|rgb\(\s*99\s+179\s+237/iu;
    for (const path of CONSUMER_CSS_FILES) {
      expect(readFileSync(path, 'utf8'), relative(REPO_ROOT, path)).not.toMatch(forbidden);
    }
  });

  it('caps literal border radii at 16px and removes uppercase presentation', () => {
    for (const path of CONSUMER_CSS_FILES) {
      const css = readFileSync(path, 'utf8');
      const oversized = [...css.matchAll(/border-radius:\s*(\d+(?:\.\d+)?)px/giu)]
        .map((match) => Number(match[1]))
        .filter((radius) => radius > 16);
      expect(oversized, relative(REPO_ROOT, path)).toEqual([]);
      expect(css, relative(REPO_ROOT, path)).not.toMatch(/text-transform:\s*uppercase/iu);
    }
  });
});

describe('aurora glass disabled in the rational design system', () => {
  const AURORA_TOKENS = [
    '--aurora-1',
    '--aurora-2',
    '--aurora-3',
    '--aurora-opacity',
    '--glass-surface',
    '--glass-surface-strong',
    '--glass-blur',
    '--glass-blur-strong',
    '--glass-saturate',
    '--glass-edge',
    '--bg-card-glass',
    '--accent-gradient',
    '--accent-gradient-soft',
    '--glow-accent',
    '--glow-accent-soft',
    '--title-gradient',
  ] as const;

  it('declares every aurora/glass token in both light and dark bases for backwards compatibility', () => {
    const light = declarationsForSelector(THEME_CSS, ':root');
    const dark = declarationsForSelector(THEME_CSS, '[data-theme="dark"]');
    for (const property of AURORA_TOKENS) {
      expect(light.has(property), `light ${property}`).toBe(true);
      expect(dark.has(property), `dark ${property}`).toBe(true);
    }
  });

  it('keeps aurora backdrop opacity at zero so no decorative glow leaks through', () => {
    const light = declarationsForSelector(THEME_CSS, ':root');
    expect(light.get('--aurora-opacity')).toBe('0');
  });

  it('keeps aurora backdrop opacity switchable for forced colors and reduced transparency', () => {
    const forcedBlock = THEME_CSS.slice(THEME_CSS.indexOf('@media (forced-colors: active)'));
    expect(forcedBlock).toContain('--aurora-opacity: 0');
  });

  it('keeps gradient/glow tokens disabled in the new rational system', () => {
    const light = declarationsForSelector(THEME_CSS, ':root');
    expect(light.get('--accent-gradient')).toBe('none');
    expect(light.get('--glow-accent')).toBe('none');
    expect(light.get('--glow-accent-soft')).toBe('none');
    expect(light.get('--title-gradient')).toBe('none');
  });
});
