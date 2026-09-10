/**
 * IncrementalMarkdownParser 回归测试（2026-09-05 P0 Phase 4）。
 * 验证：冻结推进、key 跨帧稳定、非 append 重置、以及规格六十七的性能不变式
 * ——累计解析字符数 ≈ O(最终长度 × 小常数)，不允许随帧数平方增长。
 */

import { describe, it, expect } from 'vitest';
import { IncrementalMarkdownParser } from '../../src/conversation/markdown/IncrementalMarkdownParser.js';

describe('IncrementalMarkdownParser', () => {
  it('freezes all but the last two blocks and only reparses the tail', () => {
    const parser = new IncrementalMarkdownParser();
    const text = ['Alpha paragraph.', 'Beta paragraph.', 'Gamma paragraph.', 'Delta paragraph.'].join('\n\n');
    const result = parser.update(text);

    expect(result.frozen).toHaveLength(2);
    expect(result.newlyFrozen).toHaveLength(2);
    expect(result.tail).toHaveLength(2);
    expect(text.slice(result.frozen[0]!.start, result.frozen[0]!.end)).toBe('Alpha paragraph.');
    expect(text.slice(result.tail[1]!.start, result.tail[1]!.end)).toBe('Delta paragraph.');
    expect(result.reset).toBe(false);
  });

  it('keeps block keys stable as blocks migrate from tail to frozen', () => {
    const parser = new IncrementalMarkdownParser();
    const base = 'First.\n\nSecond.\n\nThird.';
    const first = parser.update(base);
    const tailKeysBefore = first.tail.map((block) => block.key);
    expect(tailKeysBefore).toHaveLength(2);

    // 两帧后：Third 从 tail 跨入 frozen —— key 必须原样保留；Fifth 拿到新 key。
    const second = parser.update(`${base}\n\nFourth.`);
    const third = parser.update(`${base}\n\nFourth.\n\nFifth.`);

    const thirdKeyInFrozen = third.frozen.find((block) => block.key === tailKeysBefore[1]);
    expect(thirdKeyInFrozen).toBeDefined();
    // 冻结前沿每次只推进到倒数第二块：第二帧 Third 仍在 tail（4 块 → 冻结前 2 块），
    // 第三帧（5 块 → 冻结前 3 块）Third 跨入 frozen。
    expect(third.tail.map((block) => block.key)).not.toContain(tailKeysBefore[1]);
  });

  it('resets generation and cache on non-append input', () => {
    const parser = new IncrementalMarkdownParser();
    parser.update('Original.\n\nText.');
    const result = parser.update('Replaced.\n\nDifferent.');

    expect(result.reset).toBe(true);
    expect(result.generation).toBe(1);
    expect(result.frozen.every((block) => block.start < block.end)).toBe(true);
  });

  it('keeps an unclosed code fence in the tail until it closes', () => {
    const parser = new IncrementalMarkdownParser();
    parser.update('Intro.\n\n```js\nconst a = 1;');
    const result = parser.update('Intro.\n\n```js\nconst a = 1;\nconst b = 2;');

    const tailText = result.tail.map((block) => block).length;
    expect(tailText).toBeGreaterThan(0);
    // 未闭合 fence 必须仍是 tail 的一部分（不能被冻结成残缺块）。
    const lastFrozenEnd = result.frozen.length > 0 ? result.frozen[result.frozen.length - 1]!.end : 0;
    expect(lastFrozenEnd).toBeLessThan(6);
  });

  it('total parsed chars stay O(final length) — no quadratic growth over 200 appends', () => {
    const parser = new IncrementalMarkdownParser();
    const paragraph = 'This is a reasonably sized paragraph with several words in it.\n\n';
    let text = '';
    for (let index = 0; index < 200; index += 1) {
      text += `${paragraph}Paragraph number ${index} adds more context.\n\n`;
      parser.update(text);
    }
    // 若每帧全文重解析：200 帧 × ~70k 字符 ≈ 14M。增量形态应接近线性。
    expect(parser.parsedCharsTotal).toBeLessThan(text.length * 4);
    expect(parser.parsedCharsTotal).toBeGreaterThan(text.length / 4);
  });
});
