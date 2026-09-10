/**
 * MarketService — 技能 / MCP 市场源检索（主进程）。
 *
 * 已验证的只读源：GitHub、SkillsMP 技能搜索、mcpmarket.cn MCP 搜索/详情、
 * mcpworld.com（百度 MCP 市场）搜索/详情。SkillsMP 没有匿名安装 API，技能
 * 安装仍走其返回的 GitHub 源；mcpmarket.cn / mcpworld.com 详情基于公开数据
 * 由用户确认 stdio 命令后生成 MCP 配置（不伪装来源站登录态安装）。
 * skillhub.cn（SPA 回落 HTML，无匿名读 API）与 mcpmarket.com（Vercel 边缘
 * 防护 403/429）未形成可验证公开 API，不接入。
 * 令牌：GitHub 令牌从加密凭据库按 ${secret:MARKET_GITHUB_TOKEN} 读取；
 * 其他源按其公开匿名限额请求并做低频只读访问。
 */
import type { PersonalizationSecretVault } from './PersonalizationSecretVault.js';

export type MarketKind = 'skill' | 'mcp';
export type MarketSource = 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld';

export interface MarketSearchItem {
  source: MarketSource;
  owner: string;
  repo: string;
  name: string;
  description: string;
  stars: number;
  updatedAt: string;
  url: string;
  detailUrl?: string;
  installUrl?: string;
  filePath?: string;
  sourceId?: string;
  installable?: boolean;
  defaultBranch: string;
  topics: string[];
}

export interface MarketSearchResponse {
  ok: boolean;
  code?: 'invalid_request' | 'network_error' | 'rate_limited' | 'not_found' | 'server_error';
  items?: MarketSearchItem[];
  usingToken?: boolean;
  source?: MarketSource;
}

export interface MarketFileResponse {
  ok: boolean;
  code?: 'invalid_request' | 'network_error' | 'rate_limited' | 'not_found' | 'server_error';
  path?: string;
  content?: string;
}

const GITHUB_API = 'https://api.github.com';
const SKILLSMP_API = 'https://skillsmp.com/api/v1/skills/search';
const MCPMARKET_API = 'https://mcpmarket.cn/api';
const MCPMARKET_WEB = 'https://mcpmarket.cn';
const MCPWORLD_API = 'https://www.mcpworld.com/api/mcp-market';
const MCPWORLD_WEB = 'https://www.mcpworld.com/server';
// mcpworld.com 的边缘校验要求浏览器 UA + 同站 Referer，实测匿名可读。
const MCPWORLD_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.mcpworld.com/',
};
const MAX_FILE_CHARS = 20_000;
const USER_AGENT = 'Metis-Research/0.1 (market browser)';

type MarketFailureCode = NonNullable<MarketSearchResponse['code']>;

function timestampString(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return typeof value === 'string' ? value : '';
}

function parseGithubSource(raw: unknown): {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
} | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLocaleLowerCase('en-US') !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0] ?? '';
    const repo = (parts[1] ?? '').replace(/\.git$/u, '');
    if (!owner || !repo) return null;
    if (parts[2] === 'tree' && parts[3]) {
      return { owner, repo, ref: parts[3], filePath: parts.slice(4).join('/') };
    }
    return { owner, repo, ref: 'main', filePath: '' };
  } catch {
    return null;
  }
}

interface GithubRepo {
  full_name?: unknown;
  name?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  pushed_at?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
  topics?: unknown;
  owner?: { login?: unknown };
}

export class MarketService {
  readonly #vault: (() => PersonalizationSecretVault | null) | null;

  constructor(vaultAccessor?: () => PersonalizationSecretVault | null) {
    this.#vault = vaultAccessor ?? null;
  }

  #githubToken(): string | null {
    const vault = this.#vault ? this.#vault() : null;
    if (!vault) return null;
    try {
      const value = vault.resolve('${secret:MARKET_GITHUB_TOKEN}');
      return value && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }

