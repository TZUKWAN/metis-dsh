/**
 * researchWorkspaceStore 结构化错误 → 用户文案映射（任务4 第四节）。
 *
 * store 的 error 形状是 {code, operation}（无文案），此前页面不消费等于吞错；
 * 这里统一给出"发生什么 / 影响什么 / 下一步"。
 */
import type { ResearchWorkspaceError } from './researchWorkspaceStore';

export interface WorkspaceErrorCopy {
  title: string;
  hint: string;
}

const TITLES: Record<ResearchWorkspaceError['operation'], string> = {
  load_projects: '科研项目列表加载失败。',
  load_snapshot: '当前项目详情刷新失败。',
  create_project: '项目创建未完成。',
  crud: '数据修改未完成。',
  link: '关联操作未完成。',
  review: '评审操作未完成。',
  restore: '恢复操作未完成。',
  version: '版本操作未完成。',
  checkpoint: '检查点操作未完成。',
  decision: '决策记录未完成。',
  attach_media: '图片附加未完成。',
  purge_media: '图片清理未完成。',
};

const CODE_HINTS: Record<ResearchWorkspaceError['code'], string> = {
  research_bridge_unavailable: '应用内部数据通道暂不可用（可能正在启动或重启）。',
  research_project_list_unavailable: '暂时读不到项目列表。',
  research_snapshot_unavailable: '暂时读不到项目详情。',
  research_mutation_unavailable: '数据写入通道暂不可用。',
  research_media_unavailable: '图片数据通道暂不可用。',
};

export function workspaceErrorCopy(error: ResearchWorkspaceError): WorkspaceErrorCopy {
  const title = TITLES[error.operation] ?? '操作未完成。';
  const hint = CODE_HINTS[error.code] ?? '数据通道暂时不可用。';
  return { title, hint };
}
