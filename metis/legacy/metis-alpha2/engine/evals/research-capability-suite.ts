/**
 * research-capability-suite — 科研能力评估任务集（T30）。
 *
 * 挂在现有 EvalRunner 框架上的三个科研任务：综述结构、扎根编码建议、
 * 审稿意见响应。requirements 用关键子串做近似门；更严格的确定性评分
 * 见 ../evals/ResearchEvalSuite.ts（scoreEvalAnswers），供未来 qualityGates 接入。
 */

import type { EvalTaskSpec } from './types.js';

export const RESEARCH_CAPABILITY_TASKS: EvalTaskSpec[] = [
  {
    id: 'review-structure',
    prompt: '请针对"数字经济与县域治理"写一份 5 条文献综述提纲。要求：编号列出 5 条；每条格式为「主题句（作者, 年份）」；只输出提纲本身。',
    maxTurns: 3,
    requirements: ['1.', '5.', '（', '）'],
  },
  {
    id: 'coding-suggestion',
    prompt: '材料摘录：「村干部说：上面的资金到了镇里就被截留，我们村只能靠乡贤捐助修路。」请给出 1 个开放编码建议，格式：码名｜定义｜原文摘录。只输出这一行。',
    maxTurns: 3,
    requirements: ['｜', '|', '摘录'],
  },
  {
    id: 'revision-response',
    prompt: '审稿意见：「表3 的样本量与正文不一致，请核对。」请写一条响应说明（不超过 80 字），说明将如何处理。不得编造具体数字。',
    maxTurns: 3,
    requirements: ['核对', '修正', '更正', '统一'],
  },
];
