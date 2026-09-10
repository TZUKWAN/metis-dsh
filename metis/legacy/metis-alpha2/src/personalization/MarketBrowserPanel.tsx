/**
 * MarketBrowserPanel — 技能/MCP 市场浏览与安装。
 *
 * 来源：技能 = SkillsMP、SkillHub（网站入口）；MCP = mcpmarket.cn、mcpworld.com。
 * 刘总 2026-09：GitHub 搜索安装入口已从市场移除（按网址/GitHub 地址安装仍由
 * 「安装技能」区的受控安装器提供）。SkillHub 暂无公开搜索 API，如实提供
 * 「打开 SkillHub 网站」入口 + 按网址安装提示，不伪造搜索结果。
 * 技能复用可验证的 GitHub 源走受控 skill_url 安装。MCP 来源展示真实
 * README/详情后由用户确认 stdio 命令生成配置（不伪装来源站登录态安装）。
 */
import { useState } from 'react';
import { Download, ExternalLink, FileText, Search, Star } from 'lucide-react';
import type { McpDefinition, PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { localId } from './personalizationLib.js';

/** 市场下拉可选来源（GitHub 搜索已移除；SkillHub 仅网站入口）。 */
type MarketUiSource = 'skillsmp' | 'mcpmarket_cn' | 'mcpworld' | 'skillhub';

const SKILLHUB_URL = 'https://www.skillhub.cn/';

function sourceOptions(kind: 'skill' | 'mcp'): MarketUiSource[] {
  return kind === 'skill' ? ['skillsmp', 'skillhub'] : ['mcpmarket_cn', 'mcpworld'];
}

interface MarketItem {
  source: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld';
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

export interface MarketBrowserPanelProps {
  kind: 'skill' | 'mcp';
  zh: boolean;
  /** 现有定义（用于生成不冲突的 MCP 安装 id）。 */
  definitions: readonly PersonalizationDefinition[];
  onInstalled: (definitionId: string) => void | Promise<void>;
}

function uniqueMcpId(repoName: string, definitions: readonly PersonalizationDefinition[]): string {
  const base = localId(repoName, 'market-mcp');
  let id = `user:mcp/${base}`;
  let ordinal = 2;
  const occupied = new Set(definitions.map((definition) => definition.id));
  while (occupied.has(id)) {
    id = `user:mcp/${base}-${ordinal}`;
    ordinal += 1;
  }
  return id;
}

export default function MarketBrowserPanel({ kind, zh, definitions, onInstalled }: MarketBrowserPanelProps) {
  const [query, setQuery] = useState('');
  const [sourceChoice, setSourceChoice] = useState<MarketUiSource>(() => sourceOptions(kind)[0]!);
  // kind 切换后来源随之复位到该类的默认源。
  const options = sourceOptions(kind);
  const source = options.includes(sourceChoice) ? sourceChoice : options[0]!;
  const [installUrl, setInstallUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [usingToken, setUsingToken] = useState(false);
  const [detail, setDetail] = useState<{ item: MarketItem; loading: boolean; path: string; content: string } | null>(null);
  const [mcpCommand, setMcpCommand] = useState('npx');
  const [mcpArgs, setMcpArgs] = useState('');

  const search = async () => {
    // SkillHub 无公开搜索 API：不伪造搜索，提示走网站入口。
    if (source === 'skillhub') {
      setStatus(zh ? 'SkillHub 暂不支持站内搜索，请使用下方「打开 SkillHub 网站」浏览。' : 'SkillHub has no public search API; use "Open SkillHub" below to browse.');
      return;
    }
    const metis = window.metis;
    if (!metis?.marketSearch) {
      setStatus(zh ? '市场服务不可用。' : 'Market service unavailable.');
      return;
    }
    setBusy(true);
    setStatus('');
    setDetail(null);
    try {
      const result = await metis.marketSearch({ kind, query, source });
      if (!result.ok || !result.items) {
        const labels: Record<string, string> = {
          rate_limited: zh ? 'GitHub 限额已用完；可在设置页配置访问令牌后重试。' : 'GitHub quota exhausted; configure a token in Settings.',
          network_error: zh ? '网络请求失败，请重试。' : 'Network request failed; retry.',
          invalid_request: zh ? '请求不合法。' : 'Invalid request.',
        };
        setStatus(labels[result.code ?? ''] ?? (zh ? `搜索失败（${result.code ?? 'unknown'}）` : `Search failed (${result.code ?? 'unknown'})`));
        return;
      }
      setItems(result.items);
      setUsingToken(result.usingToken === true);
      setStatus(result.items.length === 0
        ? (zh ? '没有匹配结果，换个关键词试试。' : 'No matches; try another keyword.')
        : '');
    } catch {
      setStatus(zh ? '搜索未完成，请重试。' : 'Search did not complete. Retry.');
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (item: MarketItem) => {
    const metis = window.metis;
    if (!metis?.marketReadSkillDoc || !metis?.marketReadMcpDocs) {
      setStatus(zh ? '市场服务不可用。' : 'Market service unavailable.');
      return;
    }
    setDetail({ item, loading: true, path: '', content: '' });
    setStatus('');
    try {
      if (kind === 'skill') {
        const doc = await metis.marketReadSkillDoc({
          owner: item.owner,
          repo: item.repo,
          ref: item.defaultBranch,
          source: item.source === 'skillsmp' ? 'skillsmp' : 'github',
          filePath: item.filePath,
        });
        if (!doc.ok) {
          setDetail({ item, loading: false, path: '', content: zh ? `无法读取技能文档（${doc.code ?? 'unknown'}）。` : `Could not read the skill doc (${doc.code ?? 'unknown'}).` });
          return;
        }
        setDetail({ item, loading: false, path: doc.path ?? '', content: doc.content ?? '' });
      } else {
        const mcpSource = item.source === 'skillsmp' ? 'github' : item.source;
        const docs = await metis.marketReadMcpDocs({
          owner: item.owner,
          repo: item.repo,
          ref: item.defaultBranch,
          source: mcpSource,
          sourceId: item.sourceId,
        });
        setMcpArgs(`-y\n${docs.packageJson.npmPackage ?? item.repo}`);
        const sourceLabels: Record<string, [string, string]> = {
          mcpmarket_cn: ['mcpmarket.cn 来源详情', 'mcpmarket.cn source detail'],
          mcpworld: ['mcpworld.com 来源详情', 'mcpworld.com source detail'],
        };
        const [zhLabel, enLabel] = sourceLabels[mcpSource] ?? ['README', 'README'];
        const readme = docs.readme.ok
          ? docs.readme.content ?? ''
          : (zh ? `无法读取${zhLabel}（${docs.readme.code ?? 'unknown'}）。` : `Could not read the ${enLabel} (${docs.readme.code ?? 'unknown'}).`);
        setDetail({ item, loading: false, path: docs.readme.ok ? (docs.readme.path ?? zhLabel) : zhLabel, content: readme });
      }
    } catch {
      setDetail({ item, loading: false, path: '', content: zh ? '详情读取未完成，请重试。' : 'Detail fetch did not complete; retry.' });
    }
  };

  const installSkill = async (item: MarketItem) => {
    const metis = window.metis;
    if (!metis?.applyPersonalizationExtension) {
      setStatus(zh ? '安装服务不可用。' : 'Installation service unavailable.');
      return;
    }
    if (!item.installable || !item.installUrl) {
      setStatus(zh ? '该来源未提供可验证的匿名安装接口，请打开来源页面手动安装。' : 'This source has no verifiable anonymous install API; open the source page to install manually.');
      return;
    }
    setInstalling(item.url);
    setStatus(zh ? `正在下载并核验 ${item.owner}/${item.repo}…` : `Downloading and verifying ${item.owner}/${item.repo}…`);
    try {
      // GitHub 源改带分支的 tree URL：安装器会规范化为 codeload 直连，
      // 避免匿名 api.github.com zipball 的 60 次/小时限额。
      const installUrl = item.source === 'github' && item.defaultBranch
        ? `${item.url.replace(/\/+$/u, '')}/tree/${item.defaultBranch}`
        : item.installUrl ?? item.url;
      const result = await metis.applyPersonalizationExtension({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        mode: 'skill_url',
        expectedRevision: 0,
        url: installUrl,
        expectedArchiveSha256: null,
        expectedId: null,
        expectedVersion: null,
      });
      if (!result.ok) {
        setStatus(`${zh ? '安装失败' : 'Install failed'}: ${result.code}${result.detailCode ? ` / ${result.detailCode}` : ''}`);
        return;
      }
      setStatus(zh ? `已安装「${result.definition.name}」并写入来源记录。` : `Installed "${result.definition.name}" with a source record.`);
      await onInstalled(result.definition.id);
    } catch {
      setStatus(zh ? '安装未完成，请重试。' : 'Installation did not complete. Retry.');
    } finally {
      setInstalling(null);
    }
  };

  /** 直接粘贴技能仓库网址安装：不搜索、不选来源，用户拿到链接就能装。 */
  const installSkillByUrl = async () => {
    const metis = window.metis;
    const url = installUrl.trim();
    if (!metis?.applyPersonalizationExtension) {
      setStatus(zh ? '安装服务不可用。' : 'Installation service unavailable.');
      return;
    }
    if (!/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+/u.test(url)) {
      setStatus(zh ? '请粘贴 GitHub 技能仓库网址（如 https://github.com/owner/repo）。' : 'Paste a GitHub skill repository URL (e.g. https://github.com/owner/repo).');
      return;
    }
    setInstalling('__by_url__');
    setStatus(zh ? '正在下载并核验技能包…' : 'Downloading and verifying the skill package…');
    try {
      const result = await metis.applyPersonalizationExtension({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        mode: 'skill_url',
        expectedRevision: 0,
        url,
        expectedArchiveSha256: null,
        expectedId: null,
        expectedVersion: null,
      });
      if (!result.ok) {
        setStatus(`${zh ? '安装失败' : 'Install failed'}: ${result.code}${result.detailCode ? ` / ${result.detailCode}` : ''}`);
        return;
      }
      setStatus(zh ? `已安装「${result.definition.name}」并写入来源记录。` : `Installed "${result.definition.name}" with a source record.`);
      setInstallUrl('');
      await onInstalled(result.definition.id);
    } catch {
      setStatus(zh ? '安装未完成，请重试。' : 'Installation did not complete. Retry.');
    } finally {
      setInstalling(null);
    }
  };

  const installMcp = async (item: MarketItem) => {
    const metis = window.metis;
    if (!metis?.savePersonalization) {
      setStatus(zh ? '个性化服务不可用。' : 'Personalization service unavailable.');
      return;
    }
    if (!mcpCommand.trim()) {
      setStatus(zh ? '请填写启动命令。' : 'Command is required.');
      return;
    }
    setInstalling(item.url);
    setStatus('');
    try {
      const definition: McpDefinition = {
        contractVersion: 1,
        id: uniqueMcpId(item.repo, definitions),
        kind: 'mcp',
        name: item.name,
        description: item.description.slice(0, 2000),
        enabled: true,
        tags: ['market'].concat(item.topics.slice(0, 3).map((topic) => topic.slice(0, 100))).slice(0, 8),
        revision: 1,
        provenance: {
          origin: 'user',
          author: item.owner,
          version: '1.0.0',
          license: null,
          sourceUrl: item.url,
          sourceRevision: item.defaultBranch,
          installedDigest: null,
          parentId: null,
          parentVersion: null,
          locallyModified: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        sourceMode: 'generated',
        transport: 'stdio',
        command: mcpCommand.trim(),
        args: mcpArgs.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
        environment: {},
        sourceUrl: item.url,
        exposedTools: [],
        workingDirectoryToken: null,
      };
      const result = await metis.savePersonalization({ contractVersion: 1, definition, expectedRevision: 0 });
      if (!result.ok || result.code !== 'saved' || !result.definition) {
        setStatus(`${zh ? '安装失败' : 'Install failed'}: ${result.code ?? 'unknown'}`);
        return;
      }
      setStatus(zh ? `已写入 MCP 配置「${result.definition.name}」。` : `MCP configuration "${result.definition.name}" saved.`);
      await onInstalled(result.definition.id);
    } catch {
      setStatus(zh ? '安装未完成，请重试。' : 'Installation did not complete. Retry.');
    } finally {
      setInstalling(null);
    }
  };

  return (
    <section className="personalization-installer market-browser" aria-label={zh ? (kind === 'skill' ? '技能市场' : 'MCP 市场') : (kind === 'skill' ? 'Skill market' : 'MCP market')} data-testid={`market-browser-${kind}`}>
      <div className="personalization-installer__header">
        <div>
          <span className="personalization-eyebrow">{kind === 'skill' ? (zh ? '技能市场' : 'SKILL MARKET') : 'MCP MARKET'}</span>
          <h2>{kind === 'skill' ? (zh ? '搜索并安装在线技能' : 'Search and install online skills') : (zh ? '搜索并安装在线 MCP' : 'Search and install online MCPs')}</h2>
        </div>
        <span>{zh
          ? '选择已验证来源，搜索技能/MCP，查看文档后按来源能力安装或打开来源页面。'
          : 'Choose a verified source, search skills/MCPs, preview docs, then install or open the source page.'}</span>
      </div>
      <div className="market-browser__search">
        <select
          value={source}
          onChange={(event) => setSourceChoice(event.target.value as MarketUiSource)}
          aria-label={zh ? '市场来源' : 'Market source'}
          data-testid={`market-source-${kind}`}
        >
          {kind === 'skill' && <option value="skillsmp">SkillsMP</option>}
          {kind === 'skill' && <option value="skillhub">SkillHub</option>}
          {kind === 'mcp' && <option value="mcpmarket_cn">mcpmarket.cn</option>}
          {kind === 'mcp' && <option value="mcpworld">mcpworld.com</option>}
        </select>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
          placeholder={kind === 'skill'
            ? (zh ? '搜索技能，如：pdf、literature review、数据分析' : 'Search skills, e.g. pdf, data analysis')
            : (zh ? '搜索 MCP server，如：filesystem、github、search' : 'Search MCP servers, e.g. filesystem, github')}
          aria-label={zh ? '市场搜索' : 'Market search'}
          disabled={source === 'skillhub'}
          data-testid={`market-search-input-${kind}`}
        />
        <button type="button" className="btn-primary" disabled={busy || source === 'skillhub'} onClick={() => void search()} data-testid={`market-search-run-${kind}`}>
          <Search size={13} aria-hidden="true" /> {busy ? (zh ? '搜索中…' : 'Searching…') : (zh ? '搜索' : 'Search')}
        </button>
      </div>
      {source === 'skillhub' && (
        <div className="market-browser__skillhub" data-testid="market-skillhub-skill">
          <p>{zh
            ? 'SkillHub（skillhub.cn）暂未提供公开搜索 API，无法在应用内检索或一键安装。请打开网站浏览，找到技能后复制其 GitHub 仓库地址，用下方「按网址安装」完成受控安装。'
            : 'SkillHub (skillhub.cn) has no public search API, so in-app search and one-click install are unavailable. Open the site, copy the skill\'s GitHub repository URL, then use "Install by URL" below for a controlled install.'}</p>
          <button type="button" className="btn-secondary" onClick={() => void window.metis?.openExternal?.(SKILLHUB_URL)} data-testid="market-skillhub-open">
            <ExternalLink size={13} aria-hidden="true" /> {zh ? '打开 SkillHub 网站' : 'Open SkillHub website'}
          </button>
        </div>
      )}
      {kind === 'skill' && (
        <div className="market-browser__install-url">
          <input
            value={installUrl}
            onChange={(event) => setInstallUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void installSkillByUrl(); }}
            placeholder={zh ? '或粘贴技能仓库网址直接安装（https://github.com/…）' : 'Or paste a skill repository URL to install (https://github.com/…)'}
            aria-label={zh ? '按网址安装技能' : 'Install skill by URL'}
            data-testid="market-install-url-skill"
          />
          <button type="button" className="btn-secondary" disabled={installing !== null || !installUrl.trim()} onClick={() => void installSkillByUrl()} data-testid="market-install-url-run-skill">
            <Download size={13} aria-hidden="true" /> {installing === '__by_url__' ? (zh ? '安装中…' : 'Installing…') : (zh ? '按网址安装' : 'Install by URL')}
          </button>
        </div>
      )}
      {!usingToken && items.length > 0 && (
        <p className="market-browser__hint">{source === 'skillsmp'
          ? (zh ? 'SkillsMP 匿名搜索受每日/每分钟额度限制；详情与安装使用其公开 GitHub 源。' : 'SkillsMP anonymous search is rate limited; details and installation use its public GitHub source.')
          : source === 'mcpworld'
            ? (zh ? 'mcpworld.com（百度 MCP 市场）匿名搜索/详情已验证；确认下方 stdio 命令后即可保存为 MCP 配置。' : 'mcpworld.com anonymous search/detail verified; confirm the stdio command below to save an MCP configuration.')
            : (zh ? 'mcpmarket.cn 匿名搜索/详情已验证；确认下方 stdio 命令后即可保存为 MCP 配置。' : 'mcpmarket.cn anonymous search/detail verified; confirm the stdio command below to save an MCP configuration.')}</p>
      )}
      {items.length > 0 && (
        <ul className="market-browser__results" data-testid={`market-results-${kind}`}>
          {items.map((item) => (
            <li key={item.url} className={detail?.item.url === item.url ? 'selected' : ''}>
              <button type="button" className="market-browser__select" onClick={() => void openDetail(item)} data-testid="market-result-item">
                <FileText size={13} aria-hidden="true" />
                <span className="market-browser__name">{item.owner ? `${item.owner}/` : ''}{item.repo}</span>
                <span className="market-browser__hint">[{item.source === 'skillsmp' ? 'SkillsMP' : item.source === 'mcpmarket_cn' ? 'mcpmarket.cn' : item.source === 'mcpworld' ? 'mcpworld.com' : 'GitHub'}]</span>
                <span className="market-browser__stars"><Star size={11} aria-hidden="true" /> {item.stars}</span>
                <span className="market-browser__desc">{item.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <div className="market-browser__detail" data-testid={`market-detail-${kind}`}>
          <header className="market-browser__detail-head">
            <strong>{detail.item.owner ? `${detail.item.owner}/` : ''}{detail.item.repo}</strong>
            <a href={detail.item.detailUrl ?? detail.item.url} onClick={(event) => { event.preventDefault(); void window.metis?.openExternal?.(detail.item.detailUrl ?? detail.item.url); }} className="market-browser__ext">
              <ExternalLink size={12} aria-hidden="true" /> {zh ? '在浏览器打开' : 'Open in browser'}
            </a>
          </header>
          {kind === 'skill' ? (
            <>
              <p className="market-browser__hint">{zh ? 'SKILL.md 内容预览：' : 'SKILL.md preview:'} <code>{detail.path}</code></p>
              <pre className="market-browser__doc">{detail.loading ? (zh ? '读取中…' : 'Loading…') : detail.content}</pre>
              <div className="personalization-actions">
                <button type="button" className="btn-primary" disabled={installing !== null || detail.item.installable !== true} onClick={() => void installSkill(detail.item)} data-testid={`market-install-${kind}`}>
                  <Download size={13} aria-hidden="true" /> {detail.item.installable === true
                    ? (installing === detail.item.url ? (zh ? '安装中…' : 'Installing…') : (zh ? '验证并安装' : 'Verify and install'))
                    : (zh ? '仅可查看来源' : 'View source only')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="market-browser__hint">{detail.item.source === 'mcpmarket_cn' || detail.item.source === 'mcpworld'
                ? (zh ? '来源详情（公开数据）：' : 'Source detail (public data):')
                : (zh ? 'README 预览与安装配置（stdio）:' : 'README preview and stdio install config:')}</p>
              <pre className="market-browser__doc">{detail.loading ? (zh ? '读取中…' : 'Loading…') : detail.content}</pre>
              <div className="market-browser__mcp-form">
                <label>
                  <span>{zh ? '启动命令' : 'Command'}</span>
                  <input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} data-testid="market-mcp-command" />
                </label>
                <label>
                  <span>{zh ? '参数（每行一个）' : 'Arguments (one per line)'}</span>
                  <textarea rows={2} value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} data-testid="market-mcp-args" />
                </label>
              </div>
              <div className="personalization-actions">
                <button type="button" className="btn-primary" disabled={installing !== null || detail.item.installable !== true} onClick={() => void installMcp(detail.item)} data-testid={`market-install-${kind}`}>
                  <Download size={13} aria-hidden="true" /> {detail.item.installable === true
                    ? (installing === detail.item.url ? (zh ? '安装中…' : 'Installing…') : (zh ? '安装 MCP 配置' : 'Install MCP configuration'))
                    : (zh ? '仅可查看来源' : 'View source only')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" data-testid={`market-status-${kind}`} className="market-browser__status">{status}</p>
    </section>
  );
}
