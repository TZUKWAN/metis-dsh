/**
 * 选刊条件契约（从 legacy SubmissionRuntimeContract.ts 提取的子集，
 * 保持与 submission-contract.ts 的语义一致）。
 */

export const SUBMISSION_VENUE_CATEGORIES = [
  'conference', // 会议
  'sci', // SCI
  'ssci', // SSCI
  'cssci', // CSSCI
  'cscd', // CSCD
  'pku_core', // 北大核心
  'cn_general', // 中文普刊
  'en_general', // 英文普刊
  'other_journal', // 普刊
  'unknown', // 无法核验
] as const;

export const SUBMISSION_TARGETING_LANGUAGES = ['zh', 'en', 'any'] as const;

export type SubmissionVenueCategory = (typeof SUBMISSION_VENUE_CATEGORIES)[number];
export type SubmissionTargetingLanguage = (typeof SUBMISSION_TARGETING_LANGUAGES)[number];

export interface TargetingCriteria {
  categories: SubmissionVenueCategory[]
  language: SubmissionTargetingLanguage
  notes: string
}
