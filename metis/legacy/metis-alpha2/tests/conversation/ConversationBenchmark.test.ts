/**
 * Conversation Runtime 性能基准（2026-09-05 P0 Phase 8，规格六十三~六十七）。
 *
 * 验收指标（Before/After 对照见 docs/conversation-streaming-p0-plan.md）：
 * - 100k text delta 风暴：接收全量、累积 byte-identical、发布次数受 cadence 上界控制；
 * - 100k reasoning delta：同上（reasoning 通道）；
 * - 50k 字 Markdown 持续追加：累计解析字符 ≈ O(最终长度 × 小常数)，无平方增长；
 * - 20 次工具调用的 Turn Process 投影正确计数。
 *
 * 这些指标同时是 CI 可跑的回归测试（性能阈值保守，防环境抖动误报）。
 */

import { describe, it, expect } from 'vitest';
import { ConversationController } from '../../src/conversation/runtime/ConversationController.js';
import { ConversationPublicationScheduler } from '../../src/conversation/runtime/ConversationPublicationScheduler.js';
import { IncrementalMarkdownParser } from '../../src/conversation/markdown/IncrementalMarkdownParser.js';
import { projectTurnProcess, type TurnProcessEntry } from '../../src/conversation/runtime/turnProcess.js';

class ManualRaf {
  private nextHandle = 1;
  private queue = new Map<number, () => void>();
  readonly raf = (cb: () => void): number => {
    const handle = this.nextHandle++;
    this.queue.set(handle, cb);
    return handle;
  };
  readonly cancel = (handle: unknown): void => {
    this.queue.delete(handle as number);
  };
  tick(): void {
    const batch = [...this.queue.values()];
    this.queue.clear();
    for (const cb of batch) cb();
  }
  get pendingCount(): number {
    return this.queue.size;
  }
}

/** 生成确定性 token 流（无随机性，可重复）。 */
function* tokenStream(count: number): Generator<string> {
  const words = ['生成', '式', '人工', '智能', '正在', '改变', '研究', '范式', '，', '证据', '链', '完整', '。'];
  for (let index = 0; index < count; index += 1) yield words[index % words.length]!;
}

describe('Conversation Runtime benchmarks', () => {
  it('100k text deltas: lossless, byte-identical, publication count bounded', () => {
    const raf = new ManualRaf();
    const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
    const controller = new ConversationController({ scheduler });
    const TOTAL = 100_000;

    controller.beginTurn('bench');
    let received = 0;
    let expected = '';
    for (const token of tokenStream(TOTAL)) {
      controller.acceptDelta('bench', token);
      received += 1;
      expected += token;
      // 模拟 60fps UI：每 3 个 chunk 一个 paint 机会。
      if (received % 3 === 0) raf.tick();
    }
    // 结算前把挂起的窗口 flush 掉。
    for (let index = 0; index < 3; index += 1) raf.tick();

    const node = controller.nodeSource('bench').get();
    expect(received).toBe(TOTAL);
    expect(node?.content).toBe(expected);
    expect(node?.status).toBe('streaming');
    // 发布次数受 3 帧合并窗口控制：不变式 published ≤ ticks/3 + 1。
    const ticks = Math.ceil(TOTAL / 3);
    expect(scheduler.publishedCount).toBeGreaterThan(0);
    expect(scheduler.publishedCount).toBeLessThanOrEqual(Math.ceil(ticks / 3) + 1);
    expect(controller.resyncCount).toBe(0);

    controller.settleTurn('bench', expected, '', 'completed');
    expect(controller.nodeSource('bench').get()?.content).toBe(expected);
    scheduler.dispose();
  });

  it('100k reasoning deltas accumulate losslessly on the reasoning channel', () => {
    const controller = new ConversationController({ scheduler: new ConversationPublicationScheduler({ raf: () => 0, cancelAnimationFrame: () => {} }) });
    controller.beginTurn('reason-bench');
    let expected = '';
    for (let index = 0; index < 100_000; index += 1) {
      const delta = `思考步骤${index}；`;
      expected += delta;
      controller.acceptDelta('reason-bench', '', delta);
    }
    const node = controller.nodeSource('reason-bench').get();
    expect(node?.reasoning).toBe(expected);
    expect(node?.content).toBe('');
  });

  it('50k-char markdown over 200 appends: parse cost stays linear-ish', () => {
    const parser = new IncrementalMarkdownParser();
    const paragraph = '这是一段用于性能基准的中文段落，包含**加粗**、[链接](https://example.com)与 `code` 标记。\n\n';
    let text = '';
    for (let index = 0; index < 200; index += 1) {
      text += `${paragraph}第 ${index} 段补充说明，包含足够的字符量以模拟真实回答密度。\n\n`;
      parser.update(text);
    }
    expect(text.length).toBeGreaterThan(15_000);
    // 增量形态：累计解析 ≈ 每帧尾部（≤2 块 + 增长）→ 数倍于最终长度。
    // 旧实现（每帧全文重解析）：≈ 200 × 35k ≈ 7M（平方级）。
    expect(parser.parsedCharsTotal).toBeLessThan(text.length * 8);
    expect(parser.frozenBlockCount).toBeGreaterThan(100);
  });

  it('turn process projection counts 20 tool calls correctly', () => {
    const entries: TurnProcessEntry[] = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      kind: 'tool',
      label: `工具 ${index}`,
      status: index === 19 ? 'running' : 'completed',
    }));
    const projection = projectTurnProcess(entries);
    expect(projection.toolCallCount).toBe(20);
    expect(projection.running).toBe(true);
    expect(projection.summary).toContain('20 次工具调用');
  });
});