  async #fetchJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async #githubFetch(url: string): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const token = this.#githubToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return this.#fetchJson(url, headers);
  }

  static #failureCode(status: number): MarketFailureCode {
    if (status === 404) return 'not_found';
    if (status === 403 || status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'network_error';
  }

  /** 技能/MCP 搜索词条构造：topic 限定优先，空查询浏览热门。 */
  static #buildQueries(kind: MarketKind, rawQuery: string): string[] {
    const query = rawQuery.trim().slice(0, 200);
    if (kind === 'mcp') {
      return query
        ? [`${query} topic:mcp-server`, `${query} mcp`]
        : ['topic:mcp-server'];
    }
    return query
      ? [`${query} skill`, `${query} topic:agent-skill`]
      : ['topic:agent-skill', 'claude skills'];
  }

  async #searchGithub(kind: MarketKind, rawQuery: string): Promise<MarketSearchResponse> {
    const queries = MarketService.#buildQueries(kind, rawQuery);
    const seen = new Set<string>();
    const items: MarketSearchItem[] = [];
    let lastFailure: MarketFailureCode | undefined;
    for (const q of queries) {
      const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;
      let response: { status: number; body: unknown };
      try {
        response = await this.#githubFetch(url);
      } catch {
        lastFailure = 'network_error';
        continue;
      }
      if (response.status !== 200) {
        lastFailure = MarketService.#failureCode(response.status);
        continue;
      }
      const body = response.body as { items?: unknown } | null;
      const repos = Array.isArray(body?.items) ? (body!.items as GithubRepo[]) : [];
      for (const repo of repos) {
        const owner = typeof repo.owner?.login === 'string' ? repo.owner.login : '';
        const name = typeof repo.name === 'string' ? repo.name : '';
        const key = typeof repo.full_name === 'string' ? repo.full_name : `${owner}/${name}`;
        if (!owner || !name || seen.has(key)) continue;
        seen.add(key);
        items.push({
          source: 'github',
          owner,
          repo: name,
          name,
          description: typeof repo.description === 'string' ? repo.description : '',
          stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
          updatedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : '',
          url: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${owner}/${name}`,
          installUrl: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${owner}/${name}`,
          installable: true,
          defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
          topics: Array.isArray(repo.topics) ? repo.topics.filter((topic): topic is string => typeof topic === 'string').slice(0, 8) : [],
        });
      }
      if (items.length >= 5) break;
    }
    if (items.length === 0 && lastFailure && queries.length === 1) {
      return { ok: false, code: lastFailure, source: 'github' };
    }
    return { ok: true, items: items.slice(0, 30), usingToken: this.#githubToken() !== null, source: 'github' };
  }

  async #searchSkillsMp(rawQuery: string): Promise<MarketSearchResponse> {
    const query = rawQuery.trim();
    if (!query || query.length > 200) return { ok: false, code: 'invalid_request', source: 'skillsmp' };
    let response: { status: number; body: unknown };
    try {
      response = await this.#fetchJson(`${SKILLSMP_API}?q=${encodeURIComponent(query)}&limit=20&sortBy=stars`);
    } catch {
      return { ok: false, code: 'network_error', source: 'skillsmp' };
    }
    if (response.status !== 200) {
      return { ok: false, code: MarketService.#failureCode(response.status), source: 'skillsmp' };
    }
    const payload = response.body as { data?: { skills?: unknown } } | null;
    const skills = Array.isArray(payload?.data?.skills) ? payload.data.skills : [];
    const items: MarketSearchItem[] = [];
    for (const value of skills) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const github = parseGithubSource(item.githubUrl);
      const detailUrl = typeof item.skillUrl === 'string' ? item.skillUrl : undefined;
      const name = typeof item.name === 'string' ? item.name : '';
      if (!name || !github) continue;
      items.push({
        source: 'skillsmp',
        owner: github.owner,
        repo: github.repo,
        name,
        description: typeof item.description === 'string' ? item.description : '',
        stars: typeof item.stars === 'number' ? item.stars : 0,
        updatedAt: timestampString(item.updatedAt),
        url: typeof item.githubUrl === 'string' ? item.githubUrl : `https://github.com/${github.owner}/${github.repo}`,
        detailUrl,
        installUrl: typeof item.githubUrl === 'string' ? item.githubUrl : undefined,
        filePath: github.filePath || undefined,
        installable: true,
        defaultBranch: github.ref,
        topics: ['skillsmp', typeof item.contentLanguage === 'string' ? item.contentLanguage : ''].filter(Boolean),
      });
    }
    return { ok: true, items: items.slice(0, 30), usingToken: false, source: 'skillsmp' };
  }

  async #searchMcpMarket(rawQuery: string): Promise<MarketSearchResponse> {
    const query = rawQuery.trim().slice(0, 200);
    const url = `${MCPMARKET_API}/servers?page=1&per_page=20&search=${encodeURIComponent(query)}`;
    let response: { status: number; body: unknown };
    try {
      response = await this.#fetchJson(url);
    } catch {
      return { ok: false, code: 'network_error', source: 'mcpmarket_cn' };
    }
    if (response.status !== 200) {
      return { ok: false, code: MarketService.#failureCode(response.status), source: 'mcpmarket_cn' };
    }
    const payload = response.body as { servers?: unknown } | null;
    const servers = Array.isArray(payload?.servers) ? payload.servers : [];
    const items: MarketSearchItem[] = [];
    for (const value of servers) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const server = value as Record<string, unknown>;
      const id = typeof server._id === 'string' ? server._id : '';
      const name = typeof server.name === 'string' ? server.name : '';
      if (!id || !name) continue;
      const githubUrl = typeof server.url === 'string' && server.url.startsWith('https://github.com/') ? server.url : '';
      const github = parseGithubSource(githubUrl);
      items.push({
        source: 'mcpmarket_cn',
        owner: github?.owner ?? '',
        repo: github?.repo ?? name,
        name,
        description: typeof server.description === 'string' ? server.description : '',
        stars: typeof server.stars === 'number' ? server.stars : 0,
        updatedAt: timestampString(server.created_at),
        url: githubUrl || `${MCPMARKET_WEB}/server/${encodeURIComponent(id)}`,
        detailUrl: `${MCPMARKET_WEB}/server/${encodeURIComponent(id)}`,
        sourceId: id,
        installable: true,
        defaultBranch: github?.ref ?? 'main',
        topics: Array.isArray(server.categories) ? server.categories.filter((topic): topic is string => typeof topic === 'string').slice(0, 8) : [],
      });
    }
    return { ok: true, items: items.slice(0, 30), usingToken: false, source: 'mcpmarket_cn' };
  }

  async #searchMcpWorld(rawQuery: string): Promise<MarketSearchResponse> {
    const query = rawQuery.trim().slice(0, 200);
    const url = `${MCPWORLD_API}/servers?page=1&pageSize=20&wd=${encodeURIComponent(query)}`;
    let response: { status: number; body: unknown };
    try {
      response = await this.#fetchJson(url, MCPWORLD_HEADERS);
    } catch {
      return { ok: false, code: 'network_error', source: 'mcpworld' };
    }
    if (response.status !== 200) {
      return { ok: false, code: MarketService.#failureCode(response.status), source: 'mcpworld' };
    }
    const payload = response.body as { data?: { mcpList?: unknown } } | null;
    const blocks = Array.isArray(payload?.data?.mcpList) ? payload.data.mcpList : [];
    const items: MarketSearchItem[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const servers = (block as { servers?: unknown }).servers;
      if (!Array.isArray(servers)) continue;
      for (const value of servers) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const server = value as Record<string, unknown>;
        const id = typeof server.id === 'string' ? server.id : '';
        const name = typeof server.serverName === 'string' ? server.serverName : '';
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        const serverUrl = typeof server.serverUrl === 'string' ? server.serverUrl : '';
        const github = parseGithubSource(serverUrl);
        const creator = typeof server.creator === 'string' ? server.creator : '';
        items.push({
          source: 'mcpworld',
          owner: github?.owner || creator,
          repo: github?.repo ?? name,
          name,
          description: typeof server.description === 'string' ? server.description : '',
          stars: typeof server.star === 'number' ? server.star : 0,
          updatedAt: typeof server.updateTime === 'string' ? server.updateTime : '',
          url: serverUrl || `${MCPWORLD_WEB}/${encodeURIComponent(id)}`,
          detailUrl: `${MCPWORLD_WEB}/${encodeURIComponent(id)}`,
          sourceId: id,
          installable: true,
          defaultBranch: github?.ref ?? 'main',
          topics: Array.isArray(server.labels) ? server.labels.filter((label): label is string => typeof label === 'string').slice(0, 8) : ['mcpworld'],
        });
      }
    }
    return { ok: true, items: items.slice(0, 30), usingToken: false, source: 'mcpworld' };
  }

  async search(kind: MarketKind, rawQuery: string, source: MarketSource = 'github'): Promise<MarketSearchResponse> {
    if (typeof rawQuery !== 'string' || rawQuery.length > 200) return { ok: false, code: 'invalid_request', source };
    if (source === 'skillsmp') {
      if (kind !== 'skill') return { ok: false, code: 'invalid_request', source };
      return this.#searchSkillsMp(rawQuery);
    }
    if (source === 'mcpmarket_cn') {
      if (kind !== 'mcp') return { ok: false, code: 'invalid_request', source };
      return this.#searchMcpMarket(rawQuery);
    }
    if (source === 'mcpworld') {
      if (kind !== 'mcp') return { ok: false, code: 'invalid_request', source };
      return this.#searchMcpWorld(rawQuery);
    }
    return this.#searchGithub(kind, rawQuery);
  }

  /** 读取仓库文本文件（SKILL.md / README.md / package.json 等），内容截断。 */
  async readFile(owner: string, repo: string, filePath: string, ref: string): Promise<MarketFileResponse> {
    if (!/^[\w.-]+$/u.test(owner) || !/^[\w.-]+$/u.test(repo) || filePath.includes('..') || filePath.includes('\\') || filePath.startsWith('/')) {
      return { ok: false, code: 'invalid_request' };
    }
    const branch = ref && /^[\w./-]+$/u.test(ref) ? ref : 'main';
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
    let response: { status: number; body: unknown };
    try {
      response = await this.#githubFetch(url);
    } catch {
      return { ok: false, code: 'network_error' };
    }
    if (response.status !== 200) {
      return { ok: false, code: MarketService.#failureCode(response.status) };
    }
    const body = response.body as { content?: unknown; encoding?: unknown; download_url?: unknown } | null;
    if (typeof body?.content !== 'string' || body.encoding !== 'base64') {
      return { ok: false, code: 'server_error' };
    }
    let text: string;
    try {
      text = Buffer.from(body.content, 'base64').toString('utf8');
    } catch {
      return { ok: false, code: 'server_error' };
    }
    return { ok: true, path: filePath, content: text.slice(0, MAX_FILE_CHARS) };
  }

  /** 技能详情：GitHub 源读取 SKILL.md；SkillsMP 使用搜索结果中的 GitHub 路径。 */
  async readSkillDoc(
    owner: string,
    repo: string,
    ref: string,
    source: MarketSource = 'github',
    filePath?: string,
  ): Promise<MarketFileResponse> {
    if (source !== 'github' && source !== 'skillsmp') return { ok: false, code: 'invalid_request' };
    if (filePath) {
      const direct = await this.readFile(owner, repo, filePath, ref);
      if (direct.ok) return direct;
    }
    for (const candidate of ['SKILL.md', 'skill.md']) {
      const result = await this.readFile(owner, repo, candidate, ref);
      if (result.ok) return result;
    }
    return this.readFile(owner, repo, 'README.md', ref);
  }

  /** MCP 详情：GitHub 读取 README/package.json；mcpmarket.cn 读取公开详情 JSON 并尽力取 README；mcpworld.com 读取公开详情文档。 */
  async readMcpDocs(
    owner: string,
    repo: string,
    ref: string,
    source: MarketSource = 'github',
    sourceId?: string,
  ): Promise<{ readme: MarketFileResponse; packageJson: { ok: boolean; npmPackage?: string } }> {
    if (source === 'mcpmarket_cn') {
      if (!sourceId || !/^[a-z0-9]+$/iu.test(sourceId)) {
        return { readme: { ok: false, code: 'invalid_request' }, packageJson: { ok: false } };
      }
      let detail: Record<string, unknown> | null = null;
      try {
        const response = await this.#fetchJson(`${MCPMARKET_API}/servers/${encodeURIComponent(sourceId)}`);
        if (response.status === 200 && response.body && typeof response.body === 'object' && !Array.isArray(response.body)) {
          const body = response.body as Record<string, unknown>;
          detail = (body.server && typeof body.server === 'object' ? body.server : body) as Record<string, unknown>;
        } else if (response.status !== 200) {
          return { readme: { ok: false, code: MarketService.#failureCode(response.status) }, packageJson: { ok: false } };
        }
      } catch {
        return { readme: { ok: false, code: 'network_error' }, packageJson: { ok: false } };
      }
      if (!detail) {
        return { readme: { ok: false, code: 'server_error' }, packageJson: { ok: false } };
      }
      // 详情自带指向 GitHub contents API 的 README 地址，直接读取真实 README。
      const readmeUrl = typeof detail.readme_url === 'string' ? detail.readme_url : '';
      if (readmeUrl.startsWith('https://api.github.com/')) {
        try {
          const response = await this.#githubFetch(readmeUrl);
          if (response.status === 200) {
            const body = response.body as { content?: unknown; encoding?: unknown } | null;
            if (typeof body?.content === 'string' && body.encoding === 'base64') {
              const text = Buffer.from(body.content, 'base64').toString('utf8');
              return {
                readme: { ok: true, path: 'README.md (mcpmarket.cn)', content: text.slice(0, MAX_FILE_CHARS) },
                packageJson: { ok: false },
              };
            }
          }
        } catch {
          // README 读取失败时回落到来源详情摘要。
        }
      }
      const overview = typeof detail.overview === 'string' ? detail.overview : '';
      const tools = Array.isArray(detail.tools)
        ? detail.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 40)
        : [];
      const mcpUrl = detail.mcp_url && typeof detail.mcp_url === 'object' && !Array.isArray(detail.mcp_url)
        ? detail.mcp_url as Record<string, unknown>
        : {};
      const summary = [
        `# ${typeof detail.name === 'string' ? detail.name : repo}`,
        overview || '',
        mcpUrl.sse_url ? `\n**SSE:** ${String(mcpUrl.sse_url)}` : '',
        mcpUrl.streamable_http_url ? `\n**Streamable HTTP:** ${String(mcpUrl.streamable_http_url)}` : '',
        tools.length ? `\n**Tools (${tools.length}):** ${tools.join('、')}` : '',
        '',
        '> 该来源未提供可读 README；以上为 mcpmarket.cn 公开详情摘要。',
      ].filter((line) => line !== '').join('\n');
      return {
        readme: { ok: true, path: 'mcpmarket.cn server detail', content: summary.slice(0, MAX_FILE_CHARS) },
        packageJson: { ok: false },
      };
    }
    if (source === 'mcpworld') {
      if (!sourceId || !/^[a-z0-9]+$/iu.test(sourceId)) {
        return { readme: { ok: false, code: 'invalid_request' }, packageJson: { ok: false } };
      }
      try {
        const response = await this.#fetchJson(`${MCPWORLD_API}/server/detail?id=${encodeURIComponent(sourceId)}`, MCPWORLD_HEADERS);
        if (response.status !== 200) {
          return { readme: { ok: false, code: MarketService.#failureCode(response.status) }, packageJson: { ok: false } };
        }
        const body = response.body as { data?: { detail?: unknown } } | null;
        const detailBody = body?.data?.detail;
        const detail = detailBody && typeof detailBody === 'object' && !Array.isArray(detailBody)
          ? detailBody as Record<string, unknown>
          : null;
        if (!detail) return { readme: { ok: false, code: 'server_error' }, packageJson: { ok: false } };
        const abstracts = Array.isArray(detail.abstract) ? detail.abstract : [];
        let markdown = '';
        for (const value of abstracts) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const entry = value as Record<string, unknown>;
          if (entry.key === 'detail_en' && typeof entry.value === 'string') {
            markdown = entry.value;
            break;
          }
        }
        if (!markdown) {
          markdown = typeof detail.description === 'string' ? detail.description : '';
        }
        let npmPackage: string | undefined;
        if (owner && repo) {
          const pkg = await this.readFile(owner, repo, 'package.json', ref);
          if (pkg.ok && pkg.content) {
            try {
              const parsed = JSON.parse(pkg.content) as { name?: unknown };
              if (typeof parsed.name === 'string' && parsed.name.trim()) npmPackage = parsed.name.trim();
            } catch {
              // 非法 package.json 时忽略，仅缺省建议命令。
            }
          }
        }
        return {
          readme: { ok: true, path: 'mcpworld.com server detail', content: markdown.slice(0, MAX_FILE_CHARS) },
          packageJson: { ok: Boolean(npmPackage), npmPackage },
        };
      } catch {
        return { readme: { ok: false, code: 'network_error' }, packageJson: { ok: false } };
      }
    }
    if (source !== 'github') return { readme: { ok: false, code: 'invalid_request' }, packageJson: { ok: false } };
    const readme = await this.readFile(owner, repo, 'README.md', ref);
    const pkg = await this.readFile(owner, repo, 'package.json', ref);
    let npmPackage: string | undefined;
    if (pkg.ok && pkg.content) {
      try {
        const parsed = JSON.parse(pkg.content) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name.trim()) npmPackage = parsed.name.trim();
      } catch {
        // 非法 package.json 时忽略，仅缺省建议命令。
      }
    }
    return { readme, packageJson: { ok: pkg.ok, npmPackage } };
  }
}
