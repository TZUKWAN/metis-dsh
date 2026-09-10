/**
 * MarketBrowserPanel — 技能/MCP 市场浏览与安装测试（任务C/D）。
 * 覆盖：GitHub 搜索渲染、技能详情预览、skill_url 一键安装、
 * MCP 详情（npx 建议命令）与 stdio 定义安装、匿名限额提示。
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ITEM = {
  source: 'github' as const,
  owner: 'anthropics',
  repo: 'skill-pdf',
  name: 'skill-pdf',
  description: 'PDF extraction skill',
  stars: 1234,
  updatedAt: '2026-01-01T00:00:00Z',
  url: 'https://github.com/anthropics/skill-pdf',
  installUrl: 'https://github.com/anthropics/skill-pdf',
  installable: true,
  defaultBranch: 'main',
  topics: ['skill', 'pdf'],
};

const SKILLSMP_ITEM = {
  ...ITEM,
  source: 'skillsmp' as const,
  owner: 'owner',
  repo: 'repo',
  name: 'seo',
  description: 'SEO helper',
  stars: 12,
  url: 'https://github.com/owner/repo/tree/main/skills/seo',
  detailUrl: 'https://skillsmp.com/creators/owner/repo/skills-seo',
  installUrl: 'https://github.com/owner/repo/tree/main/skills/seo',
  filePath: 'skills/seo',
  defaultBranch: 'main',
  topics: ['skillsmp', 'en'],
};

const MCPMARKET_ITEM = {
  source: 'mcpmarket_cn' as const,
  owner: '',
  repo: 'github',
  name: 'github',
  description: 'GitHub MCP server',
  stars: 32315,
  updatedAt: '2025-03-04T16:42:04Z',
  url: 'https://mcpmarket.cn/server/67f018a890965e7bf66b06b9',
  detailUrl: 'https://mcpmarket.cn/server/67f018a890965e7bf66b06b9',
  sourceId: '67f018a890965e7bf66b06b9',
  installable: true,
  defaultBranch: 'main',
  topics: ['开发'],
};

const MCPWORLD_ITEM = {
  source: 'mcpworld' as const,
  owner: 'shilpathota',
  repo: 'Multi_Agent_Orch',
  name: 'Multi_Agent_Orch',
  description: 'Multi-agent orchestration',
  stars: 0,
  updatedAt: '2025.11.10',
  url: 'https://github.com/shilpathota/Multi_Agent_Orch',
  detailUrl: 'https://www.mcpworld.com/server/4f1044aeca34b80af7d337c0fda9f214',
  sourceId: '4f1044aeca34b80af7d337c0fda9f214',
  installable: true,
  defaultBranch: 'main',
  topics: ['Python'],
};

describe('MarketBrowserPanel', () => {
  let marketSearch: ReturnType<typeof vi.fn>;
  let marketReadSkillDoc: ReturnType<typeof vi.fn>;
  let marketReadMcpDocs: ReturnType<typeof vi.fn>;
  let applyPersonalizationExtension: ReturnType<typeof vi.fn>;
  let savePersonalization: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    marketSearch = vi.fn().mockResolvedValue({ ok: true, items: [ITEM], usingToken: false });
    marketReadSkillDoc = vi.fn().mockResolvedValue({ ok: true, path: 'SKILL.md', content: '# PDF skill\nExtracts text.' });
    marketReadMcpDocs = vi.fn().mockResolvedValue({
      readme: { ok: true, path: 'README.md', content: '# MCP server\nUsage: npx' },
      packageJson: { ok: true, npmPackage: '@example/mcp-server' },
    });
    applyPersonalizationExtension = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'skill_url',
      definition: { id: 'url:skills/skill-pdf', name: 'skill-pdf' },
    });
    savePersonalization = vi.fn().mockResolvedValue({
      ok: true,
      code: 'saved',
      definition: { id: 'generated:mcp/skill-pdf', kind: 'mcp', name: 'skill-pdf' },
    });
    Object.defineProperty(window, 'metis', {
      configurable: true,
      writable: true,
      value: {
        marketSearch,
        marketReadSkillDoc,
        marketReadMcpDocs,
        applyPersonalizationExtension,
        savePersonalization,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
  });

  it('默认 SkillsMP 源搜索并渲染结果与额度提示（GitHub 搜索入口已移除）', async () => {
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByTestId('market-search-input-skill'), { target: { value: 'pdf' } });
    fireEvent.click(screen.getByTestId('market-search-run-skill'));
    await waitFor(() => expect(marketSearch).toHaveBeenCalledWith({ kind: 'skill', query: 'pdf', source: 'skillsmp' }));
    expect(await screen.findByTestId('market-result-item')).toBeTruthy();
    expect(screen.getByText(/额度限制/u)).toBeTruthy();
  });

  it('SkillHub 源提供网站入口与按网址安装提示，不伪造搜索结果', async () => {
    const openExternal = vi.fn();
    Object.assign(window.metis, { openExternal });
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByTestId('market-source-skill'), { target: { value: 'skillhub' } });
    expect(await screen.findByTestId('market-skillhub-skill')).toBeTruthy();
    // 无公开 API：搜索按钮禁用，不发起搜索。
    expect((screen.getByTestId('market-search-run-skill') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('market-skillhub-open'));
    expect(openExternal).toHaveBeenCalledWith('https://www.skillhub.cn/');
    expect(marketSearch).not.toHaveBeenCalled();
  });

  it('技能详情：预览 SKILL.md 并一键安装（skill_url 受控安装器）', async () => {
    const onInstalled = vi.fn();
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={onInstalled} />);
    fireEvent.change(screen.getByTestId('market-search-input-skill'), { target: { value: 'pdf' } });
    fireEvent.click(screen.getByTestId('market-search-run-skill'));
    fireEvent.click(await screen.findByTestId('market-result-item'));
    await waitFor(() => expect(marketReadSkillDoc).toHaveBeenCalledWith({
      owner: 'anthropics',
      repo: 'skill-pdf',
      ref: 'main',
      source: 'github',
      filePath: undefined,
    }));
    expect(await screen.findByText(/Extracts text/u)).toBeTruthy();
    fireEvent.click(screen.getByTestId('market-install-skill'));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    const request = applyPersonalizationExtension.mock.calls[0]![0] as { mode: string; url: string };
    expect(request.mode).toBe('skill_url');
    expect(request.url).toBe('https://github.com/anthropics/skill-pdf/tree/main');
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('url:skills/skill-pdf'));
  });

  it('MCP 详情：package.json 推断 npx 建议命令并可安装 stdio 配置', async () => {
    const onInstalled = vi.fn();
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="mcp" zh definitions={[]} onInstalled={onInstalled} />);
    fireEvent.change(screen.getByTestId('market-search-input-mcp'), { target: { value: 'filesystem' } });
    fireEvent.click(screen.getByTestId('market-search-run-mcp'));
    fireEvent.click(await screen.findByTestId('market-result-item'));
    await waitFor(() => expect(marketReadMcpDocs).toHaveBeenCalledWith({
      owner: 'anthropics',
      repo: 'skill-pdf',
      ref: 'main',
      source: 'github',
      sourceId: undefined,
    }));
    const args = await screen.findByTestId('market-mcp-args');
    expect((args as HTMLTextAreaElement).value).toContain('@example/mcp-server');
    fireEvent.click(screen.getByTestId('market-install-mcp'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    const request = savePersonalization.mock.calls[0]![0] as { definition: Record<string, unknown>; expectedRevision: number };
    expect(request.expectedRevision).toBe(0);
    const definition = request.definition as Record<string, unknown>;
    expect(definition.kind).toBe('mcp');
    expect(definition.transport).toBe('stdio');
    expect(definition.command).toBe('npx');
    expect(definition.args).toEqual(['-y', '@example/mcp-server']);
    expect((definition.provenance as Record<string, unknown>).sourceUrl).toBe('https://github.com/anthropics/skill-pdf');
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('generated:mcp/skill-pdf'));
  });

  it('SkillsMP：选择来源、读取技能路径并复用 GitHub 安装地址', async () => {
    marketSearch = marketSearch.mockResolvedValueOnce({ ok: true, items: [SKILLSMP_ITEM], usingToken: false, source: 'skillsmp' });
    marketReadSkillDoc = marketReadSkillDoc.mockResolvedValueOnce({ ok: true, path: 'skills/seo/SKILL.md', content: '# SEO skill\\nOptimizes metadata.' });
    Object.assign(window.metis, { marketSearch, marketReadSkillDoc });
    const onInstalled = vi.fn();
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={onInstalled} />);
    fireEvent.change(screen.getByTestId('market-source-skill'), { target: { value: 'skillsmp' } });
    fireEvent.change(screen.getByTestId('market-search-input-skill'), { target: { value: 'SEO' } });
    fireEvent.click(screen.getByTestId('market-search-run-skill'));
    await waitFor(() => expect(marketSearch).toHaveBeenCalledWith({ kind: 'skill', query: 'SEO', source: 'skillsmp' }));
    expect(screen.getByText('[SkillsMP]')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('market-result-item'));
    await waitFor(() => expect(marketReadSkillDoc).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
      source: 'skillsmp',
      filePath: 'skills/seo',
    }));
    fireEvent.click(screen.getByTestId('market-install-skill'));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'skill_url',
      url: 'https://github.com/owner/repo/tree/main/skills/seo',
    })));
  });

  it('mcpmarket.cn：选择来源、读取公开详情并确认命令后安装配置', async () => {
    marketSearch = marketSearch.mockResolvedValueOnce({ ok: true, items: [MCPMARKET_ITEM], usingToken: false, source: 'mcpmarket_cn' });
    marketReadMcpDocs = marketReadMcpDocs.mockResolvedValueOnce({
      readme: { ok: true, path: 'mcpmarket.cn server detail', content: '# github\nAn MCP server.' },
      packageJson: { ok: false },
    });
    const onInstalled = vi.fn();
    Object.assign(window.metis, { marketSearch, marketReadMcpDocs });
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="mcp" zh definitions={[]} onInstalled={onInstalled} />);
    fireEvent.change(screen.getByTestId('market-source-mcp'), { target: { value: 'mcpmarket_cn' } });
    fireEvent.change(screen.getByTestId('market-search-input-mcp'), { target: { value: 'github' } });
    fireEvent.click(screen.getByTestId('market-search-run-mcp'));
    await waitFor(() => expect(marketSearch).toHaveBeenCalledWith({ kind: 'mcp', query: 'github', source: 'mcpmarket_cn' }));
    expect(screen.getByText('[mcpmarket.cn]')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('market-result-item'));
    await waitFor(() => expect(marketReadMcpDocs).toHaveBeenCalledWith({
      owner: '',
      repo: 'github',
      ref: 'main',
      source: 'mcpmarket_cn',
      sourceId: '67f018a890965e7bf66b06b9',
    }));
    expect(await screen.findByText(/来源详情（公开数据）/u)).toBeTruthy();
    const install = screen.getByTestId('market-install-mcp') as HTMLButtonElement;
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
  });

  it('mcpworld.com：选择来源、读取公开详情并确认命令后安装配置', async () => {
    marketSearch = marketSearch.mockResolvedValueOnce({ ok: true, items: [MCPWORLD_ITEM], usingToken: false, source: 'mcpworld' });
    marketReadMcpDocs = marketReadMcpDocs.mockResolvedValueOnce({
      readme: { ok: true, path: 'mcpworld.com server detail', content: '# Real MCP docs\nUsage via npx.' },
      packageJson: { ok: true, npmPackage: '@shilpathota/orch' },
    });
    const onInstalled = vi.fn();
    Object.assign(window.metis, { marketSearch, marketReadMcpDocs });
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="mcp" zh definitions={[]} onInstalled={onInstalled} />);
    fireEvent.change(screen.getByTestId('market-source-mcp'), { target: { value: 'mcpworld' } });
    fireEvent.change(screen.getByTestId('market-search-input-mcp'), { target: { value: 'filesystem' } });
    fireEvent.click(screen.getByTestId('market-search-run-mcp'));
    await waitFor(() => expect(marketSearch).toHaveBeenCalledWith({ kind: 'mcp', query: 'filesystem', source: 'mcpworld' }));
    expect(screen.getByText('[mcpworld.com]')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('market-result-item'));
    await waitFor(() => expect(marketReadMcpDocs).toHaveBeenCalledWith({
      owner: 'shilpathota',
      repo: 'Multi_Agent_Orch',
      ref: 'main',
      source: 'mcpworld',
      sourceId: '4f1044aeca34b80af7d337c0fda9f214',
    }));
    const args = await screen.findByTestId('market-mcp-args');
    expect((args as HTMLTextAreaElement).value).toContain('@shilpathota/orch');
    fireEvent.click(screen.getByTestId('market-install-mcp'));
    await waitFor(() => expect(savePersonalization).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
  });

  it('搜索失败（限额）时显示令牌提示', async () => {
    marketSearch = marketSearch.mockResolvedValue({ ok: false, code: 'rate_limited' });
    Object.assign(window.metis, { marketSearch });
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={vi.fn()} />);
    fireEvent.click(screen.getByTestId('market-search-run-skill'));
    await waitFor(() => expect(screen.getByTestId('market-status-skill').textContent).toContain('限额'));
  });

  it('粘贴技能仓库网址可直接安装（不经搜索）', async () => {
    const onInstalled = vi.fn();
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={onInstalled} />);
    fireEvent.change(screen.getByTestId('market-install-url-skill'), { target: { value: 'https://github.com/owner/custom-skill' } });
    fireEvent.click(screen.getByTestId('market-install-url-run-skill'));
    await waitFor(() => expect(applyPersonalizationExtension).toHaveBeenCalledTimes(1));
    expect((applyPersonalizationExtension.mock.calls[0]![0] as { mode: string; url: string }).mode).toBe('skill_url');
    expect((applyPersonalizationExtension.mock.calls[0]![0] as { url: string }).url).toBe('https://github.com/owner/custom-skill');
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('url:skills/skill-pdf'));
    expect(marketSearch).not.toHaveBeenCalled();
  });

  it('非 GitHub 网址给出明确拒绝提示', async () => {
    const { default: Panel } = await import('../../src/personalization/MarketBrowserPanel.js');
    render(<Panel kind="skill" zh definitions={[]} onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByTestId('market-install-url-skill'), { target: { value: 'https://example.com/not-github' } });
    fireEvent.click(screen.getByTestId('market-install-url-run-skill'));
    await waitFor(() => expect(screen.getByTestId('market-status-skill').textContent).toContain('GitHub'));
    expect(applyPersonalizationExtension).not.toHaveBeenCalled();
  });
});
