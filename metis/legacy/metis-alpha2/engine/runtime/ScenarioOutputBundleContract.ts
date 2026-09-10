import { z } from 'zod';
import {
  OutputPlanSchema,
  type ResolvedRunManifest,
} from './PersonalizationRuntimeContract.js';

/** The authoritative output plan already validated on the resolved run manifest. */
export type ScenarioOutputPlan = NonNullable<ResolvedRunManifest['output']['plan']>;

export const SCENARIO_OUTPUT_BUNDLE_LIMITS = Object.freeze({
  rawTextChars: 1_250_000,
  primaryNameChars: 512,
  supportingNameChars: 512,
  criterionChars: 1_000,
  itemContentChars: 500_000,
  evidenceChars: 100_000,
  totalBodyChars: 1_000_000,
  supportingItems: 64,
  qualityItems: 64,
} as const);

// eslint-disable-next-line no-control-regex -- names and criteria are single-line contract fields
const UNSAFE_SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- body text permits tab/newline/CR but rejects other C0 and all C1 controls
const UNSAFE_MULTILINE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const OUTPUT_TEMPLATE_PLACEHOLDER = /<(?:complete (?:primary deliverable|supporting artifact)|specific evidence from the generated deliverables)>/iu;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u;

function meaningfulSingleLine(maxLength: number) {
  return z.string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, { message: 'Text cannot be blank' })
    .refine((value) => !UNSAFE_SINGLE_LINE_CONTROLS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function meaningfulBody(maxLength: number) {
  return z.string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, { message: 'Body cannot be blank' })
    .refine((value) => !UNSAFE_MULTILINE_CONTROLS.test(value), {
      message: 'Body contains unsafe control characters',
    })
    .refine((value) => !OUTPUT_TEMPLATE_PLACEHOLDER.test(value), {
      message: 'Body still contains an output-template placeholder',
    });
}

export const ScenarioOutputQualityStatusSchema = z.enum([
  'met',
  'partially_met',
  'unmet',
]);

export const ScenarioOutputPrimarySchema = z.strictObject({
  name: meaningfulSingleLine(SCENARIO_OUTPUT_BUNDLE_LIMITS.primaryNameChars),
  content: meaningfulBody(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars),
});

export const ScenarioOutputSupportingItemSchema = z.strictObject({
  name: meaningfulSingleLine(SCENARIO_OUTPUT_BUNDLE_LIMITS.supportingNameChars),
  content: meaningfulBody(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars),
});

export const ScenarioOutputQualityItemSchema = z.strictObject({
  criterion: meaningfulSingleLine(SCENARIO_OUTPUT_BUNDLE_LIMITS.criterionChars),
  status: ScenarioOutputQualityStatusSchema,
  evidence: meaningfulBody(SCENARIO_OUTPUT_BUNDLE_LIMITS.evidenceChars),
});

export const ScenarioOutputBundleSchema = z.strictObject({
  primary: ScenarioOutputPrimarySchema,
  supporting: z.array(ScenarioOutputSupportingItemSchema)
    .max(SCENARIO_OUTPUT_BUNDLE_LIMITS.supportingItems)
    .refine(
      (items) => new Set(items.map((item) => item.name)).size === items.length,
      { message: 'Supporting artifact names must be unique' },
    ),
  quality: z.array(ScenarioOutputQualityItemSchema)
    .max(SCENARIO_OUTPUT_BUNDLE_LIMITS.qualityItems)
    .refine(
      (items) => new Set(items.map((item) => item.criterion)).size === items.length,
      { message: 'Quality criteria must be unique' },
    ),
});

export type ScenarioOutputBundle = z.infer<typeof ScenarioOutputBundleSchema>;

export type ScenarioOutputBundleDecodeResult =
  | { ok: true; bundle: ScenarioOutputBundle }
  | { ok: false; code: 'invalid_json' | 'invalid_shape' | 'plan_mismatch'; detail?: string };

type JsonInspection = 'valid' | 'invalid' | 'duplicate_key';

/**
 * Lexically validates JSON and detects duplicate object keys before JSON.parse
 * can silently overwrite them. It intentionally produces no decoded value.
 */
