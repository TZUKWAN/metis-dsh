/**
 * LearningEngine — 自主学习机制（A/B/C）
 *
 * A. 记忆驱动：对话结束后由模型自动提取关键决策、偏好与经验，写入
 *    MemoryManager（key_decision / preference / experience），跨会话生效。
 * B. 提示词自适应：规则检测用户反馈信号（“太长了”“用表格”“说中文”等），
 *    持久化为 behavior:* 偏好并注入 system prompt，让模型逐步贴合用户风格。
 * C. 工具使用优化：记录每次工具调用的成功/失败，统计成功率，把可靠性
 *    提示注入 prompt，引导 Agent 优先使用高成功率工具。
 *
 * 所有 LLM 调用均 fire-and-forget：学习过程绝不阻塞对话响应，失败时静默
 * 降级，只影响学习质量，不影响聊天主流程。
 */

import type { ChatMessage } from '../core/types.js';
import type { BaseProvider } from '../providers/BaseProvider.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';

// ─── 工具统计 ────────────────────────────────────────────────

export interface ToolStat {
  attempts: number;
  failures: number;
}

export interface ToolOutcome {
  name: string;
  status: 'ok' | 'error';
}

// ─── 反馈信号 ────────────────────────────────────────────────

export interface FeedbackSignal {
  /** Behavior preference key, e.g. 'behavior:verbosity'. */
  key: string;
  value: string;
}

const FEEDBACK_RULES: Array<{ pattern: RegExp; key: string; value: string; label: string }> = [
  // 详略（否定形式优先于肯定形式）
  { pattern: /(太长了|太啰嗦|太冗长|太长|简短|简洁|简练|短一点|别啰嗦|精简)/iu, key: 'behavior:verbosity', value: 'concise', label: '回答应简洁精炼，避免冗长' },
  { pattern: /(详细一点|详细些|展开说|多说一点|更详细|详细地)/iu, key: 'behavior:verbosity', value: 'detailed', label: '回答应详细充分，尽量展开说明' },
  // 格式（“不要用列表”优先于“用列表”）
  { pattern: /(不要用列表|别用列表|不用列表|不要列表|别列出来|用段落|写成段落|段落形式)/iu, key: 'behavior:format', value: 'prose', label: '优先使用连贯段落，避免项目符号列表' },
  { pattern: /(用列表|列出来|列一下|编号列出|用要点)/iu, key: 'behavior:format', value: 'bullets', label: '优先使用项目符号/编号列表组织内容' },
  { pattern: /(用表格|做成表格|整理成表格|表格形式)/iu, key: 'behavior:format', value: 'table', label: '优先使用表格呈现对比或结构化数据' },
  // 语言
  { pattern: /(说中文|用中文|请用中文|中文回答|用汉语)/iu, key: 'behavior:language', value: 'zh', label: '使用中文回答' },
  { pattern: /(说英文|用英文|in English|speak English)/iu, key: 'behavior:language', value: 'en', label: '回答使用英文' },
  // 语气
  { pattern: /(别说教|别太正式|轻松一点|随意一点|口语化)/iu, key: 'behavior:tone', value: 'casual', label: '语气轻松自然，不过度正式' },
  { pattern: /(正式一点|专业一点|更正式|书面化|严谨一些)/iu, key: 'behavior:tone', value: 'formal', label: '语气正式专业，书面化表达' },
];

const MIN_EXTRACT_USER_CHARS = 30;

// ─── Learning Engine ─────────────────────────────────────────

export interface LearningEngineOptions {
  memory?: MemoryManager;
  provider?: BaseProvider;
  store?: PersistenceStore;
}

const TOOL_STATS_MEMORY_KEY = 'learning:toolstats';
const TOOL_STATS_PERSIST_EVERY = 20;

export class LearningEngine {
  private readonly memory?: MemoryManager;
  private readonly provider?: BaseProvider;
  private readonly store?: PersistenceStore;

  /** In-memory tool reliability stats: toolName → { attempts, failures }. */
  private readonly toolStats = new Map<string, ToolStat>();
  private toolStatMutationsSincePersist = 0;

  constructor(options: LearningEngineOptions = {}) {
    this.memory = options.memory;
    this.provider = options.provider;
    this.store = options.store;
    this.loadToolStats();
  }

  // ─── C. 工具使用优化 ─────────────────────────────────────

