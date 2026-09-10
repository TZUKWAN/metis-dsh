/**
 * Scenario acquisition tools (2026-08-23, requested by 刘总).
 *
 * During a phased scenario build the compiler may:
 *  1. scenario_market_search   — read-only search of the skill/MCP markets so
 *     the model can verify whether a needed capability exists before writing
 *     workflow bindings.
 *  2. scenario_install_extension — FULLY AUTOMATIC install (刘总 explicit
 *     authorization): skills via the existing `skill_url` installer, MCPs via
 *     the managed `mcp_url` installer. Every safety check built into those
 *     installers (https-only, manifest same-origin, digests, static content
 *     checks) stays in force — this tool adds no bypass.
 *
 * Both handlers delegate to late-bound service holders injected by main.ts,
 * because personalization services are created after the tool registry.
 * Install count is capped per compile session to prevent runaway loops.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';

/** Upper bound on automatic installs within one compile session. */
export const SCENARIO_INSTALL_LIMIT = 6;

export interface ScenarioMarketSearchFn {
  (kind: 'skill' | 'mcp', query: string, source: string): Promise<{
    ok?: boolean | null;
    code?: string | null;
    items?: ReadonlyArray<Record<string, unknown>> | unknown[];
  }>;
}

export interface ScenarioExtensionApplyFn {
  (request: Record<string, unknown>): Promise<{
    ok?: boolean | null;
    mode?: string | null;
    code?: string | null;
    detailCode?: string | null;
    definition?: { id: string; name: string } | { id: string; name: string; description: string } | Record<string, unknown> | null;
  }>;
}

export const SCENARIO_MARKET_SEARCH_TOOL_NAME = 'scenario_market_search';
export const SCENARIO_INSTALL_EXTENSION_TOOL_NAME = 'scenario_install_extension';

const MARKET_SOURCES: Record<'skill' | 'mcp', readonly string[]> = {
  skill: ['github', 'skillsmp'],
  mcp: ['github', 'mcpworld', 'mcpmarket_cn'],
};

/** Compact item projection keeps market payloads inside the tool budget. */
function projectItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    name: typeof item.name === 'string' ? item.name.slice(0, 120) : '',
    owner: typeof item.owner === 'string' ? item.owner : '',
    repo: typeof item.repo === 'string' ? item.repo : '',
    description: typeof item.description === 'string' ? item.description.slice(0, 300) : '',
    url: typeof item.url === 'string' ? item.url : '',
    installUrl: typeof item.installUrl === 'string' ? item.installUrl : '',
    installable: item.installable === true,
    defaultBranch: typeof item.defaultBranch === 'string' ? item.defaultBranch : 'main',
    stars: typeof item.stars === 'number' ? item.stars : 0,
    source: typeof item.source === 'string' ? item.source : '',
  };
}

export interface ScenarioMarketSearchRouter {
  spec: ToolSpec;
  handler: ToolHandler;
}

export function createScenarioMarketSearchRouter(searchFn: ScenarioMarketSearchFn | null): ScenarioMarketSearchRouter {
  const spec: ToolSpec = {
    name: SCENARIO_MARKET_SEARCH_TOOL_NAME,
    description: [
      'Read-only search of METIS skill/MCP markets (GitHub / SkillsMP / mcpworld / mcpmarket_cn).',
      'Use it during scenario building to CHECK whether a needed Skill or MCP exists before binding step.skillIds/step.mcpIds.',
      'Returns compact items with repo identity and install URLs. This tool never installs anything.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'mcp'], description: 'Which kind of capability to look for.' },
        query: { type: 'string', description: 'Free-text search keywords, e.g. "文献计量分析" or "web scraping mcp".' },
        source: { type: 'string', description: 'Optional preferred source; defaults to github.' },
      },
      required: ['kind', 'query'],
    },
    decodeArgs: (raw) => raw,
  } as ToolSpec;
  const handler: ToolHandler = async (args) => {
    if (!searchFn) return JSON.stringify({ ok: false, error: 'market_service_unavailable' });
    const kind = args.kind === 'mcp' ? 'mcp' : 'skill';
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
    if (!query) return JSON.stringify({ ok: false, error: 'invalid_query' });
    const requested = typeof args.source === 'string' ? args.source : 'github';
    const allowed = MARKET_SOURCES[kind];
    // 主来源失败时按可用来源依次降级重试，最大化找到候选的概率。
    const sources = allowed.includes(requested) ? [requested, ...allowed.filter((item) => item !== requested)] : [...allowed];
    let lastCode = 'not_found';
    for (const source of sources) {
      try {
        const result = await searchFn(kind, query, source);
        if (result?.ok && Array.isArray(result.items)) {
          return JSON.stringify({
            ok: true,
            source,
            items: result.items.slice(0, 8).map((item) => projectItem(item as Record<string, unknown>)),
            note: 'installUrl 为空或 installable=false 的条目无法自动安装，只能作为参考。',
          });
        }
        lastCode = typeof result?.code === 'string' ? result.code : 'not_found';
      } catch {
        lastCode = 'network_error';
      }
    }
    return JSON.stringify({ ok: false, error: 'search_failed', code: lastCode, sourcesTried: sources });
  };
  return { spec, handler };
}

export interface ScenarioInstallationNotification {
  sessionId: string;
  installedId: string;
  installedName: string;
  kind: 'skill' | 'mcp';
  url: string;
}

