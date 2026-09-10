/**
 * ResearchStages — 科研工作流阶段定义（T5）。
 *
 * 八个研究阶段覆盖人文社科科研全过程；每个阶段带建议任务清单
 * （一键生成项目任务）与应产出产物。阶段存储于 project.metadata.stage，
 * 与既有 ResearchLifecycle（执行状态机）正交：lifecycle 管"计划执行到哪"，
 * stage 管"研究本身进行到哪一步"。
 */

export type ResearchStageId =
  | 'topic'
  | 'literature'
  | 'design'
  | 'data'
  | 'analysis'
  | 'writing'
  | 'submission'
  | 'revision';

export interface ResearchStageDef {
  id: ResearchStageId;
  /** i18n key 前缀：projects.stage_topic.label / checklist 等。 */
  key: string;
  /** 建议任务（生成项目任务用，确定性文案，不走模型）。 */
  checklistKeys: string[];
  /** 该阶段应产出的产物描述 key。 */
  outputsKey: string;
}

export const RESEARCH_STAGES: readonly ResearchStageDef[] = [
  {
    id: 'topic',
    key: 'topic',
    checklistKeys: ['interest', 'gap', 'question', 'feasibility'],
    outputsKey: 'outputsTopic',
  },
  {
    id: 'literature',
    key: 'literature',
    checklistKeys: ['search', 'import', 'review', 'matrix'],
    outputsKey: 'outputsLiterature',
  },
  {
    id: 'design',
    key: 'design',
    checklistKeys: ['hypothesis', 'variables', 'method', 'dataPlan'],
    outputsKey: 'outputsDesign',
  },
  {
    id: 'data',
    key: 'data',
    checklistKeys: ['collect', 'clean', 'consent', 'inventory'],
    outputsKey: 'outputsData',
  },
  {
    id: 'analysis',
    key: 'analysis',
    checklistKeys: ['describe', 'model', 'robustness', 'coding'],
    outputsKey: 'outputsAnalysis',
  },
  {
    id: 'writing',
    key: 'writing',
    checklistKeys: ['outline', 'sections', 'citations', 'abstract'],
    outputsKey: 'outputsWriting',
  },
  {
    id: 'submission',
    key: 'submission',
    checklistKeys: ['format', 'journal', 'cover', 'submit'],
    outputsKey: 'outputsSubmission',
  },
  {
    id: 'revision',
    key: 'revision',
    checklistKeys: ['reviewComments', 'revise', 'response', 'resubmit'],
    outputsKey: 'outputsRevision',
  },
];

export const DEFAULT_STAGE: ResearchStageId = 'topic';

export function getStageDef(stage: string | undefined | null): ResearchStageDef {
  return RESEARCH_STAGES.find((def) => def.id === stage) ?? RESEARCH_STAGES[0]!;
}

export function nextStage(stage: string | undefined | null): ResearchStageId {
  const index = RESEARCH_STAGES.findIndex((def) => def.id === stage || (stage == null && def.id === DEFAULT_STAGE));
  if (index < 0 || index >= RESEARCH_STAGES.length - 1) return RESEARCH_STAGES[RESEARCH_STAGES.length - 1]!.id;
  return RESEARCH_STAGES[index + 1]!.id;
}

export function prevStage(stage: string | undefined | null): ResearchStageId {
  const index = RESEARCH_STAGES.findIndex((def) => def.id === stage);
  if (index <= 0) return RESEARCH_STAGES[0]!.id;
  return RESEARCH_STAGES[index - 1]!.id;
}

/** 阶段进度（0-1）：当前阶段序号 / 总数（用于主页进度条）。 */
export function stageProgress(stage: string | undefined | null): number {
  const index = RESEARCH_STAGES.findIndex((def) => def.id === stage);
  const safeIndex = index >= 0 ? index : 0;
  return (safeIndex + 1) / RESEARCH_STAGES.length;
}
