import React from 'react';
import type {
  DeliverableSpec,
  PersonalizationDefinition,
  ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

export default function ScenarioStructuredConfig({
  zh,
  draft,
  mutateDraft,
  ensureDeliverable,
}: {
  zh: boolean;
  draft: ScenarioDefinition;
  definitions: PersonalizationDefinition[];
  mutateDraft(fn: (scenario: ScenarioDefinition) => void): void;
  ensureDeliverable(scenario: ScenarioDefinition): void;
}) {
  const setLines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);
  const dependencyIds = new Set(draft.workflow.flatMap((step) => step.dependsOn));
  const terminalSteps = draft.workflow.filter((step) => !dependencyIds.has(step.id));

  return (
    <div className="sw-config-form" data-testid="sw-structured-config">
      <section className="sw-config-section">
        <div className="sw-config-section__heading">
          <span className="sw-config-index">1</span>
          <div><h3>{zh ? '场景基本信息' : 'Scenario basics'}</h3><p>{zh ? '这组信息说明 Harness 解决什么问题、何时使用。' : 'Explain what this Harness solves and when it should be used.'}</p></div>
        </div>
        <div className="sw-config-grid">
          <label><span>{zh ? '场景名称' : 'Scenario name'}</span><input data-testid="sw-config-name" value={draft.name} onChange={(event) => mutateDraft((scenario) => { scenario.name = event.target.value; })} /></label>
          <label><span>{zh ? '能力类型' : 'Capability'}</span><select value={draft.capability} onChange={(event) => mutateDraft((scenario) => { scenario.capability = event.target.value as ScenarioDefinition['capability']; })}><option value="research">{zh ? '研究' : 'Research'}</option><option value="writing">{zh ? '写作' : 'Writing'}</option><option value="analysis">{zh ? '分析' : 'Analysis'}</option><option value="funding">{zh ? '申报' : 'Funding'}</option><option value="custom">{zh ? '自定义' : 'Custom'}</option></select></label>
          <label className="sw-config-grid__wide"><span>{zh ? '目标与适用边界' : 'Purpose and boundary'}</span><textarea rows={4} value={draft.description} placeholder={zh ? '例如：从可验证文献检索到完成一篇可投稿的实证论文；不用于纯理论研究。' : 'Describe the full objective and excluded uses.'} onChange={(event) => mutateDraft((scenario) => { scenario.description = event.target.value; })} data-testid="sw-scenario-description" /></label>
          <label><span>{zh ? '标签（每行一项）' : 'Tags (one per line)'}</span><textarea rows={3} value={draft.tags.join('\n')} onChange={(event) => mutateDraft((scenario) => { scenario.tags = setLines(event.target.value); })} /></label>
        </div>
      </section>

      <section className="sw-config-section">
        <div className="sw-config-section__heading">
          <span className="sw-config-index">2</span>
          <div><h3>{zh ? '成果蓝图摘要' : 'Deliverable blueprint summary'}</h3><p>{zh ? '详细结构、必选/可选/条件和逐节写作要求在下方成果蓝图区编辑。' : 'Edit structure status and section-level requirements in the blueprint section below.'}</p></div>
        </div>
        <div className="sw-config-grid sw-config-grid--three">
          <label><span>{zh ? '成果类型' : 'Deliverable type'}</span><select value={draft.deliverable?.type ?? 'custom'} onChange={(event) => mutateDraft((scenario) => { ensureDeliverable(scenario); scenario.deliverable!.type = event.target.value as DeliverableSpec['type']; })}><option value="custom">{zh ? '自定义成果' : 'Custom'}</option><option value="empirical_paper">{zh ? '实证论文' : 'Empirical paper'}</option><option value="theory_paper">{zh ? '理论论文' : 'Theory paper'}</option><option value="review_paper">{zh ? '综述论文' : 'Review paper'}</option><option value="grant_nssfc">{zh ? '国家社科基金' : 'Grant application'}</option><option value="policy_report">{zh ? '决策咨询报告' : 'Policy report'}</option></select></label>
          <label><span>{zh ? '总篇幅' : 'Length target'}</span><input value={draft.deliverable?.globalLength ?? ''} placeholder={zh ? '如 8000-12000 字' : 'e.g. 8k-12k words'} onChange={(event) => mutateDraft((scenario) => { ensureDeliverable(scenario); scenario.deliverable!.globalLength = event.target.value || undefined; })} data-testid="sw-config-length" /></label>
          <label><span>{zh ? '结构规模' : 'Structure size'}</span><input readOnly value={zh ? `${draft.deliverable?.sections?.length ?? 0} 个顶层部分` : `${draft.deliverable?.sections?.length ?? 0} top-level sections`} /></label>
        </div>
      </section>

      <section className="sw-config-section">
        <div className="sw-config-section__heading">
          <span className="sw-config-index">3</span>
          <div><h3>{zh ? '工作流摘要' : 'Workflow summary'}</h3><p>{zh ? 'Skill 和 MCP 都在具体步骤中绑定。' : 'Skills and MCPs are bound on individual steps.'}</p></div>
        </div>
        <div className="sw-config-result-summary"><strong>{zh ? `${draft.workflow.length} 个步骤` : `${draft.workflow.length} steps`}</strong><span>{draft.workflow.map((step) => step.name).join(' → ') || (zh ? '尚未配置' : 'Not configured')}</span></div>
        <div className="sw-config-result-summary"><strong>{zh ? '终止步骤' : 'Terminal step'}</strong><span>{terminalSteps.map((step) => step.name).join('、') || '—'}</span></div>
      </section>

      <section className="sw-config-section">
        <div className="sw-config-section__heading">
          <span className="sw-config-index">4</span>
          <div><h3>{zh ? 'Metis.md 继承与切换边界' : 'Metis.md inheritance and switching boundary'}</h3><p>{zh ? '运行时按 Global → Scenario → Project 叠加，越靠后的层级可细化前面的规则。' : 'Runtime layers Global → Scenario → Project; later scopes may refine earlier rules.'}</p></div>
        </div>
        <div className="sw-inheritance-flow"><span>Global Metis.md</span><b>→</b><span>Scenario Metis.md</span><b>→</b><span>Project Metis.md</span></div>
        <p className="sw-config-note">{zh ? '切换场景会替换 Harness 蓝图、写作风格、Scenario Metis.md、工作流及运行策略；项目已有文件、资料、对话和 Project Metis.md 保留。' : 'Switching scenarios replaces the Harness blueprint, style, Scenario Metis.md, workflow and runtime policies. Existing project files, sources, chats and Project Metis.md remain.'}</p>
      </section>
    </div>
  );
}
