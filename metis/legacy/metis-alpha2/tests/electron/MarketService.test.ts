import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketService } from '../../electron/MarketService.js';

function response(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

const githubRepo = {
  full_name: 'owner/skill-repo',
  name: 'skill-repo',
  description: 'A skill repository',
  stargazers_count: 10,
  pushed_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/owner/skill-repo',
  default_branch: 'main',
  topics: ['agent-skill'],
  owner: { login: 'owner' },
};

describe('MarketService verified external sources', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps GitHub as the default source and maps repositories', async () => {
    fetchMock.mockResolvedValue(response({ items: [githubRepo] }));
    const result = await new MarketService().search('skill', 'pdf');
    expect(result).toMatchObject({ ok: true, source: 'github', items: [{ source: 'github', owner: 'owner', repo: 'skill-repo', installable: true }] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.github.com/search/repositories'),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }) }),
    );
  });

  it('maps the verified SkillsMP search response and preserves the GitHub skill path', async () => {
    fetchMock.mockResolvedValue(response({
      success: true,
      data: {
        skills: [{
          id: 'skill-1',
          name: 'seo',
          author: 'owner',
          description: 'SEO helper',
          githubUrl: 'https://github.com/owner/repo/tree/main/skills/seo',
          skillUrl: 'https://skillsmp.com/creators/owner/repo/skills-seo',
          stars: 12,
          updatedAt: 1781179941,
          contentLanguage: 'en',
        }],
      },
    }));
    const result = await new MarketService().search('skill', 'SEO', 'skillsmp');
    expect(result).toMatchObject({
      ok: true,
      source: 'skillsmp',
      items: [{
        source: 'skillsmp',
        owner: 'owner',
        repo: 'repo',
        filePath: 'skills/seo',
        detailUrl: 'https://skillsmp.com/creators/owner/repo/skills-seo',
        installUrl: 'https://github.com/owner/repo/tree/main/skills/seo',
        installable: true,
      }],
    });
    expect(fetchMock.mock.calls[0]![0]).toContain('skillsmp.com/api/v1/skills/search');
  });

  it('rejects empty SkillsMP search rather than issuing a wildcard request', async () => {
    const result = await new MarketService().search('skill', '', 'skillsmp');
    expect(result).toEqual({ ok: false, code: 'invalid_request', source: 'skillsmp' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps mcpmarket.cn anonymous search as installable MCP items (user-confirmed stdio command)', async () => {
    fetchMock.mockResolvedValue(response({
      current_page: 1,
      servers: [{
        _id: '67f018a890965e7bf66b06b9',
        name: 'github',
        by: 'github',
        description: 'GitHub MCP server',
        stars: 32315,
        categories: ['开发'],
        url: 'https://github.com/github/github-mcp-server',
        created_at: '2025-03-04T16:42:04Z',
      }],
    }));
    const result = await new MarketService().search('mcp', 'github', 'mcpmarket_cn');
    expect(result).toMatchObject({
      ok: true,
      source: 'mcpmarket_cn',
      items: [{
        source: 'mcpmarket_cn',
        sourceId: '67f018a890965e7bf66b06b9',
        name: 'github',
        installable: true,
        detailUrl: 'https://mcpmarket.cn/server/67f018a890965e7bf66b06b9',
      }],
    });
  });

  it('reads mcpmarket.cn detail README through its public readme_url', async () => {
    fetchMock.mockResolvedValueOnce(response({
      server: {
        _id: 'abc123',
        name: 'server',
        overview: 'An MCP server.',
        readme_url: 'https://api.github.com/repos/owner/server/contents/README.md?ref=main',
        tools: ['read', 'write'],
      },
    }));
    fetchMock.mockResolvedValueOnce(response({
      content: Buffer.from('# server README').toString('base64'),
      encoding: 'base64',
    }));
    const result = await new MarketService().readMcpDocs('owner', 'server', 'main', 'mcpmarket_cn', 'abc123');
    expect(result.readme.ok).toBe(true);
    expect(result.readme.content).toContain('# server README');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/owner/server/contents/README.md?ref=main',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }) }),
    );
  });

  it('falls back to an mcpmarket.cn detail summary when the README is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(response({
      server: { _id: 'abc123', name: 'server', overview: 'An MCP server.', tools: ['read'] },
    }));
    fetchMock.mockResolvedValueOnce(response({}, 200)); // readme_url 缺失时不会发起该请求
    const result = await new MarketService().readMcpDocs('', 'server', 'main', 'mcpmarket_cn', 'abc123');
    expect(result.readme.ok).toBe(true);
    expect(result.readme.content).toContain('An MCP server.');
    expect(result.readme.content).toContain('read');
  });

  it('maps the verified mcpworld.com search response (wd keyword) with installable items', async () => {
    fetchMock.mockResolvedValue(response({
      code: 0,
      data: {
        mcpList: [{
          query: 'total_score_all',
          total: 2,
          servers: [
            {
              id: '4f1044aeca34b80af7d337c0fda9f214',
              serverName: 'Multi_Agent_Orch',
              description: 'Multi-agent orchestration',
              serverUrl: 'https://github.com/shilpathota/Multi_Agent_Orch',
              star: 0,
              creator: 'shilpathota',
              updateTime: '2025.11.10',
              labels: ['Python'],
            },
            {
              id: 'deadbeefdeadbeefdeadbeefdeadbeef',
              serverName: 'rust-mcp-filesystem',
              description: 'Filesystem MCP',
              serverUrl: '',
              star: 5,
              creator: 'other',
              updateTime: '2025.10.01',
              labels: ['Rust'],
            },
          ],
        }],
      },
    }));
    const result = await new MarketService().search('mcp', 'filesystem', 'mcpworld');
    expect(result).toMatchObject({ ok: true, source: 'mcpworld' });
    expect(result.items).toHaveLength(2);
    expect(result.items![0]).toMatchObject({
      source: 'mcpworld',
      sourceId: '4f1044aeca34b80af7d337c0fda9f214',
      name: 'Multi_Agent_Orch',
      owner: 'shilpathota',
      repo: 'Multi_Agent_Orch',
      installable: true,
      detailUrl: 'https://www.mcpworld.com/server/4f1044aeca34b80af7d337c0fda9f214',
    });
    expect(result.items![1]).toMatchObject({ name: 'rust-mcp-filesystem', owner: 'other', url: 'https://www.mcpworld.com/server/deadbeefdeadbeefdeadbeefdeadbeef' });
    expect(fetchMock.mock.calls[0]![0]).toContain('wd=filesystem');
    expect(fetchMock.mock.calls[0]![1].headers.Referer).toBe('https://www.mcpworld.com/');
  });

  it('reads the mcpworld.com public detail markdown and the GitHub package name', async () => {
    fetchMock.mockResolvedValueOnce(response({
      code: 0,
      data: {
        detail: {
          id: '4f1044aeca34b80af7d337c0fda9f214',
          description: 'fallback text',
          abstract: [
            { key: 'other', value: 'ignored' },
            { key: 'detail_en', value: '# Real MCP docs\n\nbody' },
          ],
        },
      },
    }));
    fetchMock.mockResolvedValueOnce(response({
      content: Buffer.from('{"name":"@scope/mcp-server"}').toString('base64'),
      encoding: 'base64',
    }));
    const result = await new MarketService().readMcpDocs('shilpathota', 'Multi_Agent_Orch', 'main', 'mcpworld', '4f1044aeca34b80af7d337c0fda9f214');
    expect(result.readme.ok).toBe(true);
    expect(result.readme.content).toContain('# Real MCP docs');
    expect(result.packageJson).toMatchObject({ ok: true, npmPackage: '@scope/mcp-server' });
  });

  it('maps source HTTP failures and network failures', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'limit' }, 429));
    await expect(new MarketService().search('skill', 'x', 'skillsmp')).resolves.toMatchObject({ ok: false, code: 'rate_limited', source: 'skillsmp' });
    fetchMock.mockRejectedValueOnce(new Error('network_down'));
    await expect(new MarketService().search('mcp', 'x', 'mcpmarket_cn')).resolves.toMatchObject({ ok: false, code: 'network_error', source: 'mcpmarket_cn' });
    fetchMock.mockResolvedValueOnce(response({ code: 1 }, 403));
    await expect(new MarketService().search('mcp', 'x', 'mcpworld')).resolves.toMatchObject({ ok: false, code: 'rate_limited', source: 'mcpworld' });
  });
});
