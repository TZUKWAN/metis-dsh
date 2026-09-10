export type PresentationLocale = 'en' | 'zh';

export interface ApprovalPresentation {
  action: string;
  summary: string;
}

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const FILE_PATH_REDACTED = '[FILE]';

// ── Structured span-based sanitizer ──
//
// Design: every candidate (URL, Markdown, API path, absolute path, date,
// ratio, relative path, HTML close tag) is matched at the current cursor
// in priority order. Higher-priority spans (real filesystem paths) win over
// lower-priority protection spans (date/ratio/relative/API) when their
// ranges overlap, because the path scanner consumes the whole token first.
// Markdown syntax is preserved while its target is recursively processed.
// No string placeholders are injected into untrusted text, so user literals
// such as [[METIS_URL:0]] or U+E000 homoglyphs round-trip unchanged.

interface SanitizeOptions {
  sanitizeUrls: boolean;
}

const URL_RE = new RegExp(String.raw`^(?:(?!file:)[A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s"'<>|]+`, 'i');
const FILE_URL_RE = /^file:\/\/?[^\s"'<>|]+/i;
const MD_IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/;
const MD_LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/;
const DATE_RE = /^\d{4}[/-]\d{2}[/-]\d{2}/;
const RATIO_RE = /^\d+\s*\/\s*\d+/;
const RELATIVE_RE = /^\.{1,2}[/][^\s"'<>|)]*/;
const HTML_CLOSE_RE = /^<\/[A-Za-z][A-Za-z0-9]*>/;
const API_PATH_RE = /^\/(?:api|v\d+)\/[^\s"'<>|)]+/i;
const WIN_DRIVE_START = /^[A-Za-z]:[\\/]/;
const UNC_START = /^\\{2,}/;

function isApiContext(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 40), start);
  return /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|FETCH|API|ENDPOINT)\b/i.test(prefix);
}

function isLocalFileContext(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 40), start);
  return /\b(OPEN|READ|LOCAL\s+FILE|LOAD|SAVE|FILE|PATH|WRITE|DOWNLOAD)\b/i.test(prefix);
}

