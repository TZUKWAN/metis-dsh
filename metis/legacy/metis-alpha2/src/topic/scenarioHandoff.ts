import type { TopicResearchBrief } from '../../engine/runtime/TopicRuntimeContract.js';

/**
 * 选题 → 场景 typed handoff(2026-09-04 刘总要求,文档02第二十二节):
 * 用户体验上是「一键进入场景构建」,底层禁止 DOM 模拟输入
 * (querySelector/textarea.value/button.click),必须传完整结构化研究包。
 * 存储介质是 localStorage(临时跨页意图,非正式研究数据——正式 Brief
 * 由 TopicService 持久化在 SQLite)。
 */

const HANDOFF_KEY = 'metis:pendingScenarioHandoff';

export function setPendingScenarioHandoff(handoff: { title: string; brief: TopicResearchBrief }): void {
  try {
    window.localStorage.setItem(HANDOFF_KEY, JSON.stringify({
      title: handoff.title,
      instruction: [
        '请基于以下已经完成选题研究与论证的研究计划,构建一个完整、可执行的科研场景。',
        '',
        `【研究题目】${handoff.brief.title}`,
        `【核心研究问题】${handoff.brief.researchQuestion || '(沿用研究计划中的表述)'}`,
        `【用户最初意图】${handoff.brief.originalIntent || '(未记录)'}`,
        `【学科】${handoff.brief.discipline || '(未指定)'}`,
        `【目标成果】${handoff.brief.targetPublication.join('、') || '(未指定)'}`,
        `【研究背景与摘要】${handoff.brief.researchBackground || '(未记录)'}`,
        `【选题理由】${handoff.brief.rationale || '(未记录)'}`,
        handoff.brief.literatureLandscape ? `【已有研究版图】\n${handoff.brief.literatureLandscape.slice(0, 8000)}` : '',
        handoff.brief.mainResearchStreams.length ? `【主要研究路径】${handoff.brief.mainResearchStreams.join('、')}` : '',
        handoff.brief.majorDebates.length ? `【主要理论争议】${handoff.brief.majorDebates.join('、')}` : '',
        `【研究空间】${handoff.brief.researchGap || '(未记录)'}`,
        handoff.brief.closestStudies.length ? `【最接近研究】${handoff.brief.closestStudies.join(';')}` : '',
        handoff.brief.theoreticalAngles.length ? `【理论切口】${handoff.brief.theoreticalAngles.join('、')}` : '',
        handoff.brief.methodologySuggestions.length ? `【方法建议】${handoff.brief.methodologySuggestions.join('、')}` : '',
        handoff.brief.dataSuggestions.length ? `【数据条件】${handoff.brief.dataSuggestions.join('、')}` : '',
        handoff.brief.risks.length ? `【主要风险】${handoff.brief.risks.join(';')}` : '',
        '请充分继承以上已经确认的信息;除非发现重大可行性问题,不要擅自把研究主题改成另一项研究。请使用当前 Scenario Harness 完成:Deliverable(含每部分 purpose/instructions/requirements/lengthTarget 与总体成文要求)、Workflow(每步 Prompt/完成标准/Skill-MCP 绑定)、Workflow Prompt、Scenario Metis.md(只写研究行为规则)、Output Plan,并通过完整性检查。如果需要补充检索可以执行,但不要重新从零选题。',
      ].filter((line) => line !== '').join('\n'),
    }));
  } catch { /* localStorage 不可用时静默(功能降级,不阻断) */ }
}

export function consumePendingScenarioHandoff(): { title: string; instruction: string } | null {
  try {
    const raw = window.localStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(HANDOFF_KEY);
    const parsed = JSON.parse(raw) as { title?: string; instruction?: string };
    if (!parsed.instruction) return null;
    return { title: parsed.title ?? '', instruction: parsed.instruction };
  } catch {
    return null;
  }
}
