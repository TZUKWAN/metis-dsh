import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

type Rgb = [number, number, number];

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  const opening = css.indexOf('{', start);
  const closing = css.indexOf('}', opening);
  return opening >= 0 && closing >= 0 ? css.slice(opening + 1, closing) : '';
}

function cssBlocks(css: string, selector: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const start = css.indexOf(selector, cursor);
    if (start < 0) break;
    const opening = css.indexOf('{', start);
    const closing = css.indexOf('}', opening);
    if (opening < 0 || closing < 0) break;
    blocks.push(css.slice(opening + 1, closing));
    cursor = closing + 1;
  }
  return blocks;
}

function declaration(block: string, name: string): string {
  return block.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:\\s*([^;]+);`, 'u'))?.[1]?.trim() ?? '';
}

function hex(value: string): Rgb {
  const match = value.match(/^#([0-9a-f]{6})$/iu);
  if (!match) throw new Error(`Expected a six-digit hex color, received ${value}`);
  return [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) as Rgb;
}

function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map((channel, index) => Math.round(
    channel * alpha + background[index]! * (1 - alpha),
  )) as Rgb;
}

function luminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(left: Rgb, right: Rgb): number {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('Personalization visual and accessibility contracts', () => {
  it('keeps dark error text above WCAG AA after translucent alert backgrounds are composited', () => {
    const theme = read('src/AcademicTheme.css');
    const dark = cssBlock(theme, '[data-theme="dark"]');
    const dangerAlias = declaration(dark, '--danger');
    expect(dangerAlias).toBe('var(--status-failed)');
    const danger = hex(declaration(dark, '--status-failed'));
    const card = hex(declaration(dark, '--bg-card'));

    const mcpSurface = composite(danger, card, 0.10);
    const fundingSurface = composite(danger, card, 0.09);
    expect(contrast(danger, mcpSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(danger, fundingSurface)).toBeGreaterThanOrEqual(4.5);

    const mcp = read('src/personalization/McpActivationPanel.css');
    const funding = read('src/personalization/FundingTemplatePanel.css');
    expect(cssBlocks(mcp, '.mcp-activation-panel__alert').some((block) => block.includes('var(--danger'))).toBe(true);
    expect(cssBlocks(funding, '.funding-template-panel__alert').some((block) => block.includes('var(--danger'))).toBe(true);
  });

  it('does not nest a second main landmark inside the application main landmark', () => {
    const app = read('src/App.tsx');
    const center = read('src/personalization/PersonalizationCenter.tsx');
    expect(app).toMatch(/<main\s+className=\{?`?main-content/);
    expect(center).not.toMatch(/<main(?:\s|>)/u);
    expect(center).toContain('<section');
    expect(center).toContain('className="personalization-detail personalization-detail--library"');
    expect(center).toContain("aria-label={zh ? '场景详情' : 'Scenario details'}");
  });

  it('prevents 200-character definition and workflow names from creating 400px/200%-zoom min-content overflow', () => {
    const css = read('src/personalization/PersonalizationCenter.css');
    expect(cssBlock(css, '.personalization-editor__header > div')).toContain('min-width: 0');
    expect(cssBlock(css, '.personalization-editor__header h2')).toContain('overflow-wrap: anywhere');
    expect(cssBlock(css, '.personalization-step__title strong')).toContain('min-width: 0');
    expect(cssBlock(css, '.personalization-step__title strong')).toContain('overflow-wrap: anywhere');
    expect(cssBlock(css, '.personalization-step__title button')).toContain('flex: 0 0 auto');
    const narrow = css.slice(css.indexOf('@media (max-width: 900px)'));
    expect(narrow).toMatch(/\.personalization-editor__header\s*\{[^}]*display:\s*grid/isu);
  });

  it('uses defined light/dark card shadows and system-color forced-focus selectors', () => {
    const theme = read('src/AcademicTheme.css');
    const light = cssBlock(theme, ':root');
    const dark = cssBlock(theme, '[data-theme="dark"]');
    expect(declaration(light, '--shadow-card')).not.toBe('');
    expect(declaration(dark, '--shadow-card')).not.toBe('');

    const center = read('src/personalization/PersonalizationCenter.css');
    const funding = read('src/personalization/FundingTemplatePanel.css');
    const mcp = read('src/personalization/McpActivationPanel.css');
    expect(center).not.toContain('var(--shadow-sm)');
    expect(funding).not.toContain('var(--shadow-sm)');
    expect(center).toContain('var(--shadow-card)');
    expect(funding).toContain('var(--shadow-card)');
    for (const css of [center, funding, mcp]) {
      expect(css).toContain('@media (forced-colors: active)');
      expect(css).toContain('Highlight');
    }
  });

  it('uses a compact workbench layout without the redundant page hero (pill accents are now part of the Apple visual language)', () => {
    const center = read('src/personalization/PersonalizationCenter.css');
    const shell = read('src/App.css');

    expect(center).not.toContain('radial-gradient');
    expect(center).not.toContain('.personalization-hero');
    expect(cssBlock(center, '.personalization-layout')).toContain('minmax(260px, 330px)');
    expect(cssBlock(center, '.personalization-layout')).toContain('minmax(640px, 1fr)');
    expect(cssBlock(center, '.personalization-editor')).toContain('980px');
    expect(center).toContain('@media (max-width: 1120px)');
    expect(cssBlock(center, '.personalization-page')).toContain('overflow-x: clip');

    expect(center).not.toContain('.personalization-trigger');
    expect(cssBlock(shell, '.topbar-nav__item.active')).toContain('var(--accent)');
    expect(cssBlock(shell, '.topbar-nav__item:focus-visible')).toContain('var(--focus-ring-color)');
  });

  it('keeps short bundle actions intrinsic on 400px and 650px layouts', () => {
    const center = read('src/personalization/PersonalizationCenter.css');
    const narrow = center.slice(center.indexOf('@media (max-width: 900px)'));
    expect(narrow).toMatch(/\.personalization-bundle-actions\s*\{[^}]*align-items:\s*flex-start/isu);
    expect(narrow).toMatch(/\.personalization-bundle-actions\s*\{[^}]*flex-direction:\s*row/isu);
    expect(narrow).toMatch(/\.personalization-bundle-actions\s*\{[^}]*flex-wrap:\s*wrap/isu);
    expect(narrow).not.toMatch(/\.personalization-bundle-actions\s*\{[^}]*align-items:\s*stretch/isu);
    expect(narrow).toMatch(/\.personalization-bundle-actions\s*>\s*span\s*\{[^}]*flex-basis:\s*100%/isu);
    expect(narrow).toMatch(/\.personalization-card__draft\s*\{[^}]*flex:\s*1\s+0\s+100%/isu);
    expect(narrow).toMatch(/\.personalization-card__draft\s*\{[^}]*margin-right:\s*0/isu);
    expect(narrow).toMatch(/\.personalization-package-picker\s*\{[^}]*flex-wrap:\s*wrap/isu);
    expect(narrow).toMatch(/\.personalization-package-picker\s+button\s*\{[^}]*white-space:\s*nowrap/isu);
    expect(narrow).toMatch(/\.personalization-package-picker\s+span\s*\{[^}]*flex:\s*1\s+0\s+100%/isu);
  });

  it('keeps top-bar controls named and decorative icons hidden from assistive technology', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('aria-label={t(item.labelKey)}');
    // O11: tooltips now use a descriptionKey-aware fallback, not a bare label repeat.
    expect(app).toContain('title={tooltip}');
    expect(app).toContain('data-testid="personalization-trigger"');
    expect(app).toContain('getPreferenceNav()');
    expect(app).toContain('lucide-react');
    expect(app).toContain('aria-hidden="true"');
    expect(app).toMatch(/className="topbar-icon-button"/);
  });

  it('exposes localized academic labels, draft feedback, and a visible focus target', () => {
    const source = read('src/personalization/PersonalizationCenter.tsx');
    const css = read('src/personalization/PersonalizationCenter.css');
    expect(source).not.toContain("zh ? '研究场景工作台' : 'RESEARCH SCENARIO WORKBENCH'");
    expect(source).toContain("zh ? '全权限运行' : 'Full Access'");
    expect(source).toContain("zh ? '草稿已自动保留' : 'Draft preserved automatically'");
    expect(source).toContain('ref={headingRef} tabIndex={-1}');
    expect(cssBlock(css, '.personalization-editor__header h2:focus-visible')).toContain('outline: 2px solid var(--focus-ring-color)');
    expect(cssBlock(css, '.personalization-draft-notice')).toContain('min-height: 18px');
  });
});