function classifyPosixPath(match: string, text: string, start: number): 'redact' | 'preserve' {
  // CJK 开头的斜杠 token 不是 POSIX 路径（2026-08-29 刘总报告）：中文工作流
  // 步骤名「父名 / 子名」、中文正文「词 / 词」此前在这里被整体吞成 [FILE]，
  // 看板任务名随之显示为「父名 [FILE]」。真实 POSIX 路径段几乎不以 CJK 开头；
  // 带盘符/UNC/home 等特征的路径仍由其余分支正常脱敏。
  if (/^\/\s*[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(match)) {
    return 'preserve';
  }
  const localPrefix = /^\/(?:home|tmp|Users|etc|usr|var|private|projects|root|opt|bin|lib|sbin|boot|dev|proc|sys|mnt|media|Volumes)(?:[/]|$)/i;
  if (localPrefix.test(match)) return 'redact';
  if (/^\/[a-zA-Z0-9._-]+$/.test(match)) return 'redact';
  if (/^\/(?:docs|img|assets|static|public|images|css|js|favicon)(?:[/]|$)/i.test(match)) {
    return 'preserve';
  }
  if (/^\/(?:api|v\d+)\//i.test(match)) {
    if (isApiContext(text, start)) return 'preserve';
    if (/\.[a-zA-Z0-9]{1,10}$/i.test(match) || /\b(PRIVATE|SECRET|CONFIDENTIAL)\b/i.test(match)) {
      return 'redact';
    }
    return 'preserve';
  }
  if (isLocalFileContext(text, start)) return 'redact';
  return 'redact';
}

function classifyPath(match: string, text: string, start: number): 'redact' | 'preserve' | null {
  if (/^file:/i.test(match)) return 'redact';
  if (WIN_DRIVE_START.test(match)) return 'redact';
  if (UNC_START.test(match)) return 'redact';
  if (/^~\//.test(match)) return 'redact';
  if (/^\//.test(match)) return classifyPosixPath(match, text, start);
  return null;
}

function scanPath(text: string, start: number): { match: string; end: number } | null {
  const len = text.length;
  let i = start;

  if (text.startsWith('file:', i)) {
    i += 5;
  } else if (text.startsWith('~/', i)) {
    i += 2;
  } else if (i + 2 < len && WIN_DRIVE_START.test(text.slice(i, i + 3))) {
    i += 3;
  } else if (i + 1 < len && text[i] === "\\" && text[i + 1] === "\\") {
    i += 2;
    while (i < len && text[i] === "\\") i += 1;
  } else if (text[i] === '/' && (i + 1 >= len || text[i + 1] !== '/')) {
    if (i > 0) {
      const prev = text[i - 1]!;
      if (/[A-Za-z0-9.:]/.test(prev)) return null;
    }
    i += 1;
  } else {
    return null;
  }

  while (i < len) {
    const c = text[i]!;
    if (c === ',' || c === ';' || c === ':' || c === '|' || c === '"' || c === "'" || c === '<' || c === '>') {
      break;
    }
    if (c === ')') {
      const next = text[i + 1];
      if (next && (next === '/' || next === '\\' || /[A-Za-z0-9.]/.test(next))) {
        i += 1;
        continue;
      }
      break;
    }
    if (c === '.') {
      const next = text[i + 1];
      if (next && (next === '/' || next === '\\' || /[A-Za-z0-9.]/.test(next))) {
        i += 1;
        continue;
      }
      break;
    }
    if (c === ' ') {
      if (text[i + 1] === ' ') break;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) break;
    i += 1;
  }

  // Do not swallow a trailing plain word that merely follows the path.
  const lastSpace = text.lastIndexOf(' ', i - 1);
  if (lastSpace > start && /^[A-Za-z]+$/.test(text.slice(lastSpace + 1, i))) {
    i = lastSpace;
  }

  const match = text.slice(start, i);
  const decision = classifyPath(match, text, start);
  if (decision === 'redact') return { match, end: i };
  return null;
}

function processMarkdown(text: string, i: number, options: SanitizeOptions): { output: string; end: number } | null {
  const slice = text.slice(i);
  const image = MD_IMAGE_RE.exec(slice);
  const link = MD_LINK_RE.exec(slice);
  const m = image ?? link;
  if (!m) return null;
  const prefix = image ? '![' : '[';
  const alt = m[1] ?? '';
  const target = m[2] ?? '';
  const title = m[3];
  const end = i + m[0].length;
  const safeAlt = sanitizeText(alt, options);
  // Markdown link targets may contain URLs that must be sanitised even in
  // normal redaction mode, while filesystem paths are redacted as usual.
  const safeTarget = sanitizeText(target, { sanitizeUrls: true });
  const titlePart = title !== undefined ? ` "${title}"` : '';
  return { output: `${prefix}${safeAlt}](${safeTarget}${titlePart})`, end };
}

function sanitizeText(text: string, options: SanitizeOptions): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i);

    const urlMatch = URL_RE.exec(slice);
    if (urlMatch) {
      const raw = urlMatch[0];
      const replacement = options.sanitizeUrls ? sanitizeUrl(raw) : raw;
      out.push(replacement);
      i += raw.length;
      continue;
    }

    const fileMatch = FILE_URL_RE.exec(slice);
    if (fileMatch) {
      out.push('file://[FILE]');
      i += fileMatch[0].length;
      continue;
    }

    const md = processMarkdown(text, i, options);
    if (md) {
      out.push(md.output);
      i = md.end;
      continue;
    }

    const apiMatch = API_PATH_RE.exec(slice);
    if (apiMatch) {
      const raw = apiMatch[0];
      const hasApiContext = isApiContext(text, i);
      const hasLocalContext = isLocalFileContext(text, i);
      const suspicious = /\.[a-zA-Z0-9]{1,10}$/i.test(raw) || /\b(PRIVATE|SECRET|CONFIDENTIAL)\b/i.test(raw);
      if (hasApiContext || (!hasLocalContext && !suspicious)) {
        out.push(raw);
        i += raw.length;
        continue;
      }
    }

    const pathMatch = scanPath(text, i);
    if (pathMatch) {
      const replacement = /^file:/i.test(pathMatch.match) ? 'file://[FILE]' : FILE_PATH_REDACTED;
      out.push(replacement);
      i = pathMatch.end;
      continue;
    }

    const dateMatch = DATE_RE.exec(slice);
    if (dateMatch) {
      out.push(dateMatch[0]);
      i += dateMatch[0].length;
      continue;
    }

    const ratioMatch = RATIO_RE.exec(slice);
    if (ratioMatch) {
      out.push(ratioMatch[0]);
      i += ratioMatch[0].length;
      continue;
    }

    const relMatch = RELATIVE_RE.exec(slice);
    if (relMatch) {
      out.push(relMatch[0]);
      i += relMatch[0].length;
      continue;
    }

    const htmlMatch = HTML_CLOSE_RE.exec(slice);
    if (htmlMatch) {
      out.push(htmlMatch[0]);
      i += htmlMatch[0].length;
      continue;
    }

    out.push(text[i]!);
    i += 1;
  }
  return out.join('');
}

