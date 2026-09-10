import type { ToolSpec } from '../engine/core/types.js';
import type { ToolHandler } from '../engine/tools/ToolDispatcher.js';

/**
 * Browser control tools for the Submission Workspace agent.
 *
 * These handlers drive the SAME WebContentsView the user sees in the middle
 * pane (injected via `createSubmissionBrowserTools`), so the agent and the
 * user always share one browser session — the core requirement of the
 * shared-browsing product model.
 */

export interface SubmissionBrowserPage {
  title: string;
  url: string;
  text: string;
  /** 站内链接（href 原样，可能为相对路径）。 */
  links: string[];
}

export interface SubmissionBrowserFacade {
  navigate(rawUrl: string): Promise<{ ok: boolean; url?: string; error?: string }>;
  extract(): Promise<{ ok: boolean; page?: SubmissionBrowserPage; error?: string }>;
  /**
   * 任务2 上下文隔离：带归属校验的提取。归属已知且与请求项目不一致 →
   * ok:false + scopeMismatch；归属未知 → 放行但 ownershipKnown:false，
   * 由调用方显式声明「归属未知」，不得默认属于请求项目。
   */
  extractScoped?(projectId: string | null): Promise<
    | { ok: true; page: SubmissionBrowserPage; ownershipKnown: boolean }
    | { ok: false; error: string; scopeMismatch?: boolean }
  >;
}

const READ_PAGE_CHARS = 9_000;
const READ_PAGE_LINKS = 24;

export function createSubmissionBrowserTools(browser: SubmissionBrowserFacade): { specs: ToolSpec[]; handlers: Array<[string, ToolHandler]> } {
  const readPageHandler: ToolHandler = async () => {
    try {
      const result = await browser.extract();
      if (!result.ok || !result.page) return `Error: cannot read the current page (${result.error ?? 'unknown'}).`;
      const page = result.page;
      const links = page.links.slice(0, READ_PAGE_LINKS).map((link) => `- ${link.slice(0, 100)}`).join('\n');
      return JSON.stringify({
        url: page.url,
        title: page.title,
        visibleText: page.text.slice(0, READ_PAGE_CHARS),
        visibleTextTruncated: page.text.length > READ_PAGE_CHARS,
        links,
      }, null, 2);
    } catch (error) {
      return `Error reading browser page: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const navigateHandler: ToolHandler = async (args) => {
    const url = String(args.url ?? '').trim();
    if (!url) return 'Error: url is required.';
    try {
      const result = await browser.navigate(url);
      if (!result.ok) return `Error: navigation failed (${result.error ?? 'unknown'}).`;
      const extract = await browser.extract();
      if (!extract.ok || !extract.page) return JSON.stringify({ navigatedTo: result.url ?? url, note: '页面已打开，但内容提取失败，可让用户直接查看。' }, null, 2);
      const page = extract.page;
      return JSON.stringify({
        navigatedTo: page.url,
        title: page.title,
        visibleText: page.text.slice(0, READ_PAGE_CHARS),
        links: page.links.slice(0, READ_PAGE_LINKS).map((link) => link.slice(0, 100)),
      }, null, 2);
    } catch (error) {
      return `Error: navigation failed (${error instanceof Error ? error.message : String(error)}).`;
    }
  };

  const specs: ToolSpec[] = [
    {
      name: 'submission_browser_read_page',
      description: '读取用户当前正在查看的浏览器页面：URL、标题、可见文本（截断）与主要链接。回答"这个期刊怎么样"类问题前必须先调用。',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'submission_browser_navigate',
      description: '在用户可见的共享浏览器中打开一个 URL（期刊官网、投稿须知、近期目录、万维/LetPub 页面等）。打开后自动返回页面内容。用户会看到整个浏览过程。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的完整 https URL' } },
        required: ['url'],
      },
    },
  ];

  return {
    specs,
    handlers: [
      ['submission_browser_read_page', readPageHandler],
      ['submission_browser_navigate', navigateHandler],
    ],
  };
}
