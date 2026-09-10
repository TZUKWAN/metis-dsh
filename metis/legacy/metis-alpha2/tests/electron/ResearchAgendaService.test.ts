/**
 * ResearchAgendaService — 研究议程护栏（T24）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchAgendaService } from '../../electron/ResearchAgendaService.js';

let tmpDir: string;
let service: ResearchAgendaService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-agenda-'));
  service = new ResearchAgendaService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ResearchAgendaService', () => {
  it('入队去重与总量上限（8）', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(service.enqueue(`p-${index}`, `项目${index}`)).not.toHaveProperty('error');
    }
    expect(service.enqueue('p-extra', '超限项目')).toEqual({ error: 'queue_full' });
    expect(service.enqueue('p-0', '重复项目')).toEqual({ error: 'already_queued' });
    expect(service.getState().queue).toHaveLength(8);
  });

  it('maxRuns 钳制在 1-5（无效值回退默认）', () => {
    const entry = service.enqueue('p-clamp', '钳制', 99) as { maxRuns: number };
    expect(entry.maxRuns).toBe(5);
    // 0 为无效输入 → 回退默认 2。
    const low = service.enqueue('p-clamp2', '低钳制', 0) as { maxRuns: number };
    expect(low.maxRuns).toBe(2);
  });

  it('排序与移除', () => {
    service.enqueue('a', 'A');
    service.enqueue('b', 'B');
    expect(service.move('b', 'up')).toBe(true);
    expect(service.getState().queue.map((e) => e.projectId)).toEqual(['b', 'a']);
    expect(service.move('b', 'up')).toBe(false); // 已在队首
    expect(service.remove('a')).toBe(true);
    expect(service.getState().queue).toHaveLength(1);
  });

  it('达到每项目上限后自动移出', () => {
    service.enqueue('p-cap', '上限项目', 2);
    const first = service.reportCompletion('p-cap', true);
    expect(first.action).not.toBe('project_capped');
    const second = service.reportCompletion('p-cap', true);
    expect(second.action).toBe('project_capped');
    expect(second.note).toContain('上限');
    expect(service.getState().queue).toHaveLength(0);
  });

  it('冷却期内返回 cooldown，关闭自动接续返回 paused', () => {
    service.enqueue('p-cool', '冷却项目');
    const first = service.decideNext();
    expect(first.action).toBe('run_next');
    expect(first.projectId).toBe('p-cool');
    const second = service.decideNext();
    expect(second.action).toBe('cooldown');
    expect(typeof second.waitMs).toBe('number');

    service.setAutoContinue(false);
    expect(service.decideNext().action).toBe('paused');
  });

  it('失败上报不计入成功次数', () => {
    service.enqueue('p-fail', '失败项目', 1);
    const decision = service.reportCompletion('p-fail', false);
    // 失败不计次 → 未触顶，队列保留。
    expect(decision.action).not.toBe('project_capped');
    expect(service.getState().queue).toHaveLength(1);
  });

  it('状态持久化（重启恢复）', () => {
    service.enqueue('p-persist', '持久化项目', 3);
    service.reportCompletion('p-persist', true);
    const reloaded = new ResearchAgendaService(tmpDir);
    const entry = reloaded.getState().queue[0]!;
    expect(entry.projectId).toBe('p-persist');
    expect(entry.runsCompleted).toBe(1);
  });
});
