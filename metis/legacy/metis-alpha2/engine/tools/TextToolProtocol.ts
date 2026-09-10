/**
 * Text tool protocol — parses JSON tool calls emitted as prose by models whose
 * gateways do not support native function calling (e.g. Qwen3 thinking models
 * behind One-API gateways).
 *
 * The injectToolPrompt convention asks the model to emit:
 *   {"tool": "<name>", "args": { ... }}
 * This module extracts such JSON from the model's text content so the agent
 * loop can treat it as a real tool call.
 *
 * Kept provider-agnostic (no provider import) so both the OpenAICompatProvider
 * (response parsing) and the AgentLoop (streaming aggregation) can share it.
 */

import { jsonrepair } from 'jsonrepair';
import type { ToolCall } from '../core/types.js';

/**
 * Strip raw tool-call markup that leaks into user-visible text when a model
 * (or its gateway) emits XML-ish function-call blocks the runtime does not
 * execute — e.g. DeepSeek/Qwen emitting literal `<tool_calls>…</tool_calls>`
 * or `<tool_call>…</tool_call>` (paired or truncated/unclosed at the end).
 * The runtime only acts on native tool_calls or the {"tool":…} JSON protocol;
 * anything else must never be shown to users as raw markup.
 */
export function stripTextToolMarkup(text: string): string {
  if (!text) return text;
  let stripped = text;
  // DeepSeek DSML text-protocol leaks (2026-08-24): <｜｜DSML｜｜invoke …> blocks.
  if (stripped.includes('DSML')) {
    stripped = stripped
      .replace(/<\s*\/?\s*[｜|]*\s*DSML\s*[｜|]*\s*tool_calls\s*>\s*/giu, '')
      .replace(/<\s*[｜|]+\s*DSML\s*[｜|]+\s*invoke[\s\S]*?<\s*\/\s*[｜|]*\s*DSML\s*[｜|]*\s*invoke\s*>/giu, '')
      .replace(/<\s*[｜|]+\s*DSML\s*[｜|]+\s*invoke[\s\S]*$/giu, '');
  }
  if (stripped.indexOf('<tool_call') === -1) return stripped.trim();
  return stripped
    // paired blocks
    .replace(/<tool_calls?>[\s\S]*?<\/\s*tool_calls?>/giu, '')
    // unclosed/truncated block running to end of output
    .replace(/<tool_calls?>[\s\S]*$/giu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse DeepSeek-style DSML text tool calls (2026-08-24).
 *
 * Some DeepSeek gateways emit their native markup as plain text instead of
 * native function-call deltas:
 *   <｜｜DSML｜｜tool_calls>
 *   <｜｜DSML｜｜invoke name="scenario_apply_update">
 *   <｜｜DSML｜｜parameter name="fields" string="false">{"…":…}</｜｜DSML｜｜parameter>
 *   </｜｜DSML｜｜invoke>
 *
 * `string="false"` means the parameter payload is structured JSON and must be
 * decoded; `string="true"` keeps the raw text verbatim. Tolerates fullwidth
 * （｜ U+FF5C）and ASCII pipe separators plus stray whitespace.
 */
export function parseDsmlToolCalls(content: string): ToolCall[] {
  if (!content || !content.includes('DSML')) return [];
  const invokePattern = /<\s*[｜|]+\s*DSML\s*[｜|]+\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\s*\/\s*[｜|]*\s*DSML\s*[｜|]*\s*invoke\s*>/giu;
  const parameterPattern = /<\s*[｜|]+\s*DSML\s*[｜|]+\s*parameter\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\s*\/\s*[｜|]*\s*DSML\s*[｜|]*\s*parameter\s*>/giu;
  const calls: ToolCall[] = [];
  for (const invokeMatch of content.matchAll(invokePattern)) {
    const name = invokeMatch[1]?.trim();
    const body = invokeMatch[2] ?? '';
    if (!name) continue;
    const args: Record<string, unknown> = {};
    let matchedAnyParameter = false;
    for (const parameterMatch of body.matchAll(parameterPattern)) {
      matchedAnyParameter = true;
      const parameterName = parameterMatch[1]?.trim();
      if (!parameterName) continue;
      const isRawString = (parameterMatch[2] ?? 'true') === 'true';
      const rawValue = parameterMatch[3] ?? '';
      if (isRawString) {
        args[parameterName] = rawValue;
        continue;
      }
      // Structured payload: strict JSON first, tolerant repair as fallback.
      try {
        args[parameterName] = JSON.parse(rawValue.trim());
      } catch {
        const repaired = extractFirstJsonObjectTolerant(rawValue);
        args[parameterName] = repaired !== undefined ? repaired : rawValue.trim();
      }
    }
    if (!matchedAnyParameter) continue; // 不完整的调用块不猜测执行
    calls.push({
      name,
      arguments: args,
      id: `dscall_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    });
  }
  return calls;
}

/**
 * Tolerant JSON extraction for model output (2026-08-22).
 *
 * Real-world text-protocol models emit slightly broken JSON: stray trailing
 * characters, or output truncated mid-object by an output-token ceiling.
 * Strategy: (1) balanced scan for the first complete top-level object;
 * (2) if the object never closes, repair the truncated fragment by closing
 * any open string/array/object in reverse order.
 */
function extractFirstJsonObjectTolerant(text: string): unknown | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  // Pass 1: balanced scan — take the first syntactically complete object.
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); continue; }
    if ((ch === '}' || ch === ']') && stack.length > 0 && stack[stack.length - 1] === ch) {
      stack.pop();
      if (stack.length === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
      }
    }
  }

  // Pass 2: repair a truncated fragment (close open string/array/object).
  const repaired = text.slice(start);
  inString = false;
  escaped = false;
  const openStack: string[] = [];
  for (let index = 0; index < repaired.length; index += 1) {
    const ch = repaired[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') openStack.push(ch === '{' ? '}' : ']');
    else if ((ch === '}' || ch === ']') && openStack.length > 0 && openStack[openStack.length - 1] === ch) openStack.pop();
  }
  let suffix = '';
  if (inString) suffix += '"';
  while (openStack.length > 0) suffix += openStack.pop();
  try { return JSON.parse(repaired + suffix); } catch { /* fall through to jsonrepair at the caller */ }
  // 最终兜底：jsonrepair 处理错配闭合、尾随杂散字符等模型生成瑕疵。
  try { return JSON.parse(jsonrepair(repaired)); } catch { return undefined; }
}

/**
 * Parse a text-protocol tool call from model output.
 * Tolerates surrounding prose / fenced code blocks / minor model typos and
 * output truncation via the tolerant extractor above.
 * Returns a ToolCall if the content is (or contains) such JSON, else null.
 */
export function parseTextToolCall(content: string): ToolCall | null {
  const text = content.trim();
  if (!text) return null;
  const candidates: unknown[] = [];
  // Fenced ```json ... ```
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/u);
  if (fenced?.[1]) {
    try { candidates.push(JSON.parse(fenced[1])); } catch { /* fall through to tolerant path */ }
  }
  try { candidates.push(JSON.parse(jsonrepair(text))); } catch { /* jsonrepair 失败则仅依赖容错扫描 */ }
  const tolerant = extractFirstJsonObjectTolerant(text);
  if (tolerant !== undefined) candidates.push(tolerant);

  for (const parsedUnknown of candidates) {
    if (typeof parsedUnknown !== 'object' || parsedUnknown === null || Array.isArray(parsedUnknown)) continue;
    const parsed = parsedUnknown as { tool?: unknown; args?: unknown; arguments?: unknown };
    // Only recognize the {"tool": "...", "args": {...}} shape from
    // injectToolPrompt. We intentionally do NOT accept "name" as a tool
    // indicator — that would misparse ordinary JSON (e.g. skill definitions
    // that happen to have a "name" field) as tool calls.
    if (typeof parsed.tool !== 'string' || !parsed.tool) continue;
    const rawArgs = parsed.args ?? parsed.arguments ?? {};
    const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs as Record<string, unknown> : {};
    return {
      name: parsed.tool,
      arguments: args,
      id: `textcall_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    };
  }
  return null;
}