export function redactPath(text: string): string {
  return sanitizeText(text, { sanitizeUrls: false });
}

export function presentDiagnosticText(value: string): string {
  const sanitized = sanitizeText(value, { sanitizeUrls: true })
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
    .replace(COOKIE_PATTERN, `$1${REDACTED}`)
    .replace(JSON_SECRET_PATTERN, `$1"${REDACTED}"`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  return sanitized;
}
const ACTION_LABELS: Record<string, Record<PresentationLocale, string>> = {
  read_file: { en: 'Read a project file', zh: '读取项目文件' },
  read_multiple_files: { en: 'Read project files', zh: '读取项目文件' },
  write_file: { en: 'Save changes to a file', zh: '保存文件更改' },
  list_directory: { en: 'View a project folder', zh: '查看项目文件夹' },
  create_directory: { en: 'Create a project folder', zh: '创建项目文件夹' },
  execute_command: { en: 'Run a local operation', zh: '运行本地操作' },
  execute_code: { en: 'Run an analysis', zh: '运行研究分析' },
  run_experiment_script: { en: 'Run an analysis script', zh: '运行分析脚本' },
  search_files: { en: 'Search project files', zh: '搜索项目文件' },
  search_content: { en: 'Search project content', zh: '搜索项目内容' },
  search_library: { en: 'Search the research library', zh: '搜索资料库' },
  search_papers: { en: 'Search for research literature', zh: '检索研究文献' },
  arxiv_search: { en: 'Search arXiv', zh: '检索 arXiv 文献' },
  journal_directory_search: { en: 'Search journal directories', zh: '检索期刊目录' },
  journal_directory_detail: { en: 'Look up journal submission details', zh: '查询期刊投稿详情' },
  fulltext_search: { en: 'Search document text', zh: '检索文档全文' },
  read_pdf: { en: 'Read a PDF document', zh: '读取 PDF 文档' },
  import_papers: { en: 'Import research literature', zh: '导入研究文献' },
  import_by_doi: { en: 'Import literature by DOI', zh: '通过 DOI 导入文献' },
  import_by_arxiv: { en: 'Import literature from arXiv', zh: '从 arXiv 导入文献' },
  web_import: { en: 'Import a web source', zh: '导入网页资料' },



  delete_library_duplicates: { en: 'Remove duplicate literature', zh: '移除重复文献' },
  export_library: { en: 'Export the research library', zh: '导出资料库' },
  review_save: { en: 'Save a literature review', zh: '保存文献综述' },
  findings_add: { en: 'Add a research finding', zh: '添加研究发现' },
  findings_export: { en: 'Export research findings', zh: '导出研究发现' },
  project_meta_update: { en: 'Update project information', zh: '更新项目信息' },
  claim_manifest_add: { en: 'Add a research claim', zh: '添加研究论断' },
  claim_manifest_update: { en: 'Update a research claim', zh: '更新研究论断' },
  'agent.window_renewed': { en: 'Turn window limit reached; context auto-compressed and the run continues in a new window', zh: '已自动压缩上下文并继续执行（新的回合窗口）' },
  'agent.provider_failed': { en: 'Model service unreachable after repeated failures; stopped honestly', zh: '模型服务连续失败，已如实停止' },
  'agent.agent_run_active': { en: 'A research task is already running. Wait for it to finish (or cancel it on the task card) before starting a new one.', zh: '已有研究任务正在执行。请等待其完成（或在任务卡片上取消）后再发起新任务。' },
};

const SECRET_KEY_SOURCE = String.raw`[a-z0-9]*?(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|passphrase|client[_-]?secret|secret|private[_-]?key|signing[_-]?key|credential)`;
const AUTHORIZATION_PATTERN = /(\b(?:proxy[-_ ]?)?authorization\b\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s|,;]+/gi;
const COOKIE_PATTERN = /(\b(?:set-cookie|cookie)\b\s*[:=]\s*)[^\r\n|]+/gi;
const JSON_SECRET_PATTERN = new RegExp(
  String.raw`((?:"|')?${SECRET_KEY_SOURCE}(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)`,
  'gi',
);
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?:--)?\b${SECRET_KEY_SOURCE}\b\s*(?:=|\s)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s|,;&]+)`,
  'gi',
);
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi;

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'auth'
    || normalized === 'authorization'
    || normalized === 'proxyauthorization'
    || normalized.includes('apikey')
    || normalized.includes('password')
    || normalized.includes('passphrase')
    || normalized.includes('credential')
    || normalized.includes('privatekey')
    || normalized.includes('signingkey')
    || normalized.includes('accesskey')
    || normalized.endsWith('token')
    || normalized.startsWith('secret')
    || normalized.endsWith('secret')
    || normalized === 'cookie'
    || normalized === 'cookies'
    || normalized === 'setcookie';
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') {
      // File URIs encode local filesystem paths; remove the whole path token.
      return 'file://[FILE]';
    }
    // Avoid adding a bare '/' between host and query/fragment for root URLs.
    const pathname = parsed.pathname === '/' && (parsed.search || parsed.hash)
      ? ''
      : parsed.pathname;
    const base = `${parsed.protocol}//${parsed.host}${pathname}`;
    const query = parsed.search ? `?${REDACTED}` : '';
    const fragment = parsed.hash ? `#${REDACTED}` : '';
    return `${base}${query}${fragment}`;
  } catch {
    return REDACTED;
  }
}

