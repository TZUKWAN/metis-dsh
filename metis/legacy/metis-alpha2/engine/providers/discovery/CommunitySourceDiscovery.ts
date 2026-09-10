/**
 * 社区中转站自动发现（2026-08-23 刘总需求）。
 *
 * 原理：New API 系公益中转站的清单通常发布在 GitHub 聚合仓库（README/index.html
 * 内含站点地址）。通过 GitHub API 搜索这类仓库、抓取其内容、提取候选站点域名，
 * 再逐个探活验证是否为真实可用的 OpenAI 兼容端点。
 *
 * 三层过滤宁缺毋滥：内容特征词 → /api/status 探活 → /v1/models 列模型非空。
 */

function trimTrailingSlash(url: string): string {
  let r = url;
  while (r.endsWith(String.fromCharCode(47))) r = r.slice(0, -1);
  return r;
}

export interface CommunityStation {
  baseUrl: string;
  name: string;
  modelCount: number;
  latencyMs: number;
}

function extractCandidateUrls(text: string): string[] {
  const excluded = new Set(['github.com', 'w3.org', 'schema.org', 'googleapis.com', 'jsdelivr.net', 'shields.io']);
  const raw = text.match(/https?:\/\/[^\s"'<>)\]},;]+/gu) ?? [];
  const out = new Set<string>();
  for (let url of raw) {
    url = url.replace(/[.,;!?]+$/u, '');
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if ([...excluded].some((item) => host === item || host.endsWith('.' + item))) continue;
    out.add(new URL(url).origin);
  }
  return [...out];
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json() as Promise<unknown>;
}

/** GitHub 仓库搜索：返回候选聚合仓 full_name 列表。 */
export async function searchAggregateRepos(options: {
  githubToken?: string;
  maxRepos?: number;
  timeoutMs?: number;
}): Promise<string[]> {
  const headers: Record<string, string> = { 'user-agent': 'metis-discovery', accept: 'application/vnd.github+json' };
  if (options.githubToken) headers.authorization = 'Bearer ' + options.githubToken;
  const queries = [
    '免费大模型API公益站 in:name,description,readme',
    'new-api 公益站 free',
  ];
  const found = new Set<string>();
  for (const query of queries) {
    if (found.size >= (options.maxRepos ?? 5)) break;
    try {
      const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(query) + '&sort=updated&per_page=10';
      const payload = await fetchJson(url, headers, options.timeoutMs ?? 20_000) as { items?: Array<{ full_name?: string }> };
      for (const item of payload.items ?? []) {
        if (typeof item.full_name === 'string') found.add(item.full_name);
      }
    } catch { /* 单查询失败继续 */ }
  }
  return [...found].slice(0, options.maxRepos ?? 5);
}

/** 抓取仓库文本内容，提取候选站点根地址。 */
export async function extractStationUrlsFromRepo(fullName: string, options: {
  githubToken?: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const headers: Record<string, string> = { 'user-agent': 'metis-discovery', accept: 'application/vnd.github.raw+json' };
  if (options.githubToken) headers.authorization = 'Bearer ' + options.githubToken;
  const urls = new Set<string>();
  for (const fileName of ['index.html', 'README.md']) {
    try {
      const url = 'https://api.github.com/repos/' + fullName + '/contents/' + fileName;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
      if (!response.ok) continue;
      const text = await response.text();
      if (/new-api|公益站|free.*api/iu.test(text)) {
        for (const candidate of extractCandidateUrls(text)) urls.add(candidate);
      }
    } catch { /* 单文件失败继续 */ }
  }
  return [...urls];
}

interface StationVerifyResult {
  baseUrl: string;
  name: string;
  modelCount: number;
  latencyMs: number;
}

async function verifyStation(baseUrl: string, timeoutMs: number): Promise<StationVerifyResult | null> {
  const started = Date.now();
    const root = baseUrl.replace(new RegExp("/+$", "u"), "");
  try {
    const statusResponse = await fetch(root + '/api/status', { signal: AbortSignal.timeout(timeoutMs) });
    if (!statusResponse.ok) return null;
    const status = await statusResponse.json() as { data?: { system_name?: string } };
    const host = new URL(root).hostname;
    const name = String(status?.data?.system_name ?? host);
    const modelsResponse = await fetch(root + '/v1/models', { signal: AbortSignal.timeout(timeoutMs) });
    if (!modelsResponse.ok) return null;
    const modelsPayload = await modelsResponse.json() as { data?: unknown[] };
    const modelCount = Array.isArray(modelsPayload?.data) ? modelsPayload.data.length : 0;
    if (modelCount === 0) return null;
    return { baseUrl: root, name, modelCount, latencyMs: Date.now() - started };
  } catch {
    return null;
  }
}

/**
 * 主入口：自动发现社区公益中转站。
 * 返回验证通过的站点列表（含模型数与延迟），按延迟升序。
 */
export async function discoverCommunityStations(options: {
  githubToken?: string;
  maxRepos?: number;
  maxStations?: number;
  timeoutMs?: number;
  excludeBaseUrls?: string[];
} = {}): Promise<CommunityStation[]> {
  const maxStations = options.maxStations ?? 20;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const excluded = new Set((options.excludeBaseUrls ?? []).map((url) => trimTrailingSlash(url)));
  const repos = await searchAggregateRepos({ githubToken: options.githubToken, maxRepos: options.maxRepos ?? 5, timeoutMs });
  const candidateUrls = new Set<string>();
  for (const repo of repos) {
    try {
      for (const url of await extractStationUrlsFromRepo(repo, options)) {
        if (!excluded.has(trimTrailingSlash(url))) candidateUrls.add(url);
      }
    } catch { /* 单仓失败继续 */ }
  }
  // 并发验证（4 路），最多 maxStations 个通过。
  const verified: CommunityStation[] = [];
  const candidates = [...candidateUrls].slice(0, 40);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < candidates.length && verified.length < maxStations) {
      const baseUrl = candidates[cursor]!;
      cursor += 1;
      const result = await verifyStation(baseUrl, timeoutMs);
      if (result) verified.push(result);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return verified.sort((a, b) => a.latencyMs - b.latencyMs);
}