function inspectJson(text: string): JsonInspection {
  let index = 0;
  let duplicateKey = false;

  const skipWhitespace = () => {
    // eslint-disable-next-line no-control-regex -- JSON permits exactly tab, LF, CR, and space as whitespace
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index]!)) index += 1;
  };

  const parseString = (): string | undefined => {
    if (text[index] !== '"') return undefined;
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        index += 1;
        try {
          const parsed = JSON.parse(text.slice(start, index)) as unknown;
          return typeof parsed === 'string' ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) return undefined;
        const escaped = text[index]!;
        if (escaped === 'u') {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) return undefined;
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped)) return undefined;
        index += 1;
        continue;
      }
      if (character.codePointAt(0)! <= 0x1f) return undefined;
      index += 1;
    }
    return undefined;
  };

  const parseLiteral = (literal: string): boolean => {
    if (!text.startsWith(literal, index)) return false;
    index += literal.length;
    return true;
  };

  const parseNumber = (): boolean => {
    const match = JSON_NUMBER.exec(text.slice(index));
    if (!match) return false;
    index += match[0].length;
    return true;
  };

  const parseArray = (): boolean => {
    if (text[index] !== '[') return false;
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return true;
    }
    while (index < text.length) {
      if (!parseValue()) return false;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return true;
      }
      if (text[index] !== ',') return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  };

  const parseObject = (): boolean => {
    if (text[index] !== '{') return false;
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return true;
    }
    const keys = new Set<string>();
    while (index < text.length) {
      const key = parseString();
      if (key === undefined) return false;
      if (keys.has(key)) duplicateKey = true;
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') return false;
      index += 1;
      skipWhitespace();
      if (!parseValue()) return false;
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return true;
      }
      if (text[index] !== ',') return false;
      index += 1;
      skipWhitespace();
    }
    return false;
  };

  const parseValue = (): boolean => {
    skipWhitespace();
    const character = text[index];
    if (character === '{') return parseObject();
    if (character === '[') return parseArray();
    if (character === '"') return parseString() !== undefined;
    if (character === 't') return parseLiteral('true');
    if (character === 'f') return parseLiteral('false');
    if (character === 'n') return parseLiteral('null');
    return character === '-' || (character !== undefined && /\d/u.test(character))
      ? parseNumber()
      : false;
  };

  try {
    skipWhitespace();
    const valid = parseValue();
    skipWhitespace();
    if (!valid || index !== text.length) return 'invalid';
    return duplicateKey ? 'duplicate_key' : 'valid';
  } catch {
    return 'invalid';
  }
}

function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  return match?.[1];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function meaningfulPlan(plan: ScenarioOutputPlan): boolean {
  return plan.primaryDeliverable.trim().length > 0
    && plan.supportingArtifacts.every((item) => item.trim().length > 0)
    && plan.qualityCriteria.every((item) => item.trim().length > 0);
}

function aggregateBodyChars(bundle: ScenarioOutputBundle): number {
  return bundle.primary.content.length
    + bundle.supporting.reduce((total, item) => total + item.content.length, 0)
    + bundle.quality.reduce((total, item) => total + item.evidence.length, 0);
}

/**
 * Decodes a final Agent response without throwing. Only raw JSON or a single
 * lowercase `json` fenced block is accepted; all prose wrappers are rejected.
 */
