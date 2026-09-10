import { randomUUID } from 'node:crypto';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { OutcomeDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import { runEphemeralChatTurn } from './ChatTurnService.js';
import type { SubmissionBrowserFacade } from './SubmissionBrowserTools.js';

/**
 * 投稿参谋（Submission Workspace copilot）。
 *
 * 编排型 agent：上下文 = 当前成果（ArtifactContext） + 当前浏览器页面（BrowserContext）
 * + 用户投稿意向（Intent）；工具 = 期刊目录检索（LetPub/万维，已在 engine 注册）
 * + 共享浏览器控制（main 层注册，操作的就是用户中栏看到的同一个 WebContentsView）。
 *
 * 输出 Markdown，可嵌入围栏块（前端 SafeMarkdown codeComponent 拦截渲染）：
 *   ```metis-choice-group```     结构化追问（渠道偏好等，点选回传）
 *   ```metis-journal-card```     候选期刊卡（在浏览器打开 / 收藏）
 *   ```metis-submission-card```  "就投这个"确认卡（创建正式投稿记录）
 */

export interface SubmissionAssistantRequest {
  projectId: string;
  outcomeId: string;
  instruction: string;
  /** 思考强度（fast/standard/deep）：provider 无原生推理参数，以提示词级注入。 */
  thinkingLevel?: string;
  intent?: Record<string, unknown>;
  shortlist?: Array<{ name: string; source?: string }>;
  /** 任务6(2026-09-05):最近对话(最多16条),让参谋具备连续会话记忆。 */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface SubmissionAssistantResult {
  ok: boolean;
  answer: string;
  error?: string;
}

const SUBMISSION_ASSISTANT_TOOLS = [
  'journal_directory_search',
  'journal_directory_detail',
  'submission_browser_read_page',
  'submission_browser_navigate',
];

const OUTCOME_TEXT_CHARS = 9_000;
const BROWSER_TEXT_CHARS = 6_000;

/**
 * 失败原因如实化（2026-09-08 用户反馈「只显示 (error) 无法定位」）：
 * ChatTurnService 的诊断里已带真实原因（provider 错误体/中断信息），
 * 这里翻译成用户可执行的中文结论，绝不笼统报错。
 */
function describeAdvisorFailure(status: string, detail: string): string {
  const lower = detail.toLowerCase();
  if (/api key|unauthorized|authentication|401|403/.test(lower)) {
    return '模型连接未通过验证（API Key 缺失或已失效），请到「设置 → 模型连接」检查配置';
  }
  if (/provider|timeout|timed out|network|fetch|econn|socket|dns/.test(lower)) {
    return '模型连接失败（网络不可达或服务无响应），请检查网络与「设置 → 模型连接」';
  }
  if (status === 'error' && !detail) return '模型未返回有效回答（可能回合数耗尽或回答未通过校验）';
  return detail ? detail.slice(0, 300) : '未知原因';
}

function outcomeToText(content: OutcomeDocument): string {
  if (content.type === 'word') {
    return (content.blocks ?? []).map((block: { kind?: string; level?: number; text?: string; rows?: string[][] }) => {
      if (block.kind === 'heading') return `\n${'#'.repeat(Math.min(4, block.level ?? 1))} ${block.text ?? ''}`;
      if (block.kind === 'paragraph') return block.text ?? '';
      if (block.kind === 'table') return (block.rows ?? []).map((row) => row.join(' | ')).join('\n');
      return '';
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content).slice(0, OUTCOME_TEXT_CHARS);
}

function systemPrompt(input: { outcomeSummary: string; browserContext: string; intentText: string; shortlistText: string }): string {
  return [
    '你是 METIS 投稿参谋，和用户一起围绕真实学术网页完成：找刊 → 浏览 → 评估 → 确定期刊 → 投稿准备。',
    '用户始终能看到浏览器（你们共享同一个浏览器视图），并且你拥有当前成果全文。不要让用户重复提供已有信息，不要要求用户上传论文。',
    '',
    '== 回合纪律 ==',
    '1. 回答"这个期刊怎么样 / 适不适合我"之前，必须先调用 submission_browser_read_page 读取当前页面。',
    '2. 页面信息不足以判断时，主动用 submission_browser_navigate 打开近期目录 / 投稿须知 / 期刊官网补充调查，并用一句话告诉用户你在看什么。',
    '3. 帮用户找刊时调用 journal_directory_search（中文刊 source=eshukan，外文/SCI 刊 source=letpub），候选经 journal_directory_detail 或浏览器核实后再推荐，不凭记忆编造期刊信息与影响因子。',
    '4. 还缺少会显著影响推荐的用户偏好时，用 metis-choice-group 围栏块追问（一次最多两组问题）；能从成果推断的不要问。',
    '5. 推荐候选时用 metis-journal-card 围栏块（每刊一张，最多 5 张），说明契合点与风险。',
    '6. 用户明确表示"就投这个 / 把它设为目标期刊"时，输出 metis-submission-card 围栏块，由前端创建正式投稿记录。',
    '7. 禁止内部术语（Profiling/Snapshot/状态码/工具名/参数）。不用虚假的单一匹配度分数；结论用：建议第一顺位投稿 / 适合作为重要备选 / 中等幅度修改后值得考虑 / 需要较大改造 / 当前版本不建议投稿，并说明理由、风险、如果要投需要改什么。',
    '8. 信息缺失不是失败：按可获得证据逐步形成判断。',
    '',
    '== 围栏块格式（JSON 必须合法） ==',
    '```metis-choice-group',
    '{"question":"你希望优先考虑哪些发表渠道？","options":["CSSCI","北大核心","CSCD","SSCI","SCI","国际会议","不限，由你判断"],"multi":true,"key":"indexes"}',
    '```',
    '```metis-journal-card',
    '{"name":"刊名","tags":["CSSCI","社会学"],"verdict":"较高","fit":["契合点1","契合点2"],"risks":["风险1"],"url":"https://…"}',
    '```',
    '```metis-submission-card',
    '{"name":"刊名","note":"一句话说明"}',
    '```',
    '',
    `== 当前成果（ArtifactContext） ==\n${input.outcomeSummary}`,
    `== 用户投稿意向（Intent） ==\n${input.intentText}`,
    input.shortlistText ? `== 已收藏候选 ==\n${input.shortlistText}` : '',
    `== 当前浏览器页面（BrowserContext，用户正在看的页面） ==\n${input.browserContext}`,
  ].filter(Boolean).join('\n');
}

export class SubmissionAssistantService {
  constructor(private readonly options: {
    agentLoop: AgentLoop | null;
    browser: SubmissionBrowserFacade;
    loadOutcome: (projectId: string, outcomeId: string) => { title: string; content: OutcomeDocument } | null;
  }) {}

  async chat(request: SubmissionAssistantRequest): Promise<SubmissionAssistantResult> {
    if (!this.options.agentLoop) return { ok: false, answer: '', error: '模型连接尚未配置。请先在「设置 → 模型连接」完成配置，再使用投稿参谋。' };
    const outcome = this.options.loadOutcome(request.projectId, request.outcomeId);
    if (!outcome) return { ok: false, answer: '', error: '当前成果不存在或不属于所选项目。' };

    const outcomeSummary = `《${outcome.title}》\n${outcomeToText(outcome.content).slice(0, OUTCOME_TEXT_CHARS)}`;
    const intentText = request.intent && Object.keys(request.intent).length > 0
      ? JSON.stringify(request.intent, null, 1)
      : '（尚未确认偏好；若影响推荐请用围栏块追问）';
    let browserContext = '（浏览器尚未打开页面）';
    try {
      // 任务2 上下文隔离：优先带归属校验提取。页面属于其他项目 → 拒绝注入；
      // 归属未知 → 放行但显式声明，绝不默认当作本项目的上下文。
      const scoped = this.options.browser.extractScoped
        ? await this.options.browser.extractScoped(request.projectId ?? null)
        : await this.options.browser.extract().then((result) => result.ok && result.page
          ? { ok: true as const, page: result.page, ownershipKnown: false }
          : { ok: false as const, error: result.error ?? 'browser_unavailable' });
      if (scoped.ok && scoped.page) {
        const ownershipNote = 'ownershipKnown' in scoped && scoped.ownershipKnown
          ? ''
          : '\n（注意：该页面来自共享浏览器，归属项目未知；若与本课题无关请忽略。）';
        browserContext = `URL：${scoped.page.url}\n标题：${scoped.page.title}\n可见文本：\n${scoped.page.text.slice(0, BROWSER_TEXT_CHARS)}${ownershipNote}`;
      } else if (!scoped.ok && 'scopeMismatch' in scoped && scoped.scopeMismatch) {
        browserContext = '（共享浏览器当前页属于其他项目，已按上下文隔离规则排除，不作为本课题参考。）';
      }
    } catch { /* 浏览器未打开时如实降级 */ }
    const shortlistText = request.shortlist && request.shortlist.length > 0
      ? request.shortlist.map((item) => `- ${item.name}${item.source ? `（${item.source}）` : ''}`).join('\n')
      : '';

    const thinkingPrefix = request.thinkingLevel === 'deep'
      ? '【思考强度：深度思考】请先充分展开多角度推理、权衡备选方案后再输出结果。\n\n'
      : request.thinkingLevel === 'fast'
        ? '【思考强度：快速】请压缩推理过程，直接给出简洁结果。\n\n'
        : '';
    const response = await runEphemeralChatTurn({
      agentLoop: this.options.agentLoop,
      sessionId: `submission-assistant-${randomUUID()}`,
      messages: [
        ...(request.history ?? []).map((item) => ({ role: item.role, content: item.content })),
        { role: 'user' as const, content: `${thinkingPrefix}${request.instruction}` },
      ],
      requestId: `submission-assistant-${randomUUID()}`,
      maxTurns: 8,
      allowedTools: SUBMISSION_ASSISTANT_TOOLS,
      projectId: request.projectId,
      skillPrompt: systemPrompt({ outcomeSummary, browserContext, intentText, shortlistText }),
    });
    if (response.status !== 'completed' || !response.answer.trim()) {
      // 如实化：诊断里带真实原因（provider 错误体/回答未通过校验），翻译后上抛，
      // 不再只显示笼统的 (error)。
      const detail = response.diagnostics.find((item) => item.message)?.message ?? '';
      return { ok: false, answer: '', error: `本轮参谋未完成（${response.status}）：${describeAdvisorFailure(response.status, detail)}。浏览器与成果均未被改动，请重试。` };
    }
    return { ok: true, answer: response.answer };
  }
}