  /** Called by AgentLoop after every tool dispatch. */
  recordToolOutcome(outcome: ToolOutcome): void {
    if (!outcome?.name) return;
    const stat = this.toolStats.get(outcome.name) ?? { attempts: 0, failures: 0 };
    stat.attempts += 1;
    if (outcome.status !== 'ok') stat.failures += 1;
    this.toolStats.set(outcome.name, stat);
    this.toolStatMutationsSincePersist += 1;
    if (this.toolStatMutationsSincePersist >= TOOL_STATS_PERSIST_EVERY) {
      this.persistToolStats();
    }
  }

  getToolStats(): Map<string, ToolStat> {
    return new Map(this.toolStats);
  }

  loadToolStats(): void {
    if (!this.store) return;
    try {
      const entry = this.store.getMemory(TOOL_STATS_MEMORY_KEY);
      if (!entry?.value) return;
      const parsed = JSON.parse(entry.value) as Record<string, { attempts?: number; failures?: number }>;
      this.toolStats.clear();
      for (const [name, stat] of Object.entries(parsed)) {
        if (typeof stat?.attempts === 'number' && stat.attempts > 0) {
          this.toolStats.set(name, {
            attempts: stat.attempts,
            failures: typeof stat.failures === 'number' ? stat.failures : 0,
          });
        }
      }
    } catch { /* corrupt stats are discarded */ }
  }

  persistToolStats(): void {
    if (!this.store) return;
    try {
      const payload: Record<string, ToolStat> = {};
      for (const [name, stat] of this.toolStats) {
        payload[name] = stat;
      }
      this.store.setMemory(TOOL_STATS_MEMORY_KEY, JSON.stringify(payload), 'learning');
      this.toolStatMutationsSincePersist = 0;
    } catch { /* ignore */ }
  }

  /** Build a prompt fragment recommending reliable tools (C). */
  buildToolGuidance(): string {
    const lines: string[] = [];
    const entries = [...this.toolStats.entries()]
      .filter(([, stat]) => stat.attempts >= 3)
      .sort((a, b) => (b[1].attempts - b[1].failures) / b[1].attempts - (a[1].attempts - a[1].failures) / a[1].attempts);
    for (const [name, stat] of entries) {
      const successRate = ((stat.attempts - stat.failures) / stat.attempts) * 100;
      const rate = `${successRate.toFixed(0)}%`;
      if (stat.failures === 0) {
        lines.push(`- ${name}: ${stat.attempts} 次调用，成功率 ${rate} — 可靠，可优先使用`);
      } else if (successRate >= 60) {
        lines.push(`- ${name}: ${stat.attempts} 次调用，成功率 ${rate}`);
      } else {
        lines.push(`- ${name}: ${stat.attempts} 次调用，成功率 ${rate} — 失败率偏高，谨慎使用或换用替代工具`);
      }
    }
    if (lines.length === 0) return '';
    return '## 工具可靠性（基于历史使用自动学习）\n' + lines.join('\n');
  }

  // ─── B. 提示词自适应 ─────────────────────────────────────

