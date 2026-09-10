/**
 * UpdateCheckerService — lightweight update notification for unsigned builds.
 *
 * The installers are intentionally unsigned (SmartScreen warns, which is
 * documented), and the packaging policy sets requireAuthenticode:false. Under
 * that constraint electron-updater's auto-install cannot be used safely — an
 * unsigned download would fail signature verification. Instead this service
 * polls the GitHub latest-release API, compares the published tag against the
 * running version, and reports whether a newer build exists plus a download
 * URL. The renderer turns that into a "new version available" notice.
 *
 * Failures are non-fatal: if the network or API is unavailable the service
 * reports "no update" rather than blocking anything.
 */

export interface UpdateCheckResult {
  /** True when a newer published version exists. */
  hasUpdate: boolean;
  /** Current running version (from package.json / app). */
  currentVersion: string;
  /** Published version, when available. */
  latestVersion?: string;
  /** Release URL for manual download. */
  releaseUrl?: string;
  /** Set when the check itself failed (network/API), not a version mismatch. */
  error?: string;
}

export interface UpdateCheckerOptions {
  /** GitHub API URL for the latest release. Overridable for tests. */
  apiUrl?: string;
  /** Repository slug used to build the default API URL. */
  repo?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_REPO = 'TZUKWAN/metis-in-social-science';

function parseVersion(tag: string): number[] {
  return tag
    .replace(/^v/iu, '')
    .split(/[.-]/u)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => !Number.isNaN(n));
}

/** Compare two version arrays; returns >0 when a is newer than b. */
function compareVersions(a: number[], b: number[]): number {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

export class UpdateCheckerService {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: UpdateCheckerOptions = {}) {
    this.#apiUrl = options.apiUrl
      ?? `https://api.github.com/repos/${options.repo ?? DEFAULT_REPO}/releases/latest`;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Compare the running version against the latest GitHub release. */
  async check(currentVersion: string, timeoutMs = 8_000): Promise<UpdateCheckResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(this.#apiUrl, {
          headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'metis-workbench' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        return { hasUpdate: false, currentVersion, error: `Release API returned ${response.status}` };
      }
      const payload = await response.json() as { tag_name?: string; html_url?: string };
      const latest = payload.tag_name;
      if (!latest) {
        return { hasUpdate: false, currentVersion, error: 'Release API returned no tag' };
      }
      const diff = compareVersions(parseVersion(latest), parseVersion(currentVersion));
      return {
        hasUpdate: diff > 0,
        currentVersion,
        latestVersion: latest,
        releaseUrl: payload.html_url,
      };
    } catch (err) {
      return {
        hasUpdate: false,
        currentVersion,
        error: err instanceof Error ? err.message : 'Update check failed',
      };
    }
  }
}
