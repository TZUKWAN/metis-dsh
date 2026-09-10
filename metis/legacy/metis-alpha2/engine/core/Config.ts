/**
 * Centralized configuration for Metis Workbench Engine.
 *
 * Ported from metis/config.py.
 * All defaults are overridable via environment variables.
 */

const env = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const envInt = (key: string, fallback: number): number =>
  Number.parseInt(process.env[key] ?? String(fallback), 10);

const envFloat = (key: string, fallback: number): number =>
  Number.parseFloat(process.env[key] ?? String(fallback));

// ─── Model Defaults ───────────────────────────────────────────

export const DEFAULT_MODEL = env('METIS_MODEL', 'glm-4.7-flash');
export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;
export const DEFAULT_PROFILE = 'small' as const;
export const DEFAULT_WORKSPACE = '.';
export const DEFAULT_STATE_DB_DIR = '.metis';

// ─── Limits ───────────────────────────────────────────────────

export const MAX_CONTENT_LENGTH = 1_000_000;
export const MAX_TIMEOUT_MS = 1_800_000; // 30 minutes (刘总 2026-08-22：宁等完整结果，不中途掐断)
export const PER_TURN_TIMEOUT_MS = 120_000; // 2 minutes in milliseconds
// model.request 发出后每 N 毫秒向事件桥广播一次 model.waiting，
// 让 UI 能区分「在等」与「挂死」（2026-09-05 metis 无声卡死修复）。
export const MODEL_WAITING_HEARTBEAT_MS = 15_000;
// 单次 run 的总时间预算：单请求可以等满 MAX_TIMEOUT_MS（尊重「宁等完整结果」），
// 但「超时 × 重试」的组合不允许把一次 run 拖成数小时级挂死。
export const RUN_TIME_BUDGET_MS = MAX_TIMEOUT_MS;
export const TOOL_EXECUTION_TIMEOUT = 30;
export const MAX_TOOL_REPAIR_RETRIES = 1;
export const MAX_PARSER_REPAIR_RETRIES = 2;
export const MAX_TOOLS_PER_SESSION = 200;

// ─── Context ──────────────────────────────────────────────────

export const CONTEXT_CHARS_PER_TOKEN = 4;
export const CONTEXT_THRESHOLD = 0.8;
export const COMPRESS_PREVIEW_CHARS = 1500;

// ─── State / Storage ──────────────────────────────────────────

export const STATE_DB_FILENAME = 'state.db';
export const TOOL_RESULTS_DIR = '.metis/tool-results';
export const TOOL_DISPATCHER_WORKERS = envInt('METIS_TOOL_DISPATCHER_WORKERS', 4);
export const MAX_SAME_TOOL_PER_SESSION = envInt('METIS_MAX_SAME_TOOL_PER_SESSION', 20);

// ─── Temperature Strategy ─────────────────────────────────────

export const TEMP_BASE = envFloat('METIS_TEMP_BASE', 0.2);
export const TEMP_PER_TURN = envFloat('METIS_TEMP_PER_TURN', 0.05);
export const TEMP_REPAIR_BOOST = envFloat('METIS_TEMP_REPAIR_BOOST', 0.1);
export const TEMP_LOOP_BOOST = envFloat('METIS_TEMP_LOOP_BOOST', 0.15);
export const TEMP_MAX = envFloat('METIS_TEMP_MAX', 0.8);

// ─── Validation ───────────────────────────────────────────────

export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (DEFAULT_MAX_TURNS < 1) warnings.push(`DEFAULT_MAX_TURNS=${DEFAULT_MAX_TURNS} must be >= 1`);
  if (!(DEFAULT_TEMPERATURE >= 0 && DEFAULT_TEMPERATURE <= 2)) warnings.push(`DEFAULT_TEMPERATURE=${DEFAULT_TEMPERATURE} must be in [0, 2]`);
  if (MAX_CONTENT_LENGTH < 1000) warnings.push(`MAX_CONTENT_LENGTH=${MAX_CONTENT_LENGTH} too small (< 1000)`);
  if (MAX_TIMEOUT_MS < 5_000) warnings.push(`MAX_TIMEOUT_MS=${MAX_TIMEOUT_MS} too small (< 5s)`);
  if (PER_TURN_TIMEOUT_MS < 5_000) warnings.push(`PER_TURN_TIMEOUT_MS=${PER_TURN_TIMEOUT_MS} too small (< 5s)`);
  if (TOOL_EXECUTION_TIMEOUT < 1) warnings.push(`TOOL_EXECUTION_TIMEOUT=${TOOL_EXECUTION_TIMEOUT} too small (< 1s)`);
  if (PER_TURN_TIMEOUT_MS > MAX_TIMEOUT_MS) warnings.push(`PER_TURN_TIMEOUT_MS=${PER_TURN_TIMEOUT_MS} exceeds MAX_TIMEOUT_MS=${MAX_TIMEOUT_MS}`);
  if (MODEL_WAITING_HEARTBEAT_MS < 1_000) warnings.push(`MODEL_WAITING_HEARTBEAT_MS=${MODEL_WAITING_HEARTBEAT_MS} too small (< 1s)`);
  if (RUN_TIME_BUDGET_MS < PER_TURN_TIMEOUT_MS) warnings.push(`RUN_TIME_BUDGET_MS=${RUN_TIME_BUDGET_MS} smaller than PER_TURN_TIMEOUT_MS=${PER_TURN_TIMEOUT_MS}`);
  if (TOOL_EXECUTION_TIMEOUT > MAX_TIMEOUT_MS) warnings.push(`TOOL_EXECUTION_TIMEOUT=${TOOL_EXECUTION_TIMEOUT} exceeds MAX_TIMEOUT_MS=${MAX_TIMEOUT_MS}`);
  if (MAX_TOOLS_PER_SESSION < 1) warnings.push(`MAX_TOOLS_PER_SESSION=${MAX_TOOLS_PER_SESSION} must be >= 1`);
  if (CONTEXT_CHARS_PER_TOKEN < 1) warnings.push(`CONTEXT_CHARS_PER_TOKEN=${CONTEXT_CHARS_PER_TOKEN} must be >= 1`);
  if (!(CONTEXT_THRESHOLD >= 0.1 && CONTEXT_THRESHOLD <= 1)) warnings.push(`CONTEXT_THRESHOLD=${CONTEXT_THRESHOLD} must be in [0.1, 1.0]`);
  if (!(DEFAULT_PORT >= 1 && DEFAULT_PORT <= 65535)) warnings.push(`DEFAULT_PORT=${DEFAULT_PORT} must be in [1, 65535]`);
  if (MAX_TOOL_REPAIR_RETRIES < 0) warnings.push(`MAX_TOOL_REPAIR_RETRIES=${MAX_TOOL_REPAIR_RETRIES} must be >= 0`);
  if (MAX_PARSER_REPAIR_RETRIES < 0) warnings.push(`MAX_PARSER_REPAIR_RETRIES=${MAX_PARSER_REPAIR_RETRIES} must be >= 0`);
  if (!DEFAULT_MODEL) warnings.push('DEFAULT_MODEL is empty');
  if (!['micro_4k', 'micro_8k', 'micro_16k', 'small', 'balanced', 'deep', 'small_strict'].includes(DEFAULT_PROFILE)) warnings.push(`DEFAULT_PROFILE=${DEFAULT_PROFILE} is not a recognized profile`);

  return warnings;
}
