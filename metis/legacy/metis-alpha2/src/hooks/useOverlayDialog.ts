/**
 * useOverlayDialog — shared behavior for overlay dialogs (modals, panels).
 *
 * For a single mounted dialog it provides:
 *  - Escape closes the dialog via onClose; the event is consumed so
 *    underlying layers do not react to the same keystroke;
 *  - initial focus moves into the dialog (initialFocusRef if provided,
 *    otherwise the first focusable element, otherwise the container);
 *  - a simple focus trap: Tab / Shift+Tab cycle within the container and
 *    focus that escapes the container is pulled back in;
 *  - focus is restored to the previously focused element on unmount.
 */

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface UseOverlayDialogOptions {
  /** Called when the user presses Escape while the dialog is open. */
  onClose: () => void;
  /**
   * Optional ref to the element that should receive focus on mount
   * (e.g. the primary action button). Falls back to the first focusable
   * element inside the container.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export interface UseOverlayDialogResult<T extends HTMLElement> {
  /** Attach to the dialog root; focusable elements inside it are trapped. */
  containerRef: RefObject<T | null>;
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled'),
  );
}

export function useOverlayDialog<T extends HTMLElement = HTMLDivElement>(
  options: UseOverlayDialogOptions,
): UseOverlayDialogResult<T> {
  const { onClose, initialFocusRef } = options;
  const containerRef = useRef<T>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  // Latest-ref pattern: keep onClose fresh without resubscribing listeners.
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const container = containerRef.current;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Initial focus: explicit ref -> first focusable -> the container itself.
    const initialTarget =
      initialFocusRef?.current ??
      (container ? getFocusableElements(container)[0] : undefined) ??
      container;
    initialTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab' || !container) return;

      const focusables = getFocusableElements(container);
      const first = focusables[0];
      const last = focusables.length > 0 ? focusables[focusables.length - 1] : undefined;
      if (!first || !last) {
        // Nothing focusable inside: keep focus pinned on the container.
        event.preventDefault();
        container.focus();
        return;
      }

      const current = document.activeElement;
      const inside = current instanceof Node && container.contains(current);
      if (!inside) {
        // Focus escaped (or never entered): pull it back in.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const previous = previousFocusRef.current;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [initialFocusRef]);

  return { containerRef };
}
