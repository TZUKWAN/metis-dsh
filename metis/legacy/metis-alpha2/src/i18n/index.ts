/**
 * Lightweight i18n system for Metis Research Workbench.
 *
 * No external dependencies. Uses Zustand store for reactive locale switching.
 * Provides useTranslation() hook with t() function for string lookup.
 * Supports interpolation via {key} placeholders.
 */

import { useMemo, useCallback } from 'react';
import { useMetisStore } from '../store';
import en from './locales/en.js';
import zh from './locales/zh.js';
import type { Locale } from './locales/en.js';

// ─── Locale Registry ────────────────────────────────────────

export type LocaleKey = 'en' | 'zh';

const LOCALES: Record<LocaleKey, Locale> = { en, zh };

export const LOCALE_LABELS: Record<LocaleKey, string> = {
  en: 'English',
  zh: '中文',
};

// ─── Interpolation ──────────────────────────────────────────

/**
 * Replace {key} placeholders in a string with values from params.
 * Example: interpolate('{count} papers', { count: 5 }) → '5 papers'
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return result;
}

// ─── Deep Path Resolver ─────────────────────────────────────

/**
 * Resolve a dot-separated path like 'nav.dashboard' from a locale object.
 * Returns the string value or undefined if path not found.
 */
function resolvePath(locale: Locale, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = locale;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

// ─── Translation Function ───────────────────────────────────

export interface TranslateFn {
  (key: string, params?: Record<string, string | number>): string;
}

/**
 * Create a translation function for a given locale key.
 */
function createTranslator(localeKey: LocaleKey): TranslateFn {
  const locale = LOCALES[localeKey];
  return (key: string, params?: Record<string, string | number>): string => {
    const value = resolvePath(locale, key);
    if (value !== undefined) {
      return interpolate(value, params);
    }
    // Fallback to English if key not found in current locale
    if (localeKey !== 'en') {
      const fallback = resolvePath(LOCALES.en, key);
      if (fallback !== undefined) {
        return interpolate(fallback, params);
      }
    }
    // Last resort: return the key itself
    return key;
  };
}

// ─── React Hook ─────────────────────────────────────────────

/**
 * Hook that provides the translation function and current locale info.
 * Re-creates the translator when locale changes (reactive via Zustand).
 */
export function useTranslation(): {
  t: TranslateFn;
  locale: LocaleKey;
  setLocale: (key: LocaleKey) => void;
  localeLabel: string;
} {
  const { locale, setLocale } = useMetisStore();

  const t = useCallback<TranslateFn>(
    (key: string, params?: Record<string, string | number>) => {
      return createTranslator(locale)(key, params);
    },
    [locale],
  );

  const localeLabel = LOCALE_LABELS[locale] ?? locale;

  return useMemo(() => ({ t, locale, setLocale, localeLabel }), [t, locale, setLocale, localeLabel]);
}
