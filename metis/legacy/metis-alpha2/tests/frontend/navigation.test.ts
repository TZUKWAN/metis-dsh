/**
 * 任务4 第七节 —— typed navigation contract 测试。
 *
 * 契约：新代码一律 `navigate(intent)`（单一 metis:navigate 总线事件），
 * 旧 `metis:*` 字符串事件由 App 兼容层翻译；payload 运行时校验 fail-closed。
 */

import { describe, it, expect } from 'vitest';
import {
  decodeNavigationIntent,
  LEGACY_PAGE_ALIASES,
  navigate,
  NAVIGATE_EVENT,
  type NavigationIntent,
} from '../../src/shell/navigation';

describe('decodeNavigationIntent —— 运行时校验（fail-closed）', () => {
  it('接受合法 intent', () => {
    expect(decodeNavigationIntent({ kind: 'workspace', tab: 'materials' })).toEqual({ kind: 'workspace', tab: 'materials' });
    expect(decodeNavigationIntent({ kind: 'standalone', page: 'outcomes' })).toEqual({ kind: 'standalone', page: 'outcomes' });
    expect(decodeNavigationIntent({ kind: 'paper', paperId: 'p1', page: 3 })).toEqual({ kind: 'paper', paperId: 'p1', page: 3 });
    expect(decodeNavigationIntent({ kind: 'external-url', url: 'https://example.org' })).toEqual({ kind: 'external-url', url: 'https://example.org' });
  });

  it('拒绝未知 kind 与非法 payload', () => {
    expect(decodeNavigationIntent(null)).toBeNull();
    expect(decodeNavigationIntent('open')).toBeNull();
    expect(decodeNavigationIntent({ kind: 'teleport' })).toBeNull();
    expect(decodeNavigationIntent({ kind: 'standalone', page: 'autonomous' })).toBeNull();
    expect(decodeNavigationIntent({ kind: 'paper' })).toBeNull(); // 缺 paperId
    expect(decodeNavigationIntent({ kind: 'external-url', url: '' })).toBeNull();
  });
});

describe('LEGACY_PAGE_ALIASES —— 旧 Page id 兼容迁移表', () => {
  it('autonomous 深链迁移到 outcomes（已退出产品的自主研究页面不再复活）', () => {
    expect(LEGACY_PAGE_ALIASES.autonomous).toEqual({ kind: 'standalone', page: 'outcomes' });
  });

  it('chat/kanban/pdf 落到科研项目工作台对应模式页签', () => {
    expect(LEGACY_PAGE_ALIASES.chat).toEqual({ kind: 'workspace', tab: 'chat' });
    // 任务看板已退出产品（2026-09 刘总规格）：旧 kanban 深链落到聊天页签。
    expect(LEGACY_PAGE_ALIASES.kanban).toEqual({ kind: 'workspace', tab: 'chat' });
    expect(LEGACY_PAGE_ALIASES.pdf).toEqual({ kind: 'workspace', tab: 'materials' });
  });
});

describe('navigate() —— 单一总线事件', () => {
  it('派发 metis:navigate 且 detail 为合法 intent', () => {
    const dispatched: unknown[] = [];
    const listener = (event: Event) => { dispatched.push((event as CustomEvent).detail); };
    window.addEventListener(NAVIGATE_EVENT, listener);
    try {
      const intent: NavigationIntent = { kind: 'standalone', page: 'topics' };
      navigate(intent);
      expect(dispatched).toEqual([intent]);
      expect(decodeNavigationIntent(dispatched[0])).not.toBeNull();
    } finally {
      window.removeEventListener(NAVIGATE_EVENT, listener);
    }
  });
});
