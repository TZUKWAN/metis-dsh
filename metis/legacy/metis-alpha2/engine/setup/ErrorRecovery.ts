/**
 * Unified Error Recovery (METIS-306).
 *
 * Translates raw technical errors into a structured, user-actionable workbench state.
 * Every surfaced error carries: the phase it occurred in, its impact, what Metis already
 * did about it automatically, and the concrete next step for the user. This prevents white
 * screens, infinite loading, and silent failures (METIS-306 completion).
 *
 * Categorizes errors into: transient (auto-retry), auth (re-enter key), quota (wait/switch),
 * network (check connection), local-resource (free space / fix file), corrupt (restore from
 * backup), crash (restart). Each maps to a user-facing message + recommended action.
 */

export type ErrorPhase =
  | 'first_run' | 'provider_probe' | 'chat' | 'tool_call' | 'artifact_save'
  | 'runtime_prepare' | 'export' | 'unknown';

export type ErrorCategory =
  | 'transient' | 'auth' | 'quota' | 'network' | 'local_resource'
  | 'corrupt' | 'crash' | 'not_supported' | 'unknown';

export interface RecoveredError {
  /** Original technical message (for logs/diagnostics only). */
  technicalMessage: string;
  phase: ErrorPhase;
  category: ErrorCategory;
  /** User-facing message in plain language (METIS-107 dictionary). */
  userMessage: string;
  /** What this error breaks for the user. */
  impact: string;
  /** What Metis already did automatically (retry, fallback, etc.). */
  automaticAction: string;
  /** The concrete next step the user should take. */
  nextStep: string;
  /** Whether it's safe to continue working on other things. */
  recoverable: boolean;
}

/** Classify a raw error into a category based on signals in its message/status. */
export function classifyError(rawMessage: string, statusOrCode?: number | string): ErrorCategory {
  const m = rawMessage.toLowerCase();
  const code = typeof statusOrCode === 'number' ? statusOrCode : undefined;

  if (code === 401 || code === 403 || /401|403|unauthor|forbidden|invalid api key|无效.*密钥/i.test(rawMessage)) return 'auth';
  if (code === 429 || /429|rate limit|quota|too many requests|频率/i.test(rawMessage)) return 'quota';
  if (code && code >= 500 && code < 600) return 'transient';
  if (/timeout|timed out|超时|etimedout/i.test(rawMessage)) return 'transient';
  if (/enotfound|econnrefused|econnreset|enetwork|network|断网|无法连接|offline/i.test(rawMessage)) return 'network';
  if (/enospc|disk full|磁盘.*满|no space|空间不足/i.test(rawMessage)) return 'local_resource';
  if (/eacces|permission|权限/i.test(rawMessage)) return 'local_resource';
  if (/corrupt|损坏|invalid hash|malformed|checksum|hash mismatch/i.test(rawMessage)) return 'corrupt';
  if (/crash|segfault|aborted|崩溃|killed/i.test(rawMessage)) return 'crash';
  if (/not supported|不支持/i.test(m)) return 'not_supported';
  if (code === 404 || /not found|未找到|model.*not/i.test(rawMessage)) return 'not_supported';
  return 'unknown';
}

const RECOVERY: Record<ErrorCategory, Omit<RecoveredError, 'technicalMessage' | 'phase'>> = {
  transient: {
    category: 'transient',
    userMessage: '模型服务暂时不可用，正在自动重试。',
    impact: '当前这一步暂时无法完成。',
    automaticAction: 'Metis 已自动重试该请求。',
    nextStep: '请稍候；若持续失败，稍后再试或切换模型。',
    recoverable: true,
  },
  auth: {
    category: 'auth',
    userMessage: 'API 密钥无效或已过期。',
    impact: '无法与模型服务通信，所有 AI 功能暂停。',
    automaticAction: 'Metis 已停止发送请求，避免无效调用。',
    nextStep: '请在“设置”中重新输入有效的 API 密钥。',
    recoverable: true,
  },
  quota: {
    category: 'quota',
    userMessage: '已达到模型服务的调用频率或额度限制。',
    impact: '短期内无法继续调用模型。',
    automaticAction: 'Metis 已暂停请求，等待冷却。',
    nextStep: '请稍后再试，或在服务商处提升额度，或切换到其他可用模型。',
    recoverable: true,
  },
  network: {
    category: 'network',
    userMessage: '无法连接网络。',
    impact: '检索、模型对话等需要联网的功能不可用。',
    automaticAction: 'Metis 将在检测到网络恢复后继续。',
    nextStep: '请检查网络连接（代理、防火墙、VPN）后重试。',
    recoverable: true,
  },
  local_resource: {
    category: 'local_resource',
    userMessage: '本地资源不足（磁盘空间或文件权限）。',
    impact: '无法保存资料或成果。',
    automaticAction: 'Metis 已中止本次写入，避免产生半成品。',
    nextStep: '请清理磁盘空间或检查目标目录的写入权限后重试。',
    recoverable: true,
  },
  corrupt: {
    category: 'corrupt',
    userMessage: '文件或数据校验失败，可能已损坏。',
    impact: '该文件无法使用。',
    automaticAction: 'Metis 已拒绝该文件并保留备份。',
    nextStep: '请从备份恢复，或重新导入/重新生成该文件。',
    recoverable: true,
  },
  crash: {
    category: 'crash',
    userMessage: '处理过程意外终止。',
    impact: '当前操作未完成。',
    automaticAction: 'Metis 已捕获崩溃并记录日志。',
    nextStep: '请重试该操作；若反复出现，请重启 Metis。',
    recoverable: true,
  },
  not_supported: {
    category: 'not_supported',
    userMessage: '该功能在当前环境不可用。',
    impact: '此项高级功能无法使用。',
    automaticAction: 'Metis 已提供可用的替代路径。',
    nextStep: '请使用替代方案，或在“设置 > 高级”中查看环境要求。',
    recoverable: true,
  },
  unknown: {
    category: 'unknown',
    userMessage: '发生未知错误。',
    impact: '当前操作未能完成。',
    automaticAction: 'Metis 已记录错误详情。',
    nextStep: '请重试；若持续失败，请在“设置 > 高级 > 诊断”查看日志。',
    recoverable: true,
  },
};

/** Build a structured RecoveredError from a raw error. */
export function recoverError(rawMessage: string, phase: ErrorPhase, statusOrCode?: number | string): RecoveredError {
  const category = classifyError(rawMessage, statusOrCode);
  const base = RECOVERY[category];
  return { technicalMessage: rawMessage, phase, ...base };
}