  /** Rule-based detection of user feedback signals in the tail of a conversation. */
  detectFeedbackSignals(messages: ChatMessage[]): FeedbackSignal[] {
    const signals: FeedbackSignal[] = [];
    const seenKeys = new Set<string>();
    const recentUserText = messages
      .slice(-12)
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content)
      .join('\n');
    if (!recentUserText.trim()) return signals;
    for (const rule of FEEDBACK_RULES) {
      // First matching rule per key wins (rule order = precedence, so negations
      // like “不要用列表” override the positive “用列表” form).
      if (seenKeys.has(rule.key)) continue;
      if (rule.pattern.test(recentUserText)) {
        signals.push({ key: rule.key, value: rule.value });
        seenKeys.add(rule.key);
      }
    }
    return signals;
  }

  /** Persist detected feedback signals as behavior preferences (B). */
  applyFeedbackSignals(messages: ChatMessage[], projectId?: string): FeedbackSignal[] {
    const signals = this.detectFeedbackSignals(messages);
    for (const signal of signals) {
      this.memory?.recordPreference(signal.key, signal.value, projectId);
    }
    return signals;
  }

  /** Read persisted behavior preferences into a prompt fragment (B). */
  buildBehaviorPreferences(projectId?: string): string {
    const prefs = this.memory?.getAllPreferences(projectId) ?? [];
    const behavior = prefs.filter((p) => p.key.startsWith('pref:behavior:'));
    if (behavior.length === 0) return '';
    const labels = new Map(FEEDBACK_RULES.map((r) => [`${r.key}:${r.value}`, r.label]));
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const pref of behavior) {
      const key = pref.key.replace('pref:', '');
      const pair = `${key}:${pref.value}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const label = labels.get(pair);
      lines.push(`- ${label ?? key}${label ? '' : ` = ${pref.value}`}`);
    }
    if (lines.length === 0) return '';
    return '## 用户偏好（自动学习，请遵循）\n' + lines.join('\n');
  }

  // ─── A. 记忆驱动 ─────────────────────────────────────────

  /**
   * After a chat turn, have the model extract durable knowledge (decisions,
   * preferences, experiences) from the recent exchange and store it. Fire and
   * forget — never throws.
   */
  async ingestConversation(messages: ChatMessage[], projectId?: string): Promise<void> {
    if (!this.provider || !this.memory) return;
    try {
      // Cheap pre-filter: skip trivial turns (e.g. "继续") to save LLM calls.
      const recentUserText = messages
        .slice(-8)
        .filter((m) => m.role === 'user' && typeof m.content === 'string')
        .map((m) => m.content)
        .join('\n');
      if (recentUserText.trim().length < MIN_EXTRACT_USER_CHARS) return;

      const recent = messages.slice(-16);
      const transcript = recent
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
        .join('\n')
        .slice(0, 24000);

      const response = await this.provider.complete([
        {
          role: 'system',
          content: [
            'You are a memory extraction engine. From the conversation below, extract durable knowledge that should be remembered across sessions.',
            'Return ONLY a JSON object, no preamble, in this exact shape:',
            '{"decisions": ["...key decisions made..."], "preferences": [{"key": "lowercase_key", "value": "concise value"}], "experiences": ["...lessons or reusable methods..."]}',
            'Rules: decisions are factual commitments or conclusions; preferences are reusable style/format choices of the user; experiences are lessons or methods worth reusing.',
            'Be conservative: extract only genuinely durable items. Empty arrays are fine. Max 3 decisions, 3 preferences, 3 experiences.',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ], undefined, { temperature: 0.2, thinking: true });

      const parsed = parseExtractionJson(response.content);
      if (!parsed) return;

      for (const decision of parsed.decisions) {
        this.memory.recordKeyDecision(decision, 'auto-extracted from conversation', projectId);
      }
      for (const pref of parsed.preferences) {
        const key = sanitizePreferenceKey(pref.key);
        if (key) this.memory.recordPreference(key, String(pref.value).slice(0, 200), projectId);
      }
      for (const experience of parsed.experiences) {
        this.memory.set(`exp:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, experience, 'experience', projectId);
      }
    } catch { /* learning must never break a chat turn */ }
  }

  // ─── 注入（B + C 合并） ───────────────────────────────────

  /** Combined learning context fragment appended to the system prompt. */
  buildLearningContext(projectId?: string): string {
    const parts = [
      this.buildBehaviorPreferences(projectId),
      this.buildToolGuidance(),
    ].filter((p) => p.trim().length > 0);
    if (parts.length === 0) return '';
    return '\n\n---\n\n' + parts.join('\n\n');
  }

  // ─── 自主科研事件订阅（hook 闭环） ───────────────────────

  /**
   * Ingest a substantial output produced by the autonomous research engine.
   * Stored as an experience so future research/prompts can reuse it. This is
   * the consumer side of the ResearchEventBus subscription.
   */
  rememberAutonomousOutput(phase: string, stepName: string, output: string): void {
    if (!this.memory) return;
    try {
      const trimmed = output.slice(0, 2000);
      this.memory.set(
        `auto:${phase}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
        `[${phase}/${stepName}] ${trimmed}`,
        'autonomous_output',
      );
    } catch { /* ignore */ }
  }

  /** Ingest a reflection decision (advance/redo/rollback) as a learned rule. */
  rememberAutonomousDecision(phase: string, reasoning: string): void {
    if (!this.memory) return;
    try {
      this.memory.recordKeyDecision(
        `自主科研·${phase}阶段通过：${reasoning.slice(0, 200)}`,
        'autonomous research reflection',
      );
    } catch { /* ignore */ }
  }
}

// ─── 内部工具 ────────────────────────────────────────────────

function sanitizePreferenceKey(raw: string): string {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_:-]/gu, '_').slice(0, 64);
  return key;
}

interface ExtractionResult {
  decisions: string[];
  preferences: Array<{ key: string; value: string }>;
  experiences: string[];
}

function parseExtractionJson(raw: string): ExtractionResult | null {
  try {
    const text = String(raw ?? '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
    const candidate = (fenced?.[1] ?? text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<ExtractionResult>;
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String).filter(Boolean).slice(0, 3) : [],
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences.slice(0, 3) : [],
      experiences: Array.isArray(parsed.experiences) ? parsed.experiences.map(String).filter(Boolean).slice(0, 3) : [],
    };
  } catch {
    return null;
  }
}
