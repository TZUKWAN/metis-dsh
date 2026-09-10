/**
 * 工作区状态保持（任务4 第十一节）：
 * 非 Office Workspace 统一考虑 panel width / collapse / selected item / tab /
 * 合理 scroll position —— 切走再回来不应全部重置。
 *
 * 宽度/折叠在 ProjectsPage 等处已有 localStorage 方案；这里补齐两类缺口：
 * - usePersistentScroll：滚动容器卸载前保存 scrollTop，重挂载时恢复；
 * - useStickyString：轻量"上次选中项"记忆（如成果树选中项）。
 */
import { useEffect, useRef, useState } from 'react';

/** 读取一个字符串型持久化值；不存在或读写失败返回 null。 */
export function readStickyValue(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * 持久化的单值字符串状态（如选中的成果 id）。
 * 返回 [value, setValue]；写入为 best-effort。
 */
export function useStickyString(key: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => readStickyValue(key));
  const set = (next: string | null) => {
    setValue(next);
    try {
      if (next === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, next);
    } catch {
      // 持久化失败不阻塞交互：仅退化为会话内记忆。
    }
  };
  return [value, set];
}

/**
 * 滚动位置保持。key（如 projectId）变化时：cleanup 先保存旧 key 的位置，
 * 新 effect 恢复新 key 的位置，互不串扰。
 */
export function usePersistentScroll<T extends HTMLElement>(storageKeyPrefix: string, key: string): { ref: React.RefObject<T | null> } {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const storageKey = `${storageKeyPrefix}:${key}`;
    const save = () => {
      try { window.localStorage.setItem(storageKey, String(Math.round(el.scrollTop))); } catch { /* best-effort */ }
    };
    // 恢复目标：localStorage（内存 map 方案在并发 key 切换下易串位，跨重启也无法覆盖）。
    let target: number | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) {
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) target = value;
      }
    } catch { /* best-effort */ }
    // 列表内容常在挂载后才异步撑高，scrollTop 可能一次设置不到位：
    // 内容高度增长时按目标位置重放，直到可达或重试次数耗尽。
    let lastScrollHeight = el.scrollHeight;
    let retries = 0;
    const applyRestoredPosition = (): boolean => {
      if (target === null) return true;
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) < 2) return true;
      if (el.scrollHeight === lastScrollHeight) {
        retries += 1;
        if (retries >= 3) return true;
      } else {
        retries = 0;
        lastScrollHeight = el.scrollHeight;
      }
      return false;
    };
    const settled = applyRestoredPosition();
    let observer: ResizeObserver | undefined;
    if (!settled && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        if (applyRestoredPosition()) observer?.disconnect();
      });
      observer.observe(el);
    }
    el.addEventListener('scroll', save, { passive: true });
    return () => {
      el.removeEventListener('scroll', save);
      observer?.disconnect();
      // 卸载前兜底保存（点击导航导致卸载时 scroll 事件可能不再触发）。
      try { window.localStorage.setItem(storageKey, String(Math.round(el.scrollTop))); } catch { /* best-effort */ }
    };
  }, [storageKeyPrefix, key]);

  return { ref };
}