export function decodeScenarioOutputBundle(
  text: string,
  plan: ScenarioOutputPlan,
): ScenarioOutputBundleDecodeResult {
  if (typeof text !== 'string') return { ok: false, code: 'invalid_json' };

  let parsedPlan: ScenarioOutputPlan;
  try {
    const planResult = OutputPlanSchema.safeParse(plan);
    if (!planResult.success || !meaningfulPlan(planResult.data)) {
      return { ok: false, code: 'invalid_shape' };
    }
    parsedPlan = planResult.data;
  } catch {
    return { ok: false, code: 'invalid_shape' };
  }

  if (text.length > SCENARIO_OUTPUT_BUNDLE_LIMITS.rawTextChars) {
    return { ok: false, code: 'invalid_shape' };
  }
  const jsonText = extractJson(text);
  if (jsonText === undefined || jsonText.trim().length === 0) {
    return { ok: false, code: 'invalid_json' };
  }
  if (inspectJson(jsonText) !== 'valid') {
    return { ok: false, code: 'invalid_json' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch {
    return { ok: false, code: 'invalid_json' };
  }

  let bundle: ScenarioOutputBundle;
  try {
    const bundleResult = ScenarioOutputBundleSchema.safeParse(raw);
    if (!bundleResult.success) return { ok: false, code: 'invalid_shape' };
    bundle = bundleResult.data;
  } catch {
    return { ok: false, code: 'invalid_shape' };
  }

  if (bundle.primary.name !== parsedPlan.primaryDeliverable
    || !arraysEqual(bundle.supporting.map((item) => item.name), parsedPlan.supportingArtifacts)
    || !arraysEqual(bundle.quality.map((item) => item.criterion), parsedPlan.qualityCriteria)) {
    return { ok: false, code: 'plan_mismatch' };
  }

  if (aggregateBodyChars(bundle) > SCENARIO_OUTPUT_BUNDLE_LIMITS.totalBodyChars) {
    return { ok: false, code: 'invalid_shape' };
  }
  return { ok: true, bundle };
}

// ---------------------------------------------------------------------------
// Sectioned wire format
// ---------------------------------------------------------------------------
//
// 生产实证（2026-08-30，刘总场景 run 第 31 步三次 attempts 全部失败）：长篇
// 定稿（数万字符正文 + 6 个 supporting + 8 条 quality）让模型一次性手写合法
// JSON 几乎必然失败，且主要失败码是 plan_mismatch——模型产出了实质内容，
// 只是名称/标准被改写、排序不同而无法与 plan 严格等值。分段格式从机制上
// 移除这两个失败源：模型只写原始正文与近似标签，代码把标签解析归一到 plan
// 的规范名称、按 plan 顺序组包，再经严格 JSON 解码器复验——持久化合约与
// 校验强度完全不变（不降级格式或交付物要求），变化的只是模型要写的线格式。

const SECTION_MARKER = /^={3,}\s*METIS-(PRIMARY|SUPPORTING|QUALITY)(-CONTINUED)?\s*={3,}$/iu;

const FIELD_KEY_MAP: Readonly<Record<string, 'name' | 'criterion' | 'status'>> = {
  name: 'name',
  名称: 'name',
  criterion: 'criterion',
  标准: 'criterion',
  质量标准: 'criterion',
  status: 'status',
  结论: 'status',
  状态: 'status',
};

const FIELD_LINE = /^([a-zA-Z]+|名称|质量标准|标准|结论|状态)\s*[:：]\s*(.*)$/u;

type SectionKind = 'PRIMARY' | 'SUPPORTING' | 'QUALITY';

interface ParsedSection {
  kind: SectionKind;
  /** CONTINUED 段落：内容追加到同名条目之后（分页交付的续写机制）。 */
  continued: boolean;
  fields: Partial<Record<'name' | 'criterion' | 'status', string>>;
  body: string;
}

function hasSectionMarkers(text: string): boolean {
  return text.split(/\r?\n/u).some((line) => SECTION_MARKER.test(line.trim()));
}

/** Splits a sectioned document; returns undefined when no marker exists. */
function parseSectionedDocument(text: string): ParsedSection[] | undefined {
  if (!hasSectionMarkers(text)) return undefined;
  const rawSections: Array<{ kind: SectionKind; continued: boolean; lines: string[] }> = [];
  let current: { kind: SectionKind; continued: boolean; lines: string[] } | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const marker = SECTION_MARKER.exec(line.trim());
    if (marker) {
      current = {
        kind: marker[1]!.toUpperCase() as SectionKind,
        continued: Boolean(marker[2]),
        lines: [],
      };
      rawSections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    // 首个标记之前的非空内容直接忽略——指令已要求不写任何额外文字，
    // 模型偶尔写的前言不构成交付物。
  }
  return rawSections.map(({ kind, continued, lines }) => {
    const bodyLines = [...lines];
    while (bodyLines.length > 0 && bodyLines[0]!.trim().length === 0) bodyLines.shift();
    const fields: ParsedSection['fields'] = {};
    if (kind !== 'PRIMARY') {
      // 续写段只需标签行定位追加目标；status 在续写段里可省略（沿用首轮值）。
      const expected = kind === 'SUPPORTING' ? ['name'] : ['criterion', 'status'];
      while (bodyLines.length > 0) {
        const fieldMatch = FIELD_LINE.exec(bodyLines[0]!.trim());
        const key = fieldMatch ? FIELD_KEY_MAP[fieldMatch[1]!.toLowerCase()] ?? FIELD_KEY_MAP[fieldMatch[1]!] : undefined;
        if (!key || !expected.includes(key) || fields[key] !== undefined) break;
        fields[key] = fieldMatch![2]!.trim();
        bodyLines.shift();
      }
    }
    return { kind, continued, fields, body: bodyLines.join('\n').trim() };
  });
}

/** Normalizes a plan label for tolerant matching: whitespace, full-width
 *  forms, punctuation and case differences are all erased. */
function normalizePlanLabel(value: string): string {
  return value
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s　]+/gu, '');
}

