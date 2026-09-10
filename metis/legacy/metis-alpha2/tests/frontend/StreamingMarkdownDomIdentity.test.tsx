/**
 * DOM identity 验收测试（规格六十八，2026-09-05 P0 Phase 4）：
 * 第一段完成后继续流式生成第二段时，第一段对应的 DOM 节点必须
 * 保持 === sameNode —— 不被 remount。
 *
 * @vitest-environment jsdom
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamingMarkdown } from '../../src/presentation/StreamingMarkdown';

afterEach(() => {
  cleanup();
});

describe('StreamingMarkdown DOM identity', () => {
  it('keeps the settled first paragraph as the exact same DOM node across appends', () => {
    const initial = '第一段已经完成。\n\n第二段正在';
    const { container, rerender } = render(<StreamingMarkdown text={initial} streaming locale="zh" />);

    const firstParagraphBefore = container.querySelectorAll('p')[0];
    expect(firstParagraphBefore?.textContent).toContain('第一段已经完成。');

    rerender(<StreamingMarkdown text={`${initial}流式生长……`} streaming locale="zh" />);

    const firstParagraphAfter = container.querySelectorAll('p')[0];
    expect(firstParagraphAfter?.textContent).toContain('第一段已经完成。');
    expect(firstParagraphAfter).toBe(firstParagraphBefore);
  });

  it('does not remount any previously streamed paragraph after several appends', () => {
    let text = '段落 A 的内容。\n\n段落 B 的内容。';
    const { container, rerender } = render(<StreamingMarkdown text={text} streaming locale="zh" />);

    const snapshot = new Map<Element, string>();
    for (const p of container.querySelectorAll('p')) snapshot.set(p, p.textContent ?? '');

    for (let index = 0; index < 5; index += 1) {
      text += `\n\n追加段落 ${index} 的内容。`;
      rerender(<StreamingMarkdown text={text} streaming locale="zh" />);
    }

    for (const [node, expected] of snapshot) {
      expect(node.isConnected).toBe(true);
      expect(node.textContent).toBe(expected);
    }
  });
});
