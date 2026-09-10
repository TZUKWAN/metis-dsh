/**
 * Typed access to the computed AcademicTheme.css custom properties.
 *
 * AcademicTheme.css is the only source of theme values. This module contains
 * property names and a reader only, so the renderer and charts cannot drift
 * from the CSS cascade.
 */

export interface DesignTokens {
  bgMain: string;
  bgCard: string;
  bgSecondary: string;
  bgSidebar: string;
  bgInspector: string;
  textHeading: string;
  textBody: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;
  accentPrimary: string;
  accentHover: string;
  evidenceVerified: string;
  evidencePending: string;
  evidenceContested: string;
  evidenceStale: string;
  evidenceRefuted: string;
  chartPalette: string[];
  fontSans: string;
  fontSerif: string;
  fontMono: string;
  fontSizeSm: string;
  fontSizeBase: string;
  fontSizeLg: string;
  lineHeight: number;
  spaceXs: string;
  spaceSm: string;
  spaceMd: string;
  spaceLg: string;
  borderLight: string;
  radiusSm: string;
  radiusMd: string;
  radiusCard: string;
  focusRingColor: string;
  focusRingShadow: string;
}

interface DesignTokenPropertyMap {
  bgMain: string;
  bgCard: string;
  bgSecondary: string;
  bgSidebar: string;
  bgInspector: string;
  textHeading: string;
  textBody: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;
  accentPrimary: string;
  accentHover: string;
  evidenceVerified: string;
  evidencePending: string;
  evidenceContested: string;
  evidenceStale: string;
  evidenceRefuted: string;
  chartPalette: string[];
  fontSans: string;
  fontSerif: string;
  fontMono: string;
  fontSizeSm: string;
  fontSizeBase: string;
  fontSizeLg: string;
  lineHeight: string;
  spaceXs: string;
  spaceSm: string;
  spaceMd: string;
  spaceLg: string;
  borderLight: string;
  radiusSm: string;
  radiusMd: string;
  radiusCard: string;
  focusRingColor: string;
  focusRingShadow: string;
}

export const DESIGN_TOKEN_PROPERTIES: DesignTokenPropertyMap = {
  bgMain: '--bg-main',
  bgCard: '--bg-card',
  bgSecondary: '--bg-secondary',
  bgSidebar: '--bg-sidebar',
  bgInspector: '--bg-inspector',
  textHeading: '--text-heading',
  textBody: '--text-body',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  textOnAccent: '--text-on-accent',
  accentPrimary: '--accent',
  accentHover: '--accent-hover',
  evidenceVerified: '--evidence-verified',
  evidencePending: '--evidence-pending',
  evidenceContested: '--evidence-contested',
  evidenceStale: '--evidence-stale',
  evidenceRefuted: '--evidence-refuted',
  chartPalette: [
    '--chart-1',
    '--chart-2',
    '--chart-3',
    '--chart-4',
    '--chart-5',
    '--chart-6',
    '--chart-7',
    '--chart-8',
  ],
  fontSans: '--font-sans',
  fontSerif: '--font-serif',
  fontMono: '--font-mono',
  fontSizeSm: '--font-size-sm',
  fontSizeBase: '--font-size-base',
  fontSizeLg: '--font-size-lg',
  lineHeight: '--line-height',
  spaceXs: '--space-xs',
  spaceSm: '--space-sm',
  spaceMd: '--space-md',
  spaceLg: '--space-lg',
  borderLight: '--border-light',
  radiusSm: '--radius-sm',
  radiusMd: '--radius-md',
  radiusCard: '--radius-card',
  focusRingColor: '--focus-ring-color',
  focusRingShadow: '--focus-ring-shadow',
};

function readRequiredProperty(style: CSSStyleDeclaration, property: string): string {
  const value = style.getPropertyValue(property).trim();
  if (value.length === 0) {
    throw new Error(`Academic theme property is unavailable: ${property}`);
  }
  return value;
}

/** Read the active light/dark values after the CSS cascade has been applied. */
export function readComputedDesignTokens(root: HTMLElement = document.documentElement): DesignTokens {
  const view = root.ownerDocument.defaultView;
  if (view === null) {
    throw new Error('Academic theme requires a document browsing context');
  }
  const style = view.getComputedStyle(root);
  const read = (property: string) => readRequiredProperty(style, property);

  return {
    bgMain: read(DESIGN_TOKEN_PROPERTIES.bgMain),
    bgCard: read(DESIGN_TOKEN_PROPERTIES.bgCard),
    bgSecondary: read(DESIGN_TOKEN_PROPERTIES.bgSecondary),
    bgSidebar: read(DESIGN_TOKEN_PROPERTIES.bgSidebar),
    bgInspector: read(DESIGN_TOKEN_PROPERTIES.bgInspector),
    textHeading: read(DESIGN_TOKEN_PROPERTIES.textHeading),
    textBody: read(DESIGN_TOKEN_PROPERTIES.textBody),
    textSecondary: read(DESIGN_TOKEN_PROPERTIES.textSecondary),
    textMuted: read(DESIGN_TOKEN_PROPERTIES.textMuted),
    textOnAccent: read(DESIGN_TOKEN_PROPERTIES.textOnAccent),
    accentPrimary: read(DESIGN_TOKEN_PROPERTIES.accentPrimary),
    accentHover: read(DESIGN_TOKEN_PROPERTIES.accentHover),
    evidenceVerified: read(DESIGN_TOKEN_PROPERTIES.evidenceVerified),
    evidencePending: read(DESIGN_TOKEN_PROPERTIES.evidencePending),
    evidenceContested: read(DESIGN_TOKEN_PROPERTIES.evidenceContested),
    evidenceStale: read(DESIGN_TOKEN_PROPERTIES.evidenceStale),
    evidenceRefuted: read(DESIGN_TOKEN_PROPERTIES.evidenceRefuted),
    chartPalette: DESIGN_TOKEN_PROPERTIES.chartPalette.map(read),
    fontSans: read(DESIGN_TOKEN_PROPERTIES.fontSans),
    fontSerif: read(DESIGN_TOKEN_PROPERTIES.fontSerif),
    fontMono: read(DESIGN_TOKEN_PROPERTIES.fontMono),
    fontSizeSm: read(DESIGN_TOKEN_PROPERTIES.fontSizeSm),
    fontSizeBase: read(DESIGN_TOKEN_PROPERTIES.fontSizeBase),
    fontSizeLg: read(DESIGN_TOKEN_PROPERTIES.fontSizeLg),
    lineHeight: Number(read(DESIGN_TOKEN_PROPERTIES.lineHeight)),
    spaceXs: read(DESIGN_TOKEN_PROPERTIES.spaceXs),
    spaceSm: read(DESIGN_TOKEN_PROPERTIES.spaceSm),
    spaceMd: read(DESIGN_TOKEN_PROPERTIES.spaceMd),
    spaceLg: read(DESIGN_TOKEN_PROPERTIES.spaceLg),
    borderLight: read(DESIGN_TOKEN_PROPERTIES.borderLight),
    radiusSm: read(DESIGN_TOKEN_PROPERTIES.radiusSm),
    radiusMd: read(DESIGN_TOKEN_PROPERTIES.radiusMd),
    radiusCard: read(DESIGN_TOKEN_PROPERTIES.radiusCard),
    focusRingColor: read(DESIGN_TOKEN_PROPERTIES.focusRingColor),
    focusRingShadow: read(DESIGN_TOKEN_PROPERTIES.focusRingShadow),
  };
}