/** Resolves a model-written label to exactly one canonical plan entry. */
function matchPlanLabel(label: string, candidates: readonly string[]): string | undefined {
  const trimmed = label.trim();
  const exact = candidates.filter((candidate) => candidate === label || candidate === trimmed);
  if (exact.length === 1) return exact[0];
  const target = normalizePlanLabel(trimmed);
  if (!target) return undefined;
  const normalized = candidates.filter((candidate) => normalizePlanLabel(candidate) === target);
  if (normalized.length === 1) return normalized[0];
  if (normalized.length > 1) return undefined;
  if (target.length >= 6) {
    const contained = candidates.filter((candidate) => {
      const normalizedCandidate = normalizePlanLabel(candidate);
      return normalizedCandidate.includes(target) || target.includes(normalizedCandidate);
    });
    if (contained.length === 1) return contained[0];
  }
  return undefined;
}

function parseQualityStatus(raw: string): 'met' | 'partially_met' | 'unmet' | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'met' || value === 'partially_met' || value === 'unmet') return value;
  if (value === 'partially met' || value === 'partially-met' || value === 'partial') return 'partially_met';
  if (value === 'not met') return 'unmet';
  if (/未满足|不满足|未达成/u.test(value)) return 'unmet';
  if (/部分满足|部分达成/u.test(value)) return 'partially_met';
  if (/满足|达成|符合/u.test(value)) return 'met';
  return undefined;
}

/** Resolves an index label like "S3" / "Q1" (optionally followed by the full
 *  name) to the corresponding plan entry. Index labels are the primary wire
 *  format taught to the model: copying a short label is far more reliable
 *  than copying a 60-character Chinese criterion verbatim (生产实证：模型把
 *  步骤自身验收标准错当成 quality criteria 标签，整轮 plan_mismatch). */
function matchIndexLabel(
  label: string,
  entries: readonly string[],
  prefix: 'S' | 'Q',
): string | undefined {
  const match = new RegExp(`^${prefix}(\\d{1,2})(?=$|[\\s.、:：)）-])`, 'iu').exec(label.trim());
  if (!match) return undefined;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < entries.length ? entries[index] : undefined;
}

/**
 * Sectioned-parse report: the matched portions of one model response.
 * Reports merge across delivery pages / correction attempts, so a follow-up
 * response only needs to deliver or continue the entries still missing
 * instead of regenerating the entire deliverable. `append` mode marks
 * CONTINUED sections: merging appends their content to the carried entry.
 */
export interface ReportEntry {
  content: string;
  mode: 'replace' | 'append';
}

export interface QualityReportEntry {
  status?: 'met' | 'partially_met' | 'unmet';
  evidence: string;
  mode: 'replace' | 'append';
}

export interface SectionedParseReport {
  /** First primary content block of this parse; CONTINUED blocks extend it. */
  primary?: ReportEntry;
  /** Canonical plan name -> entry. */
  supporting: Map<string, ReportEntry>;
  /** Canonical criterion -> assessment. */
  quality: Map<string, QualityReportEntry>;
  /** Sections whose labels could not be resolved to a plan entry (diagnostics). */
  unmatchedLabels: string[];
  /** Quality sections with an unparseable status (diagnostics). */
  statusErrors: string[];
}

