import { useCallback, useEffect, useState } from 'react';
import { type ScenarioStepCardData } from '../components/ScenarioStepCard';
import type { ConversationTarget } from './types';

/**
 * Step 三操作语义（全局对话体验重构 T3 二期，文档三十四节）：
 * - 提出意见 = Target Context：Composer 出现「针对：步骤N ×」，消息携带结构化
 *   step 上下文进入对话，不直接变更 Step。
 * - 修改这步 = 基于现有输出+意见生成新 Revision：走 redo 分支（旧版保留），
 *   guidance 前缀「基于当前步骤结果修改：」。
 * - 重做 = 从该步输入重新执行：redo，guidance 可选；下游自动重置（既有机制）。
 *
 * 通过 CustomEvent 与 ChatPage 的 composer target 联动：
 *   metis:conversation-target {detail: ConversationTarget, mode: 'comment'|'modify'}
 */

export type StepTargetMode = 'comment' | 'modify';

export function stepTargetFromCard(card: ScenarioStepCardData): ConversationTarget {
  return {
    type: 'scenario_step',
    runId: card.runId,
    stepId: card.stepId,
    revision: card.iteration,
    title: card.stepName,
  };
}

/** Step 卡升级：三操作（提出意见/修改这步/重做）+ 既有跳过入口收进 ···。 */
export function useScenarioStepActions(onNotice?: (text: string) => void) {
  const [target, setTarget] = useState<ConversationTarget | null>(null);
  const [targetMode, setTargetMode] = useState<StepTargetMode>('comment');

  const openTarget = useCallback((card: ScenarioStepCardData, mode: StepTargetMode) => {
    setTarget(stepTargetFromCard(card));
    setTargetMode(mode);
  }, []);

  const clearTarget = useCallback(() => setTarget(null), []);

  const emitTarget = useCallback((card: ScenarioStepCardData, mode: StepTargetMode) => {
    window.dispatchEvent(new CustomEvent('metis:conversation-target', {
      detail: { target: stepTargetFromCard(card), mode },
    }));
  }, []);

  return { target, targetMode, openTarget, clearTarget, emitTarget };
}

/** ChatPage 侧：监听 Step 卡派发的 target 事件（composer 打开 Target Context）。 */
export function useStepTargetListener(onTarget: (target: ConversationTarget, mode: StepTargetMode) => void) {
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ target: ConversationTarget; mode?: StepTargetMode }>).detail;
      if (detail?.target) onTarget(detail.target, detail.mode ?? 'comment');
    };
    window.addEventListener('metis:conversation-target', handler);
    return () => window.removeEventListener('metis:conversation-target', handler);
  }, [onTarget]);
}

/** Target → 结构化上下文前缀（发送时注入 runtime，禁止裸字符串「针对步骤6」）。 */
export function formatTargetContext(target: ConversationTarget): string {
  if (target.type !== 'scenario_step') return '';
  return [
    '【对话目标（结构化上下文）】',
    `targetType: scenario_step`,
    `runId: ${target.runId}`,
    `stepId: ${target.stepId}`,
    ...(target.revision !== undefined ? [`stepRevision: ${target.revision}`] : []),
    ...(target.title ? [`stepTitle: ${target.title}`] : []),
  ].join('\n');
}
