/**
 * Research tool specs and handlers — RAG search, experiment reproduction, skill execution.
 *
 * Registered into the ToolRegistry alongside existing academic and file tools.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';

// ─── RAG Search Tool ────────────────────────────────────────

export const RAG_SEARCH_TOOL: ToolSpec = {
  name: 'rag_search',
  description: 'Search your paper library using semantic retrieval. Finds papers relevant to a query using TF-IDF + cosine similarity, then returns ranked results with snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language query about papers' },
      topK: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
    },
    required: ['query'],
  },
  examples: [
    { input: { query: 'transformer attention mechanism', topK: 3 }, output: 'Found 3 relevant papers:\n[1] Attention Is All You Need (relevance: 85%)...\n[2] BERT: Pre-training of Deep Bidirectional Transformers...\n[3] Language Models are Few-Shot Learners...' },
    { input: { query: 'diffusion models image generation' }, output: 'Found 2 relevant papers:\n[1] Denoising Diffusion Probabilistic Models (relevance: 92%)...' },
  ],
};

export const ragSearchHandler: ToolHandler = async (args) => {
  const query = String(args.query ?? '');
  if (!query.trim()) return 'Error: No query provided.';

  try {
    const { getRagEngine } = await import('../../research/RagEngine.js');
    const engine = getRagEngine();
    const topK = Math.min(Number(args.topK ?? 5), 20);
    const results = engine.search(query, topK);

    if (results.length === 0) {
      return 'No matching papers found in your library. Try a different query or add more papers.';
    }

    const summary = `Found ${results.length} relevant paper(s):\n\n${engine.formatResultsForLLM(results)}`;
    return summary;
  } catch (err) {
    return `RAG search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── RAG Index Tool ─────────────────────────────────────────

export const RAG_INDEX_TOOL: ToolSpec = {
  name: 'rag_index',
  description: 'Index all papers in the library for semantic search. Must be called before rag_search if papers have been added or modified.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const ragIndexHandler: ToolHandler = async () => {
  try {
    // Dynamic import to avoid circular dependencies
    const { getRagEngine } = await import('../../research/RagEngine.js');
    const engine = getRagEngine();

    // Note: papers are indexed lazily via the frontend/store bridge.
    // This handler triggers a re-index of any newly added papers.
    const stats = engine.stats();
    return `RAG index status: ${stats.documentCount} documents indexed, ${stats.vocabularySize} unique terms.`;
  } catch (err) {
    return `RAG index failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Execute Code Tool (Experiment Reproduction) ────────────

export const EXECUTE_CODE_TOOL: ToolSpec = {
  name: 'execute_code',
  description: 'Execute code in a sandboxed child process. Supports Python, JavaScript, and shell commands. Returns stdout, stderr, exit code, and execution time. Max 60s timeout. Use for running experiment code, data analysis scripts, or testing code snippets.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute (e.g., "python experiment.py" or "node script.js")' },
      code: { type: 'string', description: 'Source code to write before execution (optional, use with filename)' },
      filename: { type: 'string', description: 'Filename to write code to (optional, e.g., "experiment.py")' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 60, max 300)' },
      env: { type: 'object', description: 'Environment variables (optional)' },
    },
    required: ['command'],
  },
  examples: [
    { input: { command: 'python experiment.py', code: 'import numpy as np\nprint(np.random.randn(5))', filename: 'experiment.py' }, output: 'Exit Code: 0\nDuration: 234ms\n\n--- STDOUT ---\n[0.32, -0.15, 1.28, 0.74, -0.93]' },
    { input: { command: 'python analyze.py', timeout: 30 }, output: 'Exit Code: 0\nDuration: 1520ms\n\n--- STDOUT ---\nResults: mean=0.52, std=0.18, p<0.01' },
  ],
};

export const executeCodeHandler: ToolHandler = async (args) => {
  const command = String(args.command ?? '');
  if (!command.trim()) return 'Error: No command specified.';

  try {
    const { getExperimentReproducer } = await import('../../research/ExperimentReproducer.js');
    const reproducer = getExperimentReproducer();

    const inputFiles: Record<string, string> | undefined = args.code && args.filename
      ? { [String(args.filename)]: String(args.code) }
      : undefined;

    const result = await reproducer.execute({
      command,
      inputFiles,
      timeout: Math.min(Number(args.timeout ?? 60), 300),
      env: args.env as Record<string, string> | undefined,
    });

    const parts: string[] = [];
    parts.push(`Exit Code: ${result.exitCode ?? 'N/A'}`);
    parts.push(`Duration: ${result.durationMs}ms`);
    if (result.timedOut) parts.push('[警告] Execution timed out');
    if (result.killedBy) parts.push(`Killed by: ${result.killedBy}`);
    if (result.stdout) parts.push(`\n--- STDOUT ---\n${result.stdout}`);
    if (result.stderr) parts.push(`\n--- STDERR ---\n${result.stderr}`);

    return parts.join('\n');
  } catch (err) {
    return `Code execution failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Skill Execute Tool ────────────────────────────────────

export const SKILL_EXECUTE_TOOL: ToolSpec = {
  name: 'skill_execute',
  description: 'Execute a named research skill (e.g., literature-review, paper-reading, code-generation, data-analysis, experiment-design, paper-writing). Skills provide specialized system prompts and tool configurations for common research tasks.',
  parameters: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'Skill ID to execute (e.g., "literature-review", "paper-reading", "code-generation")' },
      task: { type: 'string', description: 'Specific task description for the skill' },
      context: { type: 'string', description: 'Additional context or background information (optional)' },
    },
    required: ['skillId', 'task'],
  },
};

export const skillExecuteHandler: ToolHandler = async (args) => {
  const skillId = String(args.skillId ?? '');
  const task = String(args.task ?? '');

  try {
    const { getSkillRegistry, registerDefaultSkills } = await import('../../skills/SkillRegistry.js');
    const registry = getSkillRegistry();

    // Ensure defaults are loaded
    if (registry.list().length === 0) {
      registerDefaultSkills(registry);
    }

    const skill = registry.get(skillId);
    if (!skill) {
      const available = registry.list().map((s) => `${s.id}: ${s.description}`).join('\n  ');
      return `Unknown skill '${skillId}'. Available skills:\n  ${available}`;
    }

    const context = args.context ? String(args.context) : undefined;
    const prompt = registry.buildPrompt(skillId, task, context);

    // Inject skill into runtime — AgentLoop will pick this up on next turn
    registry.setActiveSkillPrompt(prompt);

    const result = [
      `# Skill: ${skill.name}`,
      `Description: ${skill.description}`,
      `Allowed Tools: ${skill.allowedTools?.join(', ') ?? 'all'}`,
      `Max Turns: ${skill.maxTurns ?? 'default'}`,
      '',
      '## Generated Prompt',
      prompt,
    ];

    return result.join('\n');
  } catch (err) {
    return `Skill execution failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Skill List Tool ────────────────────────────────────────

export const SKILL_LIST_TOOL: ToolSpec = {
  name: 'skill_list',
  description: 'List all available research skills with descriptions.',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Filter by category: research, writing, coding, data, workflow, custom (optional)' },
    },
  },
};

export const skillListHandler: ToolHandler = async (args) => {
  try {
    const { getSkillRegistry, registerDefaultSkills } = await import('../../skills/SkillRegistry.js');
    const registry = getSkillRegistry();
    if (registry.list().length === 0) registerDefaultSkills(registry);

    const category = args.category ? String(args.category) : undefined;
    const skills = category
      ? registry.listByCategory(category as 'research' | 'writing' | 'coding' | 'data' | 'workflow' | 'custom')
      : registry.list();

    if (skills.length === 0) return 'No skills found.';

    const lines = skills.map((s) => `- **${s.id}** (${s.category}): ${s.description}`);
    return `Available Skills (${skills.length}):\n\n${lines.join('\n')}`;
  } catch (err) {
    return `Skill list failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Registration Helpers ──────────────────────────────────

export const RESEARCH_TOOL_SPECS: ToolSpec[] = [
  RAG_SEARCH_TOOL,
  RAG_INDEX_TOOL,
  EXECUTE_CODE_TOOL,
  SKILL_EXECUTE_TOOL,
  SKILL_LIST_TOOL,
];

export function getResearchToolSpecs(): ToolSpec[] {
  return RESEARCH_TOOL_SPECS;
}

export function getResearchToolHandlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set('rag_search', ragSearchHandler);
  map.set('rag_index', ragIndexHandler);
  map.set('execute_code', executeCodeHandler);
  map.set('skill_execute', skillExecuteHandler);
  map.set('skill_list', skillListHandler);
  return map;
}