/** Parses one sectioned response into a report; undefined when no markers exist. */
export function parseScenarioSectionedOutput(
  text: string,
  plan: ScenarioOutputPlan,
): SectionedParseReport | undefined {
  const sections = parseSectionedDocument(text);
  if (!sections) return undefined;
  const report: SectionedParseReport = {
    supporting: new Map(),
    quality: new Map(),
    unmatchedLabels: [],
    statusErrors: [],
  };
  for (const section of sections) {
    if (section.kind === 'PRIMARY') {
      if (section.body.trim().length === 0) continue;
      if (section.continued && report.primary) {
        report.primary = { content: `${report.primary.content}\n${section.body}`, mode: report.primary.mode };
      } else if (section.continued) {
        report.primary = { content: section.body, mode: 'append' };
      } else {
        report.primary = { content: section.body, mode: 'replace' };
      }
      continue;
    }
    if (section.kind === 'SUPPORTING') {
      const label = section.fields.name;
      const match = label
        ? matchIndexLabel(label, plan.supportingArtifacts, 'S') ?? matchPlanLabel(label, plan.supportingArtifacts)
        : undefined;
      if (!match || (!section.continued && report.supporting.has(match))) {
        report.unmatchedLabels.push(label ? `supporting "${label.trim().slice(0, 80)}"` : 'supporting section without a name field');
        continue;
      }
      const existing = report.supporting.get(match);
      if (section.continued && existing) {
        report.supporting.set(match, { content: `${existing.content}\n${section.body}`, mode: existing.mode });
      } else {
        report.supporting.set(match, { content: section.body, mode: section.continued ? 'append' : 'replace' });
      }
      continue;
    }
    const label = section.fields.criterion;
    const match = label
      ? matchIndexLabel(label, plan.qualityCriteria, 'Q') ?? matchPlanLabel(label, plan.qualityCriteria)
      : undefined;
    if (!match || (!section.continued && report.quality.has(match))) {
      report.unmatchedLabels.push(label ? `quality "${label.trim().slice(0, 80)}"` : 'quality section without a criterion field');
      continue;
    }
    const status = section.fields.status ? parseQualityStatus(section.fields.status) : undefined;
    if (!section.continued && !status) {
      report.statusErrors.push(`criterion "${match.slice(0, 60)}" has status "${(section.fields.status ?? '').slice(0, 40)}" (allowed: met, partially_met, unmet)`);
      continue;
    }
    const existing = report.quality.get(match);
    if (section.continued && existing) {
      report.quality.set(match, {
        status: status ?? existing.status,
        evidence: `${existing.evidence}\n${section.body}`,
        mode: existing.mode,
      });
    } else {
      report.quality.set(match, { status, evidence: section.body, mode: section.continued ? 'append' : 'replace' });
    }
  }
  return report;
}

function mergeEntry(carried: ReportEntry | undefined, latest: ReportEntry): ReportEntry {
  if (carried && latest.mode === 'append') {
    return { content: `${carried.content}\n${latest.content}`, mode: 'replace' };
  }
  return latest;
}

/** Latest page wins on replacements; CONTINUED (append) entries extend the
 *  carried content, so a long deliverable can span multiple responses. */
export function mergeSectionedParseReports(
  carried: SectionedParseReport,
  latest: SectionedParseReport,
): SectionedParseReport {
  const supporting = new Map(carried.supporting);
  for (const [key, entry] of latest.supporting) supporting.set(key, mergeEntry(supporting.get(key), entry));
  const quality = new Map(carried.quality);
  for (const [key, entry] of latest.quality) {
    const prior = quality.get(key);
    quality.set(key, prior && entry.mode === 'append'
      ? { status: entry.status ?? prior.status, evidence: `${prior.evidence}\n${entry.evidence}`, mode: 'replace' }
      : entry);
  }
  return {
    primary: latest.primary ? mergeEntry(carried.primary, latest.primary) : carried.primary,
    supporting,
    quality,
    unmatchedLabels: latest.unmatchedLabels,
    statusErrors: latest.statusErrors,
  };
}

/**
 * Assembles a bundle from a parse report. The assembled object is re-validated
 * through the strict JSON decoder, so schema, limits and plan matching stay
 * authoritative — no requirement is relaxed.
 */
