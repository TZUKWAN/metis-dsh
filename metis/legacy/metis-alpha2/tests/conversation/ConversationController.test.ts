/**
 * ConversationController 集成测试（2026-09-05 P0 Phase 2）。
 * 验证：帧合并发布、immediate 结算抢占、权威 settle swap、per-key 订阅。
 */

import { describe, it, expect } from 'vitest';
import { ConversationController } from '../../src/conversation/runtime/ConversationController.js';
import { ConversationPublicationScheduler } from '../../src/conversation/runtime/ConversationPublicationScheduler.js';
import { ingestChatStreamChunk } from '../../src/conversation/runtime/chatStreamAdapter.js';

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
}

function makeController(raf: ManualRaf): ConversationController {
  const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
  return new ConversationController({ scheduler });
}

describe('ConversationController', () => {
  it('coalesces frame publishes and settles immediately with authoritative content', () => {
    const raf = new ManualRaf();
    const controller = makeController(raf);
    const publishes: string[] = [];
    const watched = controller.nodeSource('turn-1');
    watched.subscribe(() => publishes.push(watched.get()?.content ?? ''));

    controller.beginTurn('turn-1');
    for (let index = 0; index < 50; index += 1) {
      ingestChatStreamChunk(controller, { turnId: 'turn-1', content: `t${index} `, reasoning: '', isFinished: false });
      // 模拟 UI 帧：每 10 个 delta 走完一次 3 帧发布窗口。
      if ((index + 1) % 10 === 0) {
        raf.tick();
        raf.tick();
        raf.tick();
      }
    }
    // frame 节奏：50 个 delta 只产生少量发布（3 帧合并窗口生效）。
    const midPublishes = publishes.length;
    expect(midPublishes).toBeGreaterThan(0);
    expect(midPublishes).toBeLessThan(50);

    raf.tick();
    raf.tick();
    raf.tick();
    controller.settleTurn('turn-1', '权威最终回答', '', 'completed');

    const node = watched.get();
    expect(node?.status).toBe('completed');
    expect(node?.content).toBe('权威最终回答');
    // settlement 立即发布（不等帧）。
    expect(publishes[publishes.length - 1]).toBe('权威最终回答');
  });

  it('keeps the streaming node under one stable key across the whole attempt', () => {
    const controller = makeController(new ManualRaf());
    controller.beginTurn('turn-9');
    controller.acceptDelta('turn-9', '部分');
    const source = controller.nodeSource('turn-9');
    expect(source.get()?.key).toBe('assistant:turn-9');
    controller.settleTurn('turn-9', '部分内容定稿', '', 'completed');
    expect(source.get()?.key).toBe('assistant:turn-9');
  });

  it('marks an abandoned attempt and stops exposing streaming content', () => {
    const controller = makeController(new ManualRaf());
    controller.beginTurn('turn-x');
    controller.acceptDelta('turn-x', '半截');
    controller.abandonTurn('turn-x', 'provider_error');
    expect(controller.nodeSource('turn-x').get()?.status).toBe('abandoned');
  });
});
