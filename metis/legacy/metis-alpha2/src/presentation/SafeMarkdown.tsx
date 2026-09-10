import { Children, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { inspectExternalNavigationUrl } from '../../engine/security/ExternalNavigation';
import { presentDiagnosticText, type PresentationLocale } from './executionPresentation';

export type SafeMarkdownMode = 'normal' | 'diagnostic';

export interface SafeMarkdownProps {
  content: string;
  uiMode?: SafeMarkdownMode;
  locale: PresentationLocale;
  codeComponent?: Components['code'];
  /** Optional handler for doi.org links — opens the paper inside Metis. */
  onOpenPaper?: (doi: string) => void;
}

interface MarkdownNode {
  type?: string;
  value?: unknown;
  alt?: unknown;
  title?: unknown;
  children?: MarkdownNode[];
}

const ALLOWED_ELEMENTS = [
  'p', 'br', 'em', 'strong', 'del', 'blockquote', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img',
];

const MARKDOWN_URI_PATTERN = /\b(?:https?|file|javascript|data|vbscript):[^\s<>"'|)\]]+/gi;
const LOCAL_PATH_PATTERN = /(^|[\s([{"'`=,;])((?:[A-Za-z]:[\\/]|[\\]{1,2}|\/(?!\/))[^\s<>"'`|)\]}]+)/gm;

function externalLinkBlocked(locale: PresentationLocale): string {
  return locale === 'zh' ? '外部链接已阻止' : 'External link blocked';
}

function localPathHidden(locale: PresentationLocale): string {
  return locale === 'zh' ? '[本地路径已隐藏]' : '[Local path hidden]';
}

function diagnosticBlockedUrl(rawUrl: string, locale: PresentationLocale): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' && parsed.hostname) {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      const safeDisplay = presentDiagnosticText(parsed.toString());
      return locale === 'zh'
        ? `${safeDisplay}（敏感链接详情已移除）`
        : `${safeDisplay} (sensitive link details removed)`;
    }
  } catch {
    // Fall through to a fixed label. Raw parser errors and input are never shown.
  }
  return externalLinkBlocked(locale);
}

function sanitizeDiagnosticPaths(value: string): string {
  return value
    .replace(/(\b[A-Za-z]:[\\/]Users[\\/])[^\\/\s]+/gi, '$1[USER]')
    .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1[USER]')
    // Markdown consumes one of the two leading UNC backslashes while parsing
    // plain text.  Accept both the raw (\\\\host\\share) and parsed
    // (\\host\\share) shapes so neither can expose host/share names.
    .replace(/\\+[^\\\s]+\\[^\\\s]+/g, '\\\\[HOST]\\[SHARE]');
}

function presentMarkdownText(
  value: string,
  uiMode: SafeMarkdownMode,
  locale: PresentationLocale,
): string {
  const withoutUnsafeUris = value.replace(MARKDOWN_URI_PATTERN, (rawUrl) => {
    const decision = inspectExternalNavigationUrl(rawUrl);
    if (decision.ok) return decision.url;
    return uiMode === 'diagnostic'
      ? diagnosticBlockedUrl(rawUrl, locale)
      : externalLinkBlocked(locale);
  });
  if (uiMode === 'diagnostic') {
    const withoutSecrets = presentDiagnosticText(withoutUnsafeUris);
    return sanitizeDiagnosticPaths(withoutSecrets);
  }
  // Normal mode: hide local paths FIRST so LOCAL_PATH_PATTERN catches them
  // before presentDiagnosticText/sanitizeText redacts paths to [FILE].
  const withHiddenPaths = withoutUnsafeUris.replace(LOCAL_PATH_PATTERN, (_match, prefix: string) => (
    `${prefix}${localPathHidden(locale)}`
  ));
  return presentDiagnosticText(withHiddenPaths);
}

// eslint-disable-next-line react-refresh/only-export-components -- utility exported alongside component
export function presentSafeMarkdownText(
  value: string,
  uiMode: SafeMarkdownMode,
  locale: PresentationLocale,
): string {
  return presentMarkdownText(value, uiMode, locale);
}

function createRemarkPresentationBoundary(
  uiMode: SafeMarkdownMode,
  locale: PresentationLocale,
) {
  return function remarkPresentationBoundary() {
    return (tree: MarkdownNode) => {
      const visit = (node: MarkdownNode) => {
        if (
          (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code')
          && typeof node.value === 'string'
        ) {
          node.value = presentMarkdownText(node.value, uiMode, locale);
        }

        if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
          node.title = undefined;
        }

        if (node.type === 'image') {
          node.alt = uiMode === 'diagnostic' && typeof node.alt === 'string'
            ? presentMarkdownText(node.alt, uiMode, locale).slice(0, 160)
            : '';
        }

        node.children?.forEach(visit);
      };
      visit(tree);
    };
  };
}

/** Strictly returns a canonical clean HTTPS destination, or null. */
// eslint-disable-next-line react-refresh/only-export-components -- utility exported alongside component
export function sanitizeMarkdownUrl(rawUrl: string): string | null {
  const decision = inspectExternalNavigationUrl(rawUrl);
  return decision.ok ? decision.url : null;
}

function textOf(children: ReactNode): string {
  return Children.toArray(children).map((child) => (
    typeof child === 'string' || typeof child === 'number' ? String(child) : ''
  )).join('');
}

// Hook-free memoization: SafeMarkdown must stay callable as a plain function
// (tests and legacy call sites invoke it outside React render), so useMemo is
// not available here. Plugin arrays are cached per mode|locale (few combos);
// the components map uses a single-entry memo — streaming frames repeat the
// same props, which is exactly the hot path this protects.
const remarkPluginsCache = new Map<string, [typeof remarkGfm, ReturnType<typeof createRemarkPresentationBoundary>]>();

function getRemarkPlugins(resolvedMode: SafeMarkdownMode, locale: PresentationLocale) {
  const key = `${resolvedMode}|${locale}`;
  let plugins = remarkPluginsCache.get(key);
  if (!plugins) {
    plugins = [remarkGfm, createRemarkPresentationBoundary(resolvedMode, locale)];
    remarkPluginsCache.set(key, plugins);
  }
  return plugins;
}

let lastComponentsKey: {
  codeComponent?: Components['code'];
  locale: PresentationLocale;
  onOpenPaper?: (doi: string) => void;
  resolvedMode: SafeMarkdownMode;
} | null = null;
let lastComponents: Components | null = null;

export function SafeMarkdown({
  content,
  uiMode = 'normal',
  locale,
  codeComponent,
  onOpenPaper,
}: SafeMarkdownProps) {
  const resolvedMode: SafeMarkdownMode = uiMode === 'diagnostic' ? 'diagnostic' : 'normal';
  const remarkPlugins = getRemarkPlugins(resolvedMode, locale);
  const safeComponents: Components = (() => {
    const prev = lastComponentsKey;
    if (
      prev
      && prev.codeComponent === codeComponent
      && prev.locale === locale
      && prev.onOpenPaper === onOpenPaper
      && prev.resolvedMode === resolvedMode
      && lastComponents
    ) {
      return lastComponents;
    }
    lastComponentsKey = { codeComponent, locale, onOpenPaper, resolvedMode };
    lastComponents = {
    ...(codeComponent ? { code: codeComponent } : {}),
    a({ href, children }) {
      const safeUrl = typeof href === 'string' ? sanitizeMarkdownUrl(href) : null;
      if (!safeUrl) {
        const diagnosticLabel = presentMarkdownText(textOf(children), 'diagnostic', locale).trim();
        return (
          <span className="safe-markdown-link-blocked">
            {resolvedMode === 'diagnostic' && diagnosticLabel
              ? diagnosticLabel
              : externalLinkBlocked(locale)}
          </span>
        );
      }

      const rawLabel = textOf(children).trim();
      const label = /^https?:\/\//i.test(rawLabel) ? safeUrl : children;
      const doiMatch = /^https:\/\/doi\.org\/(10\..+)$/i.exec(safeUrl);
      return (
        <a
          href={safeUrl}
          rel="noopener noreferrer"
          draggable={false}
          onClick={(event) => {
            event.preventDefault();
            if (
              event.button !== 0
              || event.altKey
              || event.ctrlKey
              || event.metaKey
              || event.shiftKey
            ) return;
            if (doiMatch && onOpenPaper) {
              onOpenPaper(doiMatch[1]!);
              return;
            }
            const request = window.metis?.openExternal?.(safeUrl);
            if (request) void request.catch(() => undefined);
          }}
          onAuxClick={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
        >
          {label}
        </a>
      );
    },
    img({ alt }) {
      const fixedAriaLabel = locale === 'zh' ? '已阻止远程图片' : 'Remote image blocked';
      if (resolvedMode === 'normal') {
        return (
          <span className="safe-markdown-image-blocked" role="img" aria-label={fixedAriaLabel}>
            {locale === 'zh' ? '图片已阻止' : 'Image blocked'}
          </span>
        );
      }

      const safeAlt = presentMarkdownText(String(alt ?? ''), 'diagnostic', locale).slice(0, 160).trim();
      const label = safeAlt || fixedAriaLabel;
      return (
        <span className="safe-markdown-image-blocked" role="img" aria-label={label}>
          {locale === 'zh' ? `图片：${label}` : `Image: ${label}`}
        </span>
      );
    },
  };
    return lastComponents;
  })();

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      skipHtml
      allowedElements={ALLOWED_ELEMENTS}
      urlTransform={(url) => sanitizeMarkdownUrl(url) ?? ''}
      components={safeComponents}
    >
      {typeof content === 'string' ? content : ''}
    </ReactMarkdown>
  );
}