/** Late-bound installer holder injected from main.ts once services exist. */
export interface ScenarioInstallerBinding {
  apply: ScenarioExtensionApplyFn | null;
  /** Pushed after each successful install for live progress display, keyed by compile session. */
  notifications: Map<string, (message: ScenarioInstallationNotification) => void>;
}

interface InstallCounters {
  map: Map<string, number>;
}

function slugifyUrl(url: URL, prefix: string): string {
  const cleaned = `${url.pathname}`.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
  return `${prefix}${cleaned || 'extension'}-${randomUUID().slice(0, 8)}`;
}

export interface ScenarioInstallRouter {
  spec: ToolSpec;
  handler: ToolHandler;
  /** Clear one compile session's install counter without affecting concurrent sessions. */
  clearSessionCounter(sessionId: string): void;
}

export function createScenarioInstallRouter(binding: ScenarioInstallerBinding): ScenarioInstallRouter {
  const counters: InstallCounters = { map: new Map() };
  const spec: ToolSpec = {
    name: SCENARIO_INSTALL_EXTENSION_TOOL_NAME,
    description: [
      'AUTOMATICALLY install a Skill or MCP server found via scenario_market_search and bindable to workflow steps.',
      'Skills need a GitHub repository URL (https://github.com/owner/repo). MCPs need an https manifest.json URL.',
      'Only call it when the installed-resource catalog lacks a capability the scenario genuinely needs.',
      'The result returns the installed definition id — immediately reference it in scenario_apply_update step.skillIds/mcpIds.',
      `At most ${SCENARIO_INSTALL_LIMIT} installs per build; never reinstall something already present.`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'mcp'], description: 'What to install.' },
        url: { type: 'string', description: 'skill: GitHub repo URL; mcp: https URL pointing at a manifest.json.' },
        reason: { type: 'string', description: 'One sentence: which workflow step needs this and why.' },
      },
      required: ['kind', 'url'],
    },
    decodeArgs: (raw) => raw,
  } as ToolSpec;
  const handler: ToolHandler = async (args, context) => {
    const kind = args.kind === 'mcp' ? 'mcp' : 'skill';
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 300) : '';
    if (!url) return JSON.stringify({ ok: false, error: 'invalid_url' });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return JSON.stringify({ ok: false, error: 'invalid_url' });
    }
    if (parsed.protocol !== 'https:') return JSON.stringify({ ok: false, error: 'https_only' });
    const used = counters.map.get(context.sessionId) ?? 0;
    if (used >= SCENARIO_INSTALL_LIMIT) {
      return JSON.stringify({ ok: false, error: 'install_limit_reached', limit: SCENARIO_INSTALL_LIMIT });
    }
    if (!binding.apply) return JSON.stringify({ ok: false, error: 'installer_unavailable' });

    const operationId = randomUUID();
    // 与 IPC 路径一致的证据上下文：主进程派生并签名，模型不可伪造。
    const evidenceContext = {
      sessionId: ('scenario-compile-' + context.sessionId).slice(0, 120),
      projectId: 'global',
      operationId,
      runManifestDigest: 'sha256-' + createHash('sha256').update(`${context.sessionId}\0${operationId}\0${url}`).digest('hex'),
      observedAt: Date.now(),
    };
    let request: Record<string, unknown>;
    if (kind === 'skill') {
      if (!/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+/u.test(url)) {
        return JSON.stringify({ ok: false, error: 'skill_url_must_be_github_repo' });
      }
      request = {
        contractVersion: 1, mode: 'skill_url', url,
        expectedRevision: 0, expectedArchiveSha256: null, expectedId: null, expectedVersion: null,
        evidenceContext,
      };
    } else {
      request = {
        contractVersion: 1, mode: 'mcp_url',
        definitionId: slugifyUrl(parsed, 'url:mcp/'),
        manifestUrl: url,
        expectedManifestSha256: null,
        expectedRevision: 0,
        evidenceContext,
      };
    }
    try {
      const result = await binding.apply(request);
      const definition = result?.definition as { id?: unknown; name?: unknown } | null | undefined;
      const definitionId = typeof definition?.id === 'string' ? definition.id : '';
      const definitionName = typeof definition?.name === 'string' ? definition.name : '';
      if (result?.ok !== true || !definitionId) {
        return JSON.stringify({
          ok: false,
          error: 'install_failed',
          code: result?.code ?? 'unknown',
          detailCode: result?.detailCode ?? null,
          hint: '不要重复尝试同一 URL；如继续缺能力请在最终 summary 中如实说明。',
        });
      }
      counters.map.set(context.sessionId, used + 1);
      try {
        binding.notifications.get(context.sessionId)?.({
          sessionId: context.sessionId,
          installedId: definitionId,
          installedName: definitionName || definitionId,
          kind,
          url,
        });
      } catch { /* 通知失败不影响安装结果 */ }
      return JSON.stringify({
        ok: true,
        kind,
        reason,
        definition: { id: definitionId, name: definitionName },
        next: '用 scenario_apply_update 把该 id 写入目标步骤的对应数组。',
      });
    } catch (error) {
      return JSON.stringify({ ok: false, error: 'install_exception', message: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
  };
  return {
    spec,
    handler,
    clearSessionCounter: (sessionId: string) => { counters.map.delete(sessionId); },
  };
}
