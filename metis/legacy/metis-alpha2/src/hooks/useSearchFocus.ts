/**
 * useSearchFocus — register a global keyboard shortcut to focus a search input.
 *
 * Defaults to the `/` key. The shortcut is ignored when the user is already
 * typing inside an input, textarea or contenteditable element.
 */

import { useEffect, useRef } from 'react';

export function useSearchFocus<T extends HTMLElement>(key = '/') {
  const ref = useRef<T>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== key || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      ref.current?.focus();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [key]);

  return ref;
}
