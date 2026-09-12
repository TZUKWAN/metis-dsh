/**
 * METIS 统一 Tool Error Contract（指令十三）。
 *
 * 领域级失败（可预期、需要向模型解释的失败）以 `{ ok: false, error }` 的
 * canonical 形态返回；不可预期的程序缺陷继续向上抛出，由 DSH 工具管线
 * 物化为 isError 结果。两类失败在模型视角都有稳定语义。
 */

export const METIS_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'NETWORK_TIMEOUT',
  'RATE_LIMITED',
  'VERIFICATION_FAILED',
  'STORAGE_FAILURE',
  'PERMISSION_DENIED',
  'CANCELLED',
] as const

export type MetisErrorCode = (typeof METIS_ERROR_CODES)[number]

export interface MetisErrorBody {
  code: MetisErrorCode
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface MetisErrorResult {
  ok: false
  error: MetisErrorBody
}

const RETRYABLE_BY_DEFAULT: ReadonlyArray<MetisErrorCode> = [
  'PROVIDER_UNAVAILABLE', 'NETWORK_TIMEOUT', 'RATE_LIMITED',
]

export function metisError(
  code: MetisErrorCode,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
): MetisErrorResult {
  if (!(METIS_ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`unknown METIS error code: ${code}`)
  }
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: options.retryable ?? RETRYABLE_BY_DEFAULT.includes(code),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  }
}

/** 边界归一化：模型经常把 JSON 编码为字符串或传单个对象。按契约归一。 */
export function normalizeJsonRecordArg(value: unknown, field: string): Record<string, unknown> {
  let input: unknown = value
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { throw new Error(`${field} 字符串不是合法 JSON。`) }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${field} 必须是对象。`)
  }
  return input as Record<string, unknown>
}

/** 数组参数归一化：接受数组；单个对象按单元素数组处理；空数组语义由调用方决定。 */
export function normalizeJsonArrayArg(value: unknown, field: string): unknown[] {
  let input: unknown = value
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { throw new Error(`${field} 字符串不是合法 JSON。`) }
  }
  return Array.isArray(input) ? input : [input]
}

export function requireStringArg(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field} 必须是非空字符串。`)
  return text
}
