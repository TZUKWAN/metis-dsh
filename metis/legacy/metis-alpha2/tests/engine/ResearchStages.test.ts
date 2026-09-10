/**
 * ResearchStages — 科研阶段定义与导航（T5）。
 */

import { describe, expect, it } from 'vitest';
import {
  RESEARCH_STAGES,
  DEFAULT_STAGE,
  getStageDef,
  nextStage,
  prevStage,
  stageProgress,
} from '../../engine/research/ResearchStages.js';

describe('ResearchStages', () => {
  it('八个阶段按科研工作流排序', () => {
    expect(RESEARCH_STAGES.map((def) => def.id)).toEqual([
      'topic', 'literature', 'design', 'data', 'analysis', 'writing', 'submission', 'revision',
    ]);
  });

  it('未知/空阶段回退到默认阶段', () => {
    expect(getStageDef(null).id).toBe(DEFAULT_STAGE);
    expect(getStageDef('bogus').id).toBe('topic');
    expect(getStageDef('writing').id).toBe('writing');
  });

  it('next/prev 阶段导航在边界处收敛', () => {
    expect(nextStage('topic')).toBe('literature');
    expect(nextStage('revision')).toBe('revision');
    expect(prevStage('topic')).toBe('topic');
    expect(prevStage(null)).toBe('topic');
    expect(nextStage(null)).toBe('literature');
  });

  it('阶段进度单调递增且终值为 1', () => {
    expect(stageProgress('topic')).toBeCloseTo(1 / 8);
    expect(stageProgress('writing')).toBeCloseTo(6 / 8);
    expect(stageProgress('revision')).toBe(1);
    expect(stageProgress('unknown')).toBeCloseTo(1 / 8);
  });

  it('每个阶段的建议任务与产出 keys 非空且互不重复', () => {
    const allChecklist = RESEARCH_STAGES.flatMap((def) => def.checklistKeys);
    expect(new Set(allChecklist).size).toBe(allChecklist.length);
    for (const def of RESEARCH_STAGES) {
      expect(def.checklistKeys.length).toBeGreaterThanOrEqual(4);
      expect(def.outputsKey.length).toBeGreaterThan(0);
    }
  });
});
