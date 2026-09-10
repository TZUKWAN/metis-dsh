/**
 * StageDetector — AI 阶段自动判定（批3）。
 *
 * 阶段不再由用户手选：基于项目真实进展（文献/任务/成果/编码/研究问题）
 * 的确定性规则判定，输出阶段与可解释依据。规则引擎零模型调用。
 */

import type { ResearchStageId } from './ResearchStages.js';

export interface StageDetectionInput {
  paperCount: number;
  /** 有 PDF 全文的文献数。 */
  paperWithPdfCount: number;
  completedTasks: number;
  openTasks: number;
  artifactCount: number;
  noteCodeCount: number;
  transcriptCount: number;
  researchQuestionFilled: boolean;
  lastRunStatus: string | null;
  submissionCount: number;
}

export interface StageDetectionResult {
  stage: ResearchStageId;
  rationale: string[];
}

export function detectStage(input: StageDetectionInput): StageDetectionResult {
  const rationale: string[] = [];
  const hasMaterials = input.paperCount > 0;
  const hasFullText = input.paperWithPdfCount > 0;
  const hasAnalysis = input.noteCodeCount >= 5 || input.transcriptCount > 0 || input.lastRunStatus === 'completed';
  const hasResults = input.artifactCount > 0;
  const hasSubmissions = input.submissionCount > 0;
  const taskRatio = input.completedTasks + input.openTasks > 0
    ? input.completedTasks / (input.completedTasks + input.openTasks)
    : 0;

  if (hasSubmissions) {
    rationale.push(`已有 ${input.submissionCount} 次投稿记录`);
    if (hasResults) rationale.push(`成果 ${input.artifactCount} 个`);
    return { stage: 'revision', rationale: [...rationale, '进入投稿与修订阶段'] };
  }

  if (hasResults && input.artifactCount >= 2) {
    rationale.push(`成果 ${input.artifactCount} 个`);
    return { stage: 'writing', rationale: [...rationale, '多个成果产出中，处于写作阶段'] };
  }

  if (hasAnalysis) {
    rationale.push(`编码 ${input.noteCodeCount} 条` + (input.transcriptCount > 0 ? `、转写稿 ${input.transcriptCount} 篇` : ''));
    if (input.lastRunStatus === 'completed') rationale.push('自主科研已完成一轮');
    return { stage: 'analysis', rationale: [...rationale, '分析工作已展开，处于分析阶段'] };
  }

  if (hasFullText) {
    rationale.push(`${input.paperWithPdfCount} 篇文献已有全文`);
    return { stage: 'design', rationale: [...rationale, '文献可读且任务推进中，处于设计阶段'] };
  }

  if (hasMaterials) {
    rationale.push(`文献 ${input.paperCount} 篇` + (input.researchQuestionFilled ? '、研究问题已明确' : '、研究问题待明确'));
    if (input.researchQuestionFilled && taskRatio > 0.5) {
      return { stage: 'design', rationale: [...rationale, '研究问题明确且任务推进过半，进入设计阶段'] };
    }
    return { stage: 'literature', rationale: [...rationale, '文献收集进行中，处于文献阶段'] };
  }

  rationale.push('尚无文献与成果');
  return { stage: 'topic', rationale: [...rationale, '处于选题阶段：先检索导入核心文献'] };
}
