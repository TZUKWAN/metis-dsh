import { requireExternalNavigationUrl } from '../engine/security/ExternalNavigation.js';

export interface ExternalOpenResult {
  success: boolean;
  error?: 'External link blocked' | 'External link could not be opened';
}

export function createSecureExternalOpenHandler<TEvent>(dependencies: {
  authorize: (event: TEvent) => void;
  openExternal: (url: string) => Promise<void>;
}) {
  return async (event: TEvent, rawUrl: unknown): Promise<ExternalOpenResult> => {
    let safeUrl: string;
    try {
      dependencies.authorize(event);
      safeUrl = requireExternalNavigationUrl(rawUrl);
    } catch {
      return { success: false, error: 'External link blocked' };
    }

    try {
      await dependencies.openExternal(safeUrl);
      return { success: true };
    } catch {
      return { success: false, error: 'External link could not be opened' };
    }
  };
}
