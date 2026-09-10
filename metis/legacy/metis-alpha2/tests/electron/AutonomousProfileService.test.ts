/**
 * AutonomousProfileService — 自主科研独立配置（自主改造 A）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousProfileService, AUTONOMOUS_HARD_RULES } from '../../electron/AutonomousProfileService.js';
import { ResearchAgendaService } from '../../electron/ResearchAgendaService.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-autoprofile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AutonomousProfileService', () => {
  it('默认配置：数量 3、注入画像、期刊论文+核心期刊', () => {
    const service = new AutonomousProfileService(tmpDir);
    const profile = service.getProfile();
    expect(profile.defaultBatchSize).toBe(3);
    expect(profile.injectUserProfile).toBe(true);
    expect(profile.constraints.outputForm).toBe('journal_article');
    expect(profile.constraints.journalTier).toBe('core');
    expect(profile.constraints.language).toBe('zh');
  });

  it('保存并持久化配置（重启恢复），数量钳制 1-5', () => {
    const service = new AutonomousProfileService(tmpDir);
    service.saveProfile({
      defaultPrompt: '基层治理系列研究',
      defaultBatchSize: 99,
      injectUserProfile: false,
      constraints: { methodPreference: 'qualitative', language: 'en', customRules: ['优先二手数据'] },
    });
    const reloaded = new AutonomousProfileService(tmpDir).getProfile();
    expect(reloaded.defaultPrompt).toBe('基层治理系列研究');
    expect(reloaded.defaultBatchSize).toBe(5); // 钳制
    expect(reloaded.injectUserProfile).toBe(false);
    expect(reloaded.constraints.methodPreference).toBe('qualitative');
    expect(reloaded.constraints.language).toBe('en');
    expect(reloaded.constraints.customRules).toEqual(['优先二手数据']);
  });

  it('buildContext：指令+约束+硬规则+画像的完整上下文', () => {
    const service = new AutonomousProfileService(tmpDir);
    service.saveProfile({ constraints: { fieldPreference: '社会学', customRules: ['每篇一个图表'] } });
    const context = service.buildContext({
      prompt: '做乡村振兴方向',
      memoryContext: '## Project Memory\n用户偏好制度分析',
      learningContext: 'B: 偏好稳健性检验',
    });
    expect(context).toContain('## 用户本次指令');
    expect(context).toContain('乡村振兴方向');
    expect(context).toContain('研究领域偏好：社会学');
    expect(context).toContain('用户自定义约束：每篇一个图表');
    expect(context).toContain('硬性约束');
    expect(context).toContain('禁止编造');
    expect(context).toContain('用户画像');
    expect(context).toContain('制度分析');
  });

  it('关闭画像注入后 buildContext 不含画像块', () => {
    const service = new AutonomousProfileService(tmpDir);
    service.saveProfile({ injectUserProfile: false });
    const context = service.buildContext({ prompt: 'x', memoryContext: '秘密画像' });
    expect(context).not.toContain('用户画像');
    expect(context).not.toContain('秘密画像');
  });

  it('硬规则四条且不可被自定义覆盖删除', () => {
    expect(AUTONOMOUS_HARD_RULES.length).toBeGreaterThanOrEqual(4);
    const service = new AutonomousProfileService(tmpDir);
    const context = service.buildContext({ prompt: '' });
    for (const rule of AUTONOMOUS_HARD_RULES) {
      expect(context).toContain(rule);
    }
  });
});

describe('议程自主条目批量入队（自主改造 B）', () => {
  it('批量入队自主条目（含 goalPrompt），与普通条目混排', () => {
    const agenda = new ResearchAgendaService(tmpDir);
    agenda.enqueue('existing-1', '既有项目');
    const added = agenda.enqueueAutonomousBatch([
      { key: 'auto-a', title: '选题一', goalPrompt: '## 用户本次指令\n做A\n## 本次选题\n题目：选题一' },
      { key: 'auto-b', title: '选题二', goalPrompt: '指令B' },
    ]);
    expect(added).toBe(2);
    const queue = agenda.getState().queue;
    expect(queue).toHaveLength(3);
    const autoEntries = queue.filter((entry) => entry.autonomous === true);
    expect(autoEntries).toHaveLength(2);
    expect(autoEntries[0]!.goalPrompt).toContain('选题一');
    expect(queue[0]!.autonomous).toBeUndefined(); // 普通条目不带自主标记
  });

  it('批量入队去重（重复 key 跳过）', () => {
    const agenda = new ResearchAgendaService(tmpDir);
    agenda.enqueueAutonomousBatch([{ key: 'auto-x', title: 'X', goalPrompt: 'g' }]);
    const again = agenda.enqueueAutonomousBatch([{ key: 'auto-x', title: 'X', goalPrompt: 'g' }]);
    expect(again).toBe(0);
    expect(agenda.getState().queue).toHaveLength(1);
  });

  it('decideNext 对自主条目返回 goalPrompt 与标题', () => {
    const agenda = new ResearchAgendaService(tmpDir);
    agenda.enqueueAutonomousBatch([{ key: 'auto-head', title: '队首选题', goalPrompt: '完整指令' }]);
    const decision = agenda.decideNext();
    expect(decision.action).toBe('run_next');
    expect(decision.autonomous).toBe(true);
    expect(decision.goalPrompt).toBe('完整指令');
    expect(decision.title).toBe('队首选题');
  });
});