export function bundleFromSectionedReport(
  report: SectionedParseReport,
  plan: ScenarioOutputPlan,
): ScenarioOutputBundleDecodeResult {
  let parsedPlan: ScenarioOutputPlan;
  try {
    const planResult = OutputPlanSchema.safeParse(plan);
    if (!planResult.success || !meaningfulPlan(planResult.data)) {
      return { ok: false, code: 'invalid_shape' };
    }
    parsedPlan = planResult.data;
  } catch {
    return { ok: false, code: 'invalid_shape' };
  }
  const problems: string[] = [];
  if (report.primary === undefined) {
    problems.push(`missing primary section for "${parsedPlan.primaryDeliverable}"`);
  }
  const missingSupporting = parsedPlan.supportingArtifacts.filter((name) => !report.supporting.has(name));
  if (missingSupporting.length > 0) {
    problems.push(`missing supporting: ${missingSupporting.map((name) => `"${name}"`).join(', ')}`);
  }
  const missingQuality = parsedPlan.qualityCriteria.filter((criterion) => !report.quality.has(criterion));
  if (missingQuality.length > 0) {
    problems.push(`missing quality criteria: ${missingQuality.map((name) => `"${name}"`).join(', ')}`);
  }
  const statusMissing = parsedPlan.qualityCriteria
    .filter((criterion) => report.quality.has(criterion) && !report.quality.get(criterion)!.status);
  if (statusMissing.length > 0) {
    problems.push(`quality sections missing a status line: ${statusMissing.map((name) => `"${name}"`).join(', ')} (allowed: met, partially_met, unmet)`);
  }
  if (report.unmatchedLabels.length > 0) problems.push(`unmatched sections: ${report.unmatchedLabels.join('; ')}`);
  if (report.statusErrors.length > 0) problems.push(...report.statusErrors);
  if (problems.length > 0) {
    return { ok: false, code: 'plan_mismatch', detail: problems.join(' | ') };
  }
  const assembled = {
    primary: { name: parsedPlan.primaryDeliverable, content: report.primary!.content },
    supporting: parsedPlan.supportingArtifacts.map((name) => ({ name, content: report.supporting.get(name)!.content })),
    quality: parsedPlan.qualityCriteria.map((criterion) => ({
      criterion,
      status: report.quality.get(criterion)!.status!,
      evidence: report.quality.get(criterion)!.evidence,
    })),
  };
  return decodeScenarioOutputBundle(JSON.stringify(assembled), parsedPlan);
}

/**
 * Decodes the sectioned wire format into a bundle. Labels are resolved to the
 * plan's canonical names and the assembled object is re-validated through the
 * strict JSON decoder, so schema, limits and plan matching stay authoritative.
 */
export function decodeSectionedOutputBundle(
  text: string,
  plan: ScenarioOutputPlan,
): ScenarioOutputBundleDecodeResult {
  if (typeof text !== 'string') return { ok: false, code: 'invalid_json' };
  let parsedPlan: ScenarioOutputPlan;
  try {
    const planResult = OutputPlanSchema.safeParse(plan);
    if (!planResult.success || !meaningfulPlan(planResult.data)) {
      return { ok: false, code: 'invalid_shape' };
    }
    parsedPlan = planResult.data;
  } catch {
    return { ok: false, code: 'invalid_shape' };
  }
  if (text.length > SCENARIO_OUTPUT_BUNDLE_LIMITS.rawTextChars) {
    return { ok: false, code: 'invalid_shape' };
  }
  const report = parseScenarioSectionedOutput(text, parsedPlan);
  if (!report) return { ok: false, code: 'invalid_json' };
  return bundleFromSectionedReport(report, parsedPlan);
}

/**
 * Final-step output decoding: strict JSON first, then the sectioned format.
 * When both fail, the sectioned result is preferred whenever markers exist
 * because its detail lists the exact missing/unmatched plan entries.
 */
export function decodeScenarioFinalOutput(
  text: string,
  plan: ScenarioOutputPlan,
): ScenarioOutputBundleDecodeResult {
  const strict = decodeScenarioOutputBundle(text, plan);
  if (strict.ok) return strict;
  if (typeof text !== 'string' || !hasSectionMarkers(text)) return strict;
  return decodeSectionedOutputBundle(text, plan);
}
