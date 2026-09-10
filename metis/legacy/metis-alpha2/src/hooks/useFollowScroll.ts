/**
 * useFollowScroll — scroll-ledger follow behavior for the chat message flow,
 * adapted from deepseek-harness's ChatView (dsh, MIT).
 *
 * How the ledger works:
 *  - Every programmatic instant pin (`pinToBottom`) records the resulting
 *    `scrollTop` in `ledgerRef`.
 *  - In the passive scroll listener, an event whose `scrollTop` matches the
 *    ledger (±1px for rounding) is attributed to our own write and ignored;
 *    any other position is a USER gesture, which recomputes `atBottom` from
 *    the distance to the flow tip (`thresholdPx`).
 *  - Streaming growth pins with an instant `scrollTop = scrollHeight` write —
 *    never smooth scrolling, which would restart its animation on every frame
 *    and deviate from the ledger mid-flight. Smooth scrolling is reserved for
 *    the explicit user action in the caller ("return to latest"), which first
 *    re-engages the follow lock via `engageFollow`.
 *  - A ResizeObserver on the container re-pins when the viewport itself
 *    resizes (panel/layout changes) while the user is pinned.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Mirrors the historical CHAT_NEAR_BOTTOM_PX follow threshold in ChatPage. */
export const FOLLOW_THRESHOLD_PX = 72;

export interface UseFollowScrollOptions {
  containerRef: RefObject<HTMLElement | null>;
  /**
   * While this ref is false, scroll events are not attributed to the user.
   * ChatPage passes its historyReadyRef so history hydration (the viewport
   * sitting at the top of a growing list) never disengages the follow lock.
   */
  trackingReadyRef?: RefObject<boolean>;
  thresholdPx?: number;
}

export interface FollowScrollController {
  atBottom: boolean;
  atBottomRef: RefObject<boolean>;
  /** Instant programmatic pin used for streaming growth; ledger-recorded. */
  pinToBottom: () => void;
  /** Re-engage the follow lock (user clicked "return to latest"). */
  engageFollow: () => void;
}

export function useFollowScroll({
  containerRef,
  trackingReadyRef,
  thresholdPx = FOLLOW_THRESHOLD_PX,
}: UseFollowScrollOptions): FollowScrollController {
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const ledgerRef = useRef<number | null>(null);

  const setFollowing = useCallback((value: boolean) => {
    if (atBottomRef.current === value) return;
    atBottomRef.current = value;
    setAtBottom(value);
  }, []);

  const pinToBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    // Read back the clamped value so the ledger matches the scroll event the
    // browser is about to fire for this write.
    ledgerRef.current = element.scrollTop;
  }, [containerRef]);

  const engageFollow = useCallback(() => {
    setFollowing(true);
  }, [setFollowing]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleScroll = () => {
      if (trackingReadyRef && !trackingReadyRef.current) return;
      const ledger = ledgerRef.current;
      ledgerRef.current = null;
      // Our own programmatic write landing — not a user gesture.
      if (ledger !== null && Math.abs(element.scrollTop - ledger) <= 1) return;
      setFollowing(
        element.scrollHeight - element.scrollTop - element.clientHeight <= thresholdPx,
      );
    };
    handleScroll();
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [containerRef, trackingReadyRef, thresholdPx, setFollowing]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) pinToBottom();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, pinToBottom]);

  return { atBottom, atBottomRef, pinToBottom, engageFollow };
}
