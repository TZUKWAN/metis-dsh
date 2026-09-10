/**
 * Fuzzy JSON Parser — recovers malformed JSON from small-model tool calls.
 *
 * Small models (7B-14B) frequently produce JSON with:
 *   - Trailing commas: {"tool": "search", "args": {"q": "test",}}
 *   - Missing quotes: {tool: "search"}
 *   - JavaScript-style keys: {tool: "search", args: {}}
 *   - Extra text around JSON: "I'll search now: {\"tool\": \"search\"}"
 *   - Wrong key names: {function: "search", parameters: {q: "test"}}
 *
 * This parser applies progressively more aggressive recovery strategies
 * until valid JSON is obtained or all strategies are exhausted.
 */

// ─── Types ──────────────────────────────────────────────────

export interface ParseResult {
  /** Parsed JSON object, or null if all strategies failed */
  data: Record<string, unknown> | null;
  /** Which recovery strategy succeeded (or "clean" if no repair needed) */
  strategy: string;
  /** Original unparsed string */
  original: string;
  /** Repaired string (or original if no repair) */
  repaired: string;
  /** Whether parsing ultimately succeeded */
  success: boolean;
  /** Error message if all strategies failed */
  error?: string;
}

// ─── Recovery Strategies ───────────────────────────────────

const STRATEGIES: Array<{ name: string; fn: (s: string) => string }> = [
  // Strategy 1: Try raw parse first (no modification)
  { name: 'clean', fn: (s) => s },

  // Strategy 2: Remove trailing commas before } or ]
  { name: 'remove_trailing_commas', fn: (s) =>
    s.replace(/,\s*([}\]])/g, '$1')
  },

  // Strategy 3: Quote unquoted keys (JavaScript object style)
  { name: 'quote_keys', fn: (s) =>
    s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')
  },

  // Strategy 4: Extract JSON block from surrounding text
  { name: 'extract_json_block', fn: (s) => {
    const match = s.match(/\{[\s\S]*\}/);
    return match ? match[0] : s;
  }},

  // Strategy 5: Fix common key name errors (function→tool, parameters→args)
  { name: 'fix_key_names', fn: (s) =>
    s
      .replace(/"function"\s*:/g, '"tool":')
      .replace(/"parameters"\s*:/g, '"args":')
      .replace(/function\s*:/g, '"tool":')
      .replace(/parameters\s*:/g, '"args":')
  },

  // Strategy 6: Fix single quotes → double quotes
  { name: 'fix_single_quotes', fn: (s) =>
    s
      .replace(/'/g, '"')
      .replace(/"([^"]*)":/g, (_, key) => `"${key}":`)
  },

  // Strategy 7: Handle common value escaping issues
  { name: 'fix_escapes', fn: (s) =>
    s
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')  // Escape stray backslashes
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
  },

  // Strategy 8: Fix concatenated or nested JSON
  { name: 'trim_extra_braces', fn: (s) => {
    const trimmed = s.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }
    return trimmed;
  }},

  // Strategy 9: Remove everything except basic JSON structure
  { name: 'minimal_extract', fn: (s) => {
    const jsonMatch = s.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    return jsonMatch ? jsonMatch[0] : s;
  }},
];

// ─── Main Parser ───────────────────────────────────────────

/**
 * Parse a potentially malformed JSON string with progressive recovery.
 */
export function parseToolCall(raw: string): ParseResult {
  for (const strategy of STRATEGIES) {
    try {
      const repaired = strategy.fn(raw);
      const data = JSON.parse(repaired);

      // Validate we got a reasonable object
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return {
          data: data as Record<string, unknown>,
          strategy: strategy.name,
          original: raw,
          repaired: strategy.name === 'clean' ? raw : repaired,
          success: true,
        };
      }
    } catch {
      // This strategy failed, try next
    }
  }

  return {
    data: null,
    strategy: 'all_failed',
    original: raw,
    repaired: raw,
    success: false,
    error: `All ${STRATEGIES.length} parsing strategies failed for: ${raw.slice(0, 100)}`,
  };
}

/**
 * Extract and parse tool call from LLM response text.
 * Handles the common pattern where small models wrap JSON in text:
 *   "I will use the search tool: {"tool": "arxiv_search", "args": {"query": "transformers"}}"
 */
export function extractToolCall(text: string): ParseResult {
  // Check if the whole text is JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseToolCall(trimmed);
  }

  // Try to find JSON within markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch?.[1]) {
    return parseToolCall(codeBlockMatch[1]);
  }

  // Try to find any JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return parseToolCall(jsonMatch[0]);
  }

  return {
    data: null,
    strategy: 'no_json_found',
    original: text,
    repaired: text,
    success: false,
    error: 'No JSON object found in output',
  };
}
