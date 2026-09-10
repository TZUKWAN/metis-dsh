/**
 * Four-scenario acceptance (METIS-1008) + clean-Windows install acceptance (METIS-1007) +
 * release-candidate full audit (METIS-1010).
 *
 * 1008: the four core HSS scenarios that prove the product positioning is real:
 *        1. literary/historical text research
 *        2. literature review
 *        3. interview/case qualitative research
 *        4. social-science quantitative / mixed research
 *      Each goes from a one-sentence need to an auditable artifact. Real execution needs a
 *      live API key + real materials — this is the protocol + checklist, never faked.
 * 1007: clean-Windows (no Node/Python/Git/TeX/R/Stata) install → configure API → run the four
 *      scenarios → restart/upgrade/uninstall. Requires a real VM + installer — protocol only.
 * 1010: the final cross-check of ALL tasks against this task list, evidence-by-evidence.
 */

// ─── METIS-1008 four-scenario acceptance ──────────────────────

export interface AcceptanceScenario {
  id: string;
  name: string;
  oneSentenceNeed: string;
  expectedFlow: string[];
  /** Evidence that must exist (artifact file + audit trail). */
  requiredEvidence: string[];
}

export const FOUR_ACCEPTANCE_SCENARIOS: readonly AcceptanceScenario[] = [
  {
    id: 'lit-history',
    name: '文学/历史文本研究',
    oneSentenceNeed: '细读《红楼梦》某回，分析其叙事结构并写一段论证。',
    expectedFlow: ['read 原文', 'analyze 主题/细读编码', 'write 论证段', 'verify 引用'],
    requiredEvidence: ['原文证据锚点', '编码记录', '文稿（引用已注册来源）', '核验报告'],
  },
  {
    id: 'lit-review',
    name: '文献综述',
    oneSentenceNeed: '综述近五年数字劳工研究。',
    expectedFlow: ['retrieve', 'screen', 'synthesize', 'verify citations'],
    requiredEvidence: ['检索式', '纳排标准', '候选集', '最终引用（可查）', '综述成果'],
  },
  {
    id: 'qual-interview',
    name: '访谈/案例质性研究',
    oneSentenceNeed: '对这批农民工访谈做主题编码并生成发现。',
    expectedFlow: ['import 逐字稿', 'code（人工+AI）', 'review AI 建议', 'write 发现'],
    requiredEvidence: ['编码本', 'AI vs 人工区分记录', '一致性检查', '发现成果'],
  },
  {
    id: 'quant-mixed',
    name: '社会科学定量/混合研究',
    oneSentenceNeed: '用 CGSS 数据估计教育对收入的回归并画图。',
    expectedFlow: ['import data', 'diagnose', 'estimate', 'chart', 'write results'],
    requiredEvidence: ['诊断报告', '代码', '结果+CI', '图表（含数据+spec+方法+来源）', '限制说明'],
  },
];

export interface ScenarioEvidence {
  scenarioId: string;
  evidencePresent: Record<string, boolean>;
}

/** A scenario passes only when ALL required evidence is present (METIS-1008). */
export function evaluateScenario(scenario: AcceptanceScenario, evidence: ScenarioEvidence): { passed: boolean; missing: string[] } {
  const missing = scenario.requiredEvidence.filter((req) => !evidence.evidencePresent[req]);
  return { passed: missing.length === 0, missing };
}

// ─── METIS-1007 clean-Windows acceptance ──────────────────────

export interface CleanWindowsStep {
  id: string;
  description: string;
  /** Required environment precondition (e.g. "no Node/Python/Git/TeX/R/Stata"). */
  precondition: string;
  requiredEvidence: string;
}

export const CLEAN_WINDOWS_STEPS: readonly CleanWindowsStep[] = [
  { id: 'cw-vm', description: '准备无 Node/Python/Git/TeX/R/Stata 的干净 Windows VM', precondition: 'VM 干净', requiredEvidence: 'VM 环境清单截图' },
  { id: 'cw-install-exe', description: '安装 EXE', precondition: '干净 VM', requiredEvidence: '安装日志 + 截图' },
  { id: 'cw-install-msi', description: '安装 MSI', precondition: '干净 VM', requiredEvidence: '安装日志 + 截图' },
  { id: 'cw-config-api', description: '配置 API（地址/Key/模型）', precondition: '应用启动', requiredEvidence: '配置截图（不外泄 Key）' },
  { id: 'cw-four-scenarios', description: '完成四类核心场景', precondition: 'API 可用', requiredEvidence: '四场景成果 + 审计轨迹' },
  { id: 'cw-restart', description: '重启后项目/成果可恢复', precondition: '已产出成果', requiredEvidence: '重启后截图' },
  { id: 'cw-upgrade', description: '升级跨版本', precondition: '旧版本已安装', requiredEvidence: '升级日志' },
  { id: 'cw-uninstall', description: '卸载不破坏用户项目数据', precondition: '已安装', requiredEvidence: '卸载后数据完好证据' },
];

/** Clean-Windows acceptance requires NO additional install or command-line beyond API config. */
export function validateCleanWindowsAcceptance(stepResults: Array<{ id: string; passed: boolean; extraInstallRequired: boolean; commandLineRequired: boolean }>): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const r of stepResults) {
    if (!r.passed) failures.push(`${r.id}: 步骤未通过`);
    if (r.extraInstallRequired) failures.push(`${r.id}: 要求了额外安装（违反 METIS-1007）`);
    if (r.commandLineRequired) failures.push(`${r.id}: 要求了命令行操作（违反 METIS-1007）`);
  }
  return { passed: failures.length === 0, failures };
}

// ─── METIS-1010 release-candidate full audit ──────────────────

export interface ReleaseCandidateAudit {
  /** Map of task id → evidence summary. */
  taskEvidence: Record<string, string>;
  /** Open risks remaining. */
  residualRisks: string[];
  /** Whether docs match the actual product. */
  docsMatchProduct: boolean;
  /** Whether any core acceptance was masked as "later optimization". */
  maskedAsOptimization: string[];
}

/** The final audit passes only when every task has evidence + no masked core failure. */
export function evaluateReleaseCandidate(audit: ReleaseCandidateAudit, requiredTaskIds: string[]): { passed: boolean; missing: string[]; issues: string[] } {
  const missing = requiredTaskIds.filter((id) => !audit.taskEvidence[id]);
  const issues: string[] = [];
  if (audit.residualRisks.length > 0) issues.push(`残余风险：${audit.residualRisks.length} 项`);
  if (!audit.docsMatchProduct) issues.push('文档与实际产品不一致');
  if (audit.maskedAsOptimization.length > 0) issues.push(`将核心验收伪装为"后续优化"：${audit.maskedAsOptimization.join(', ')}`);
  return { passed: missing.length === 0 && issues.length === 0, missing, issues };
}