/**
 * Retains technical context for diagnostic mode while removing credentials from
 * URLs, headers, command arguments, JSON-like payloads, and free-form errors.
 * Absolute filesystem paths are also scrubbed so that Error.message/stack and
 * tool payloads inherit the same redaction used in normal mode.
 */
function scrubDiagnosticValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return presentDiagnosticText(value);
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: presentDiagnosticText(value.message),
      ...(value.stack ? { stack: presentDiagnosticText(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDiagnosticValue(item, seen));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, item]) => {
        const renderedKey = String(key);
        return [
          renderedKey,
          isSecretKey(renderedKey)
            ? REDACTED
            : scrubDiagnosticValue(item, seen),
        ];
      }),
    );
  }
  if (value instanceof Set) {
    return [...value].map((item) => scrubDiagnosticValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED : scrubDiagnosticValue(item, seen),
    ]),
  );
}

export function presentDiagnosticValue(value: unknown): unknown {
  return scrubDiagnosticValue(value, new WeakSet<object>());
}

export function stringifyDiagnosticValue(value: unknown): string {
  const serialized = JSON.stringify(presentDiagnosticValue(value), null, 2);
  return serialized ?? 'null';
}

export function presentArtifactName(
  rawName: string,
  locale: PresentationLocale,
): string {
  const fallback = locale === 'zh' ? '研究成果' : 'Research output';
  // eslint-disable-next-line no-control-regex
  const trimmed = rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!trimmed) return fallback;

  let candidate = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.pathname;
    } catch {
      candidate = '';
    }
  } else {
    candidate = candidate.split(/[?#]/, 1)[0] ?? '';
  }

  const segments = candidate.split(/[\\/]/).filter(Boolean);
  const leaf = (segments.at(-1) ?? candidate).trim();
  if (!leaf || leaf === '.' || leaf === '..') return fallback;

  const scrubbed = presentDiagnosticText(leaf).replace(/\s+/g, ' ').trim();
  if (!scrubbed || scrubbed === REDACTED) return fallback;
  return scrubbed.length > 120 ? `${scrubbed.slice(0, 117)}…` : scrubbed;
}

function fallbackAction(toolName: string, locale: PresentationLocale): string {
  const lower = toolName.toLowerCase();
  if (lower.includes('search') || lower.includes('lookup') || lower.includes('find')) {
    return locale === 'zh' ? '执行研究检索' : 'Perform a research search';
  }
  if (lower.includes('read') || lower.includes('get') || lower.includes('list')) {
    return locale === 'zh' ? '读取研究资料' : 'Read research material';
  }
  if (lower.includes('write') || lower.includes('save') || lower.includes('add') || lower.includes('update')) {
    return locale === 'zh' ? '保存研究更改' : 'Save research changes';
  }
  if (lower.includes('delete') || lower.includes('remove')) {
    return locale === 'zh' ? '移除研究资料' : 'Remove research material';
  }
  if (lower.includes('export')) {
    return locale === 'zh' ? '导出研究成果' : 'Export research output';
  }
  return locale === 'zh' ? '执行研究操作' : 'Perform a research action';
}

export function presentExecutionAction(
  toolName: string,
  locale: PresentationLocale,
): string {
  return ACTION_LABELS[toolName]?.[locale] ?? fallbackAction(toolName, locale);
}

export function presentApprovalRequest(
  toolName: string,
  _toolArgs: Record<string, unknown>,
  locale: PresentationLocale,
): ApprovalPresentation {
  return {
    action: presentExecutionAction(toolName, locale),
    summary: locale === 'zh'
      ? '批准后，Metis 将仅执行上述研究操作。'
      : 'If approved, Metis will perform only the research action shown above.',
  };
}

export function presentExecutionError(
  error: unknown,
  locale: PresentationLocale,
  uiMode: 'normal' | 'diagnostic',
): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const sanitized = uiMode === 'diagnostic'
    ? presentDiagnosticText(raw)
    : redactPath(raw);
  if (uiMode === 'diagnostic') {
    return sanitized
      ? sanitized
      : locale === 'zh'
        ? '未知技术错误'
        : 'Unknown technical error';
  }

  const lower = sanitized.toLowerCase();
  if (lower.includes('agent_run_active') || lower.includes('已有研究任务正在执行')) {
    return locale === 'zh'
      ? '已有研究任务正在执行。请等待其完成（或在任务卡片上取消）后再发起新任务。'
      : 'A research task is already running. Wait for it to finish (or cancel it on the task card) before starting a new one.';
  }
  if (lower.includes('no_active_run')) {
    // 2026-08-29 刘总报告「中断之后直接无法继续」：应用重启后内存运行注册
    // 表为空，实时引导不可用；此时正确动作是从断点恢复，而不是报错。
    return locale === 'zh'
      ? '当前没有正在执行的运行（应用可能刚重启）。重新发送消息即可从断点继续。'
      : 'No run is currently active (the app may have just restarted). Send the message again to resume from the checkpoint.';
  }
  if (
    lower.includes('api key')
    || lower.includes('unauthorized')
    || lower.includes('authentication')
    || lower.includes('401')
    || lower.includes('403')
  ) {
    return locale === 'zh'
      ? '模型连接未通过验证。请在”设置 → 模型连接”中检查配置。'
      : 'The model connection could not be verified. Check Settings → Model Connection.';
  }
  if (
    lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('network')
    || lower.includes('fetch')
    || lower.includes('econn')
    || lower.includes('provider')
  ) {
    return locale === 'zh'
      ? '研究助手暂时无法连接。请检查网络与”模型连接”后重试。'
      : 'The research assistant could not connect. Check your network and Model Connection, then retry.';
  }
  if (lower.includes('not available') || lower.includes('unavailable')) {
    return locale === 'zh'
      ? '此研究操作当前不可用。请稍后重试。'
      : 'This research action is currently unavailable. Try again later.';
  }
  return locale === 'zh'
    ? '此研究操作未能完成。您可以重试，或在设置中开启开发者诊断查看详情。'
    : 'This research action could not be completed. Retry, or enable Developer Diagnostics in Settings for details.';
}