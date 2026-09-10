/**
 * ResearchEvalSuite — 真实模型科研能力基准（T30）。
 *
 * 固定任务集 + 确定性规则评分：用当前配置的真实 provider 跑三个科研任务
 * （综述结构、编码建议、引用规范），按结构规则打分（不靠模型自评），
 * 结果写入 eval_runs 表供跨模型对比。评分维度留给 metadata.humanRubric，
 * 供人工复核补充。
 */

export interface EvalTask {
  id: string;
  name: string;
  prompt: string;
  /** 确定性评分规则。 */
  check: (answer: string) => { passed: boolean; score: number; notes: string[] };
}

export interface EvalTaskResult {
  taskId: string;
  passed: boolean;
  score: number;
  notes: string[];
  answerPreview: string;
}

export interface EvalSuiteResult {
  suiteName: string;
  taskCount: number;
  passedCount: number;
  successRate: number;
  results: EvalTaskResult[];
}

/** 任务一：综述结构 —— 必须输出编号条目且每条含"作者(年份)"式出处。 */
const reviewTask: EvalTask = {
  id: 'review-structure',
  name: '文献综述结构',
  prompt: '请针对"数字经济与县域治理"写一份 5 条文献综述提纲。要求：编号列出 5 条；每条格式为「主题句（作者, 年份）」；只输出提纲本身。',
  check: (answer) => {
    const notes: string[] = [];
    const numbered = answer.match(/^\s*\d+[.、)]/gmu) ?? [];
    if (numbered.length < 5) notes.push(`编号条目仅 ${numbered.length}/5`);
    const citations = (answer.match(/[（(][^（()]{1,24},\s*\d{4}[)）]/gu) ?? []).length;
    if (citations < 5) notes.push(`带出处的条目仅 ${citations}/5`);
    const boilerplate = /(作为一个|以下是|希望对您|As an AI)/iu.test(answer);
    if (boilerplate) notes.push('包含套话/ preamble');
    const lengthOk = answer.length >= 80 && answer.length <= 3000;
    if (!lengthOk) notes.push(`长度异常 ${answer.length}`);
    const score = Math.max(0, 1 - notes.length * 0.25);
    return { passed: notes.length === 0, score: Math.round(score * 100) / 100, notes };
  },
};

/** 任务二：编码建议 —— 必须给码名+定义+逐字摘录三要素。 */
const codingTask: EvalTask = {
  id: 'coding-suggestion',
  name: '扎根编码建议',
  prompt: '材料摘录：「村干部说：上面的资金到了镇里就被截留，我们村只能靠乡贤捐助修路。」请给出 1 个开放编码建议，格式：码名｜定义｜原文摘录。只输出这一行。',
  check: (answer) => {
    const notes: string[] = [];
    const parts = answer.split(/[｜|]/u).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) notes.push(`三要素仅 ${parts.length}/3（码名｜定义｜摘录）`);
    if (!answer.includes('乡贤') && !answer.includes('截留') && !answer.includes('资金')) notes.push('摘录未回贴原文关键词');
    const passed = notes.length === 0;
    return { passed, score: passed ? 1 : 0.5, notes };
  },
};

/** 任务三：退修意见处理 —— 必须逐条响应且不含编造数字。 */
const revisionTask: EvalTask = {
  id: 'revision-response',
  name: '审稿意见响应',
  prompt: '审稿意见：「表3 的样本量与正文不一致，请核对。」请写一条响应说明（不超过 80 字），说明将如何处理。不得编造具体数字。',
  check: (answer) => {
    const notes: string[] = [];
    if (answer.length > 200) notes.push('超出篇幅约束');
    const fabricates = /\d{3,}/.test(answer);
    if (fabricates) notes.push('响应中出现可能编造的大数字');
    if (!/核对|核对|检查|更正|修正|统一/.test(answer)) notes.push('未说明核对/修正动作');
    const passed = notes.length === 0;
    return { passed, score: passed ? 1 : 0.5, notes };
  },
};

export const RESEARCH_EVAL_TASKS: readonly EvalTask[] = [reviewTask, codingTask, revisionTask];

export const EVAL_HUMAN_RUBRIC = [
  '学术准确性：论断是否符合该领域共识',
  '文献真实性：所引作者/年份是否真实存在（抽查）',
  '深度：是否超越表层概括',
  '语言：学术文风是否成熟',
];

/** 对一组回答跑全部确定性评分。 */
export function scoreEvalAnswers(answers: Record<string, string>): EvalSuiteResult {
  const results: EvalTaskResult[] = RESEARCH_EVAL_TASKS.map((task) => {
    const answer = answers[task.id] ?? '';
    const verdict = task.check(answer);
    return {
      taskId: task.id,
      passed: verdict.passed,
      score: verdict.score,
      notes: verdict.notes,
      answerPreview: answer.slice(0, 200),
    };
  });
  const passedCount = results.filter((result) => result.passed).length;
  return {
    suiteName: 'research-capability/1',
    taskCount: results.length,
    passedCount,
    successRate: Math.round((passedCount / Math.max(1, results.length)) * 100) / 100,
    results,
  };
}
