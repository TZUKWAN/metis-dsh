/**
 * Prompt management — system prompt templates and assembly.
 *
 * Provides structured prompt templates for different research tasks
 * and assembles the final message list for AgentLoop consumption.
 * Supports model-size-aware prompt selection for small → large models.
 */

import type { ChatMessage } from '../core/types.js';

// ─── Model Size Tiers ──────────────────────────────────────

export type ModelSize = 'small' | 'medium' | 'large';

/**
 * Detect model size from context window tokens.
 * small:  ≤16K context (7B-14B class)
 * medium: ≤64K context (32B-70B class)
 * large:  >64K context (GPT-4, Claude class)
 */
export function detectModelSize(maxContextTokens: number): ModelSize {
  if (maxContextTokens <= 16384) return 'small';
  if (maxContextTokens <= 65536) return 'medium';
  return 'large';
}

// ─── System Prompt Templates ──────────────────────────────────

export const BASE_SYSTEM_PROMPT = `You are Metis, a research assistant powered by AI. You help researchers with:
- Literature search and review
- Paper analysis and comparison
- Experiment design and tracking
- Academic writing assistance
- Data analysis and visualization

Guidelines:
1. Be precise and cite sources when possible.
2. Structure your responses clearly with headings and bullet points.
3. When uncertain, say so explicitly rather than guessing.
4. Use tools when available to verify information.
5. Keep responses focused and relevant to the research context.`;

/** Small-model optimized: shorter prompt, explicit tool use instructions, one-step-at-a-time guidance */
export const SMALL_MODEL_SYSTEM_PROMPT = `You are Metis, a research assistant. Follow these rules strictly:
1. Read the task carefully. Use tools to get information before answering.
2. Do ONE thing at a time. After each tool call, wait for the result before planning the next step.
3. To use a tool, output: {"tool": "<name>", "args": {...}}
4. Be concise. Short answers are better than long, wrong ones.
5. If unsure, say "I don't know" rather than guessing.
Available tools are listed in each turn. Use them when needed.`;

/** Medium-model: balanced prompt with structure guidance */
export const MEDIUM_MODEL_SYSTEM_PROMPT = `You are Metis, a research assistant. Guidelines:
1. Use tools to search, read, and analyze information before responding.
2. Structure your output: first summarize findings, then provide analysis, then suggest next steps.
3. Cite sources and be specific about methodology.
4. When using tools, call them explicitly with proper parameters.
5. If a tool call fails, try an alternative approach before giving up.`;

export const RESEARCH_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You are currently in research mode. Focus on:
- Finding and analyzing relevant papers
- Identifying key findings and methodology
- Comparing results across studies
- Identifying research gaps and opportunities`;

export const WRITING_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You are currently in writing mode. Focus on:
- Structuring academic papers
- Maintaining formal academic tone
- Proper citation and referencing
- Clear and precise language
- Logical flow between sections`;

export const ANALYSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You are currently in analysis mode. Focus on:
- Statistical analysis and interpretation
- Data visualization suggestions
- Result validation and verification
- Methodology assessment`;

/**
 * Get the optimal system prompt for a given model size.
 * Small models get concise, directive prompts with explicit tool-use examples.
 * Large models get the full, detailed prompt.
 */
export function getSystemPrompt(
  modelSize: ModelSize,
  mode?: 'research' | 'writing' | 'analysis',
): string {
  // Start with size-appropriate base prompt
  let prompt: string;
  switch (modelSize) {
    case 'small': prompt = SMALL_MODEL_SYSTEM_PROMPT; break;
    case 'medium': prompt = MEDIUM_MODEL_SYSTEM_PROMPT; break;
    default: prompt = BASE_SYSTEM_PROMPT;
  }

  // Layer on mode-specific guidance (abbreviated for small models)
  switch (mode) {
    case 'research':
      prompt += modelSize === 'small'
        ? '\n\nMode: RESEARCH. Use arxiv_search and read_pdf tools.'
        : '\n\n' + RESEARCH_SYSTEM_PROMPT.split('\n\n').slice(1).join('\n\n');
      break;
    case 'writing':
      prompt += modelSize === 'small'
        ? '\n\nMode: WRITING. Use write_file for drafts, format_citation for references.'
        : '\n\n' + WRITING_SYSTEM_PROMPT.split('\n\n').slice(1).join('\n\n');
      break;
    case 'analysis':
      prompt += modelSize === 'small'
        ? '\n\nMode: ANALYSIS. Use read_file for data, write_file for results.'
        : '\n\n' + ANALYSIS_SYSTEM_PROMPT.split('\n\n').slice(1).join('\n\n');
      break;
  }

  return prompt;
}

// ─── Prompt Assembly ──────────────────────────────────────────

export interface PromptAssemblyOptions {
  systemPrompt?: string;
  context?: string;
  history?: ChatMessage[];
  userMessage: string;
  maxHistoryMessages?: number;
}

/**
 * Assemble the final message list for the agent loop.
 * Structure: [system] + [context] + [history...] + [user message]
 */
export function assembleMessages(options: PromptAssemblyOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // System prompt
  const system = options.systemPrompt ?? BASE_SYSTEM_PROMPT;
  messages.push({ role: 'system', content: system });

  // Optional context (e.g., paper summaries, experiment data)
  if (options.context) {
    messages.push({ role: 'system', content: `Context:\n${options.context}` });
  }

  // Chat history (limited to prevent context overflow)
  if (options.history && options.history.length > 0) {
    const maxHist = options.maxHistoryMessages ?? 20;
    const history = options.history.slice(-maxHist);
    messages.push(...history);
  }

  // User message
  messages.push({ role: 'user', content: options.userMessage });

  return messages;
}

/**
 * Build a tool-using prompt that instructs the agent to use specific tools.
 */
export function toolUsePrompt(task: string, availableTools: string[]): string {
  return `${task}

Available tools: ${availableTools.join(', ')}
Use the appropriate tools to complete this task. Call tools as needed.`;
}

/**
 * Build a structured output prompt that requests JSON output.
 */
export function structuredOutputPrompt(task: string, schema: Record<string, unknown>): string {
  return `${task}

Respond with a JSON object matching this schema:
${JSON.stringify(schema, null, 2)}

Return ONLY valid JSON, no markdown fences or explanation.`;
}
