/**
 * SkillExtractor — generates a reusable skill definition from a conversation.
 *
 * The user selects a conversation (or a slice of it) and asks Metis to "learn"
 * it into a skill. This module asks the provider to distill the conversation
 * into a structured skill (system prompt + tool allow-list + turn budget),
 * using the same prompt style as the built-in DEFAULT_SKILLS so the result
 * drops straight into SkillRegistry.
 *
 * Provider failures degrade gracefully: a minimal skill is still produced from
 * a deterministic fallback so the user always gets something to install.
 */

import type { BaseProvider } from '../providers/BaseProvider.js';
import type { ChatMessage } from '../core/types.js';

// ─── Generated skill shape ────────────────────────────────────

export interface ExtractedSkill {
  /** Stable id slug, e.g. "summarize-meeting-notes". */
  id: string;
  name: string;
  description: string;
  /** Step-by-step system prompt in the style of DEFAULT_SKILLS. */
  systemPrompt: string;
  /** Tool names the skill is allowed to use (subset of builtin tools). */
  allowedTools: string[];
  /** Turn budget for the skill's agent runs. */
  maxTurns: number;
  /** Provenance: why the skill was created, for the user's review. */
  rationale: string;
}

export interface SkillExtractionOptions {
  /** The conversation to learn from. */
  messages: ChatMessage[];
  /** Optional user intent, e.g. "做成一个能复用的文献综述技能". */
  userIntent?: string;
  /** Known tool names, used to validate the model's tool allow-list. */
  knownTools?: string[];
}

const MIN_CONVERSATION_CHARS = 60;
const DEFAULT_MAX_TURNS = 12;

// ─── Extractor ────────────────────────────────────────────────

export class SkillExtractor {
  private readonly provider?: BaseProvider;

  constructor(provider?: BaseProvider) {
    this.provider = provider;
  }

  /**
   * Extract a skill from a conversation. Returns null only when the input is
   * too short to learn from; provider failures fall back to a deterministic
   * skill so the user always gets an installable artifact.
   */
  async extract(options: SkillExtractionOptions): Promise<ExtractedSkill | null> {
    const transcript = buildTranscript(options.messages);
    if (transcript.length < MIN_CONVERSATION_CHARS) return null;

    if (this.provider) {
      try {
        const skill = await this.extractWithProvider(transcript, options);
        if (skill) return skill;
      } catch {
        // fall through to deterministic extraction
      }
    }
    return this.deterministicExtract(transcript, options);
  }

  // ─── Provider-driven extraction ────────────────────────────

  private async extractWithProvider(
    transcript: string,
    options: SkillExtractionOptions,
  ): Promise<ExtractedSkill | null> {
    const knownTools = options.knownTools ?? [];
    const response = await this.provider!.complete([
      {
        role: 'system',
        content: [
          'You are a skill extraction engine. Analyze the conversation below and distill it into a reusable, well-structured skill that an AI agent can follow to reproduce the same kind of work.',
          'Return ONLY a JSON object, no preamble, in this exact shape:',
          '{"id":"kebab-case-slug","name":"short display name","description":"one sentence","systemPrompt":"step by step instructions","allowedTools":["tool_name",...],"maxTurns":number,"rationale":"why this skill is useful"}',
          'Rules for systemPrompt:',
          '- Write clear, numbered step-by-step instructions (like a playbook).',
          '- Reference concrete tool names from the allowedTools list when the step needs a tool.',
          '- Capture the WORKFLOW pattern, not the specific data of this one conversation.',
          '- Keep it general enough to reuse on new inputs, specific enough to be actionable.',
          'Rules for allowedTools: only include tool names from this known list (empty list = no tools): ' + (knownTools.length > 0 ? knownTools.join(', ') : '(none available)'),
          'Rules for id: lowercase kebab-case, 3-40 chars, descriptive of the workflow.',
          'Rules for maxTurns: 4-30, proportional to workflow complexity.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          options.userIntent ? `User intent for this skill: ${options.userIntent}` : 'No specific intent given — infer the most reusable workflow from the conversation.',
          'Conversation to learn from:',
          transcript,
        ].join('\n\n'),
      },
    ], undefined, { temperature: 0.3 });

    return parseSkillJson(response.content, knownTools);
  }

  // ─── Deterministic fallback ────────────────────────────────

  private deterministicExtract(transcript: string, options: SkillExtractionOptions): ExtractedSkill {
    // Build a minimal skill from the conversation when no provider is available.
    const intent = options.userIntent?.trim() || '从对话中学习的工作流';
    const slug = slugify(intent) || 'learned-skill';
    return {
      id: slug,
      name: intent.slice(0, 40),
      description: `从对话自动提取的技能：${intent.slice(0, 60)}`,
      systemPrompt: [
        `# ${intent}`,
        '',
        '按照以下步骤完成任务：',
        '1. 理解用户的具体需求。',
        '2. 参考学习到的对话模式，复现同样的工作流。',
        '3. 调用可用工具完成每一步。',
        '4. 汇总结果并给出清晰的最终输出。',
        '',
        '## 参考对话（学习样本）',
        transcript.slice(0, 2000),
      ].join('\n'),
      allowedTools: [],
      maxTurns: DEFAULT_MAX_TURNS,
      rationale: '无 AI 模型可用，已用对话原文作为技能模板。建议配置模型后重新生成以获得更精炼的技能。',
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(0, 24_000);
}

function parseSkillJson(raw: string, knownTools: string[]): ExtractedSkill | null {
  try {
    const text = String(raw ?? '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
    const candidate = (fenced?.[1] ?? text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      id?: unknown; name?: unknown; description?: unknown;
      systemPrompt?: unknown; allowedTools?: unknown; maxTurns?: unknown; rationale?: unknown;
    };

    const id = sanitizeId(parsed.id);
    const name = sanitizeText(parsed.name, 40) || 'Learned Skill';
    const description = sanitizeText(parsed.description, 120) || '从对话提取的技能';
    const systemPrompt = sanitizeText(parsed.systemPrompt, 12_000);
    if (!systemPrompt) return null;

    const rawTools = Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [];
    const allowedTools = rawTools
      .filter((t): t is string => typeof t === 'string' && (knownTools.length === 0 || knownTools.includes(t)))
      .slice(0, 60);

    const maxTurns = clampInt(parsed.maxTurns, 4, 30, DEFAULT_MAX_TURNS);
    const rationale = sanitizeText(parsed.rationale, 500) || '从对话工作流自动提取。';

    return { id, name, description, systemPrompt, allowedTools, maxTurns, rationale };
  } catch {
    return null;
  }
}

function sanitizeId(raw: unknown): string {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'learned-skill';
}

function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLen);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function slugify(text: string): string {
  return sanitizeId(text);
}
