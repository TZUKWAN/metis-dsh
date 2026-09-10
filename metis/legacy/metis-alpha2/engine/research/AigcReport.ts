/**
 * AigcReport — AI 参与度报告（T19）。
 *
 * 基于副作用账本与成果版本流生成"AI 参与度"结构化报告：AI 执行了哪些
 * 操作（检索/全文阅读/分析/写作）、各多少次、最近一次何时。对接期刊日益
 * 强制的 AIGC 使用声明 —— 这是现有账本架构白送的能力，确定性生成。
 */

export interface AigcOperationStat {
  operation: string;
  count: number;
  lastAt: number | null;
}

export interface AigcReport {
  projectId: string | null;
  artifactId: string | null;
  generatedAt: number;
  /** AI 执行的操作统计（来自副作用账本）。 */
  operations: AigcOperationStat[];
  totalOperations: number;
  /** 成果版本数（版本越多，AI 参与迭代越多）。 */
  artifactVersionCount: number | null;
  /** 人机分工摘要（规则拼接，中文）。 */
  summaryText: string;
}

/** 把账本操作归类为 AIGC 声明的常见条目。 */
const OPERATION_CATEGORIES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /search|list_sources|search_paper_text/i, label: '文献检索与全文查阅' },
  { pattern: /read_pdf|extract|file/i, label: '文件读取与全文抽取' },
  { pattern: /note_code|coding|claim|evidence/i, label: '编码与证据链登记' },
  { pattern: /stat|analy|verify|check/i, label: '分析与核查计算' },
  { pattern: /write|draft|artifact/i, label: '成果起草与迭代' },
];

function categorize(operation: string): string {
  for (const category of OPERATION_CATEGORIES) {
    if (category.pattern.test(operation)) return category.label;
  }
  return '其他辅助操作';
}

export function buildAigcReport(input: {
  projectId: string | null;
  artifactId: string | null;
  ledgerRows: Array<{ operation: string; committedAt: number }>;
  artifactVersionCount: number | null;
}): AigcReport {
  const byCategory = new Map<string, { count: number; lastAt: number }>();
  for (const row of input.ledgerRows) {
    const label = categorize(row.operation);
    const current = byCategory.get(label) ?? { count: 0, lastAt: 0 };
    current.count += 1;
    current.lastAt = Math.max(current.lastAt, row.committedAt);
    byCategory.set(label, current);
  }
  const operations: AigcOperationStat[] = [...byCategory.entries()]
    .map(([label, stat]) => ({ operation: label, count: stat.count, lastAt: stat.lastAt || null }))
    .sort((a, b) => b.count - a.count);
  const totalOperations = operations.reduce((sum, stat) => sum + stat.count, 0);

  const parts: string[] = [];
  parts.push(`本研究过程中，AI 辅助系统共执行 ${totalOperations} 次可审计操作`);
  if (operations.length > 0) {
    parts.push(`，包括：${operations.map((stat) => `${stat.operation} ${stat.count} 次`).join('、')}`);
  }
  if (input.artifactVersionCount !== null && input.artifactVersionCount > 0) {
    parts.push(`成果共产生 ${input.artifactVersionCount} 个版本记录`);
  }
  parts.push('以上操作全部来自本地副作用账本的真实记录，可逐条溯源；最终学术判断、结论取舍与文责由作者承担。');

  return {
    projectId: input.projectId,
    artifactId: input.artifactId,
    generatedAt: Date.now(),
    operations,
    totalOperations,
    artifactVersionCount: input.artifactVersionCount,
    summaryText: parts.join('') + '。',
  };
}
