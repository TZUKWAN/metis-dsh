import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAYOUT_ACCEPTANCE_PREFIX = '--metis-layout-acceptance=';

export type LayoutAcceptanceMetadata =
  | { enabled: false }
  | {
      enabled: true;
      userDataPath: string;
      entryPath: string;
      tokenSha256: string;
    };

export interface LayoutAcceptanceWindowRequest {
  mode: 'outer' | 'content';
  width: number;
  height: number;
}

export interface LayoutAcceptanceSize {
  width: number;
  height: number;
}

function greatestLayoutAcceptanceDelta(
  requested: number,
  measurements: readonly number[],
): number {
  return measurements.reduce((greatestDelta, measured) => {
    const delta = requested - measured;
    return Math.abs(delta) > Math.abs(greatestDelta)
      ? delta
      : greatestDelta;
  }, 0);
}

export function nextLayoutAcceptanceContentSize(
  requested: LayoutAcceptanceSize,
  applied: LayoutAcceptanceSize,
  measuredContent: LayoutAcceptanceSize,
  measuredRenderer: LayoutAcceptanceSize,
): LayoutAcceptanceSize | null {
  const widthDelta = greatestLayoutAcceptanceDelta(
    requested.width,
    [measuredContent.width, measuredRenderer.width],
  );
  const heightDelta = greatestLayoutAcceptanceDelta(
    requested.height,
    [measuredContent.height, measuredRenderer.height],
  );
  if (Math.abs(widthDelta) <= 1 && Math.abs(heightDelta) <= 1) {
    return null;
  }

  return {
    width: Math.max(1, applied.width + (
      Math.abs(widthDelta) > 1 ? widthDelta : 0
    )),
    height: Math.max(1, applied.height + (
      Math.abs(heightDelta) > 1 ? heightDelta : 0
    )),
  };
}

export function extractLayoutAcceptanceToken(argv: readonly string[]): string | null {
  const argument = argv.find((value) => value.startsWith(LAYOUT_ACCEPTANCE_PREFIX));
  const token = argument?.slice(LAYOUT_ACCEPTANCE_PREFIX.length) ?? '';
  return token.length > 0 ? token : null;
}

export function createLayoutAcceptanceMetadata(
  token: string | null,
  userDataPath: string,
  entryPath: string,
): LayoutAcceptanceMetadata {
  if (!token) return { enabled: false };

  return {
    enabled: true,
    userDataPath,
    entryPath,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
  };
}

export function requireLayoutAcceptanceEnabled(
  token: string | null,
): asserts token is string {
  if (!token) {
    throw new Error('Layout acceptance is not enabled');
  }
}

export function isExpectedLayoutAcceptanceFrame(
  senderFrameUrl: string,
  expectedEntryPath: string,
): boolean {
  try {
    const parsed = new URL(senderFrameUrl);
    // Production builds serve the renderer over the custom metis-app:// scheme
    // (metis-app://renderer/index.html); acceptance must recognize it exactly
    // like the canonical file:// entry it replaces.
    if (parsed.protocol === 'metis-app:' && parsed.host === 'renderer' && parsed.pathname === '/index.html') {
      return true;
    }
    if (parsed.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(parsed)) === path.resolve(expectedEntryPath);
  } catch {
    return false;
  }
}

export function requireLayoutAcceptanceRequest(context: {
  token: string | null;
  controlEnabled: boolean;
  senderWindowMatches: boolean;
  senderFrameMatches: boolean;
  senderFrameUrl: string;
  expectedEntryPath: string;
}): void {
  requireLayoutAcceptanceEnabled(context.token);
  if (!context.controlEnabled) {
    throw new Error('Layout acceptance window control is no longer enabled');
  }
  if (!context.senderWindowMatches) {
    throw new Error('Layout acceptance request did not originate from the main window');
  }
  if (!context.senderFrameMatches) {
    throw new Error('Layout acceptance request did not originate from the main frame');
  }
  if (!isExpectedLayoutAcceptanceFrame(
    context.senderFrameUrl,
    context.expectedEntryPath,
  )) {
    throw new Error('Layout acceptance request did not originate from the current dist entry');
  }
}

export function parseLayoutAcceptanceWindowRequest(
  value: unknown,
): LayoutAcceptanceWindowRequest {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Window size request must be an object');
  }

  const request = value as Record<string, unknown>;
  if (request.mode !== 'outer' && request.mode !== 'content') {
    throw new TypeError('Window size mode must be outer or content');
  }
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height)) {
    throw new TypeError('Window dimensions must be integers');
  }

  const width = request.width as number;
  const height = request.height as number;
  if (width < 640 || width > 5120 || height < 480 || height > 2880) {
    throw new RangeError('Window dimensions are outside the acceptance safety range');
  }

  return { mode: request.mode, width, height };
}
