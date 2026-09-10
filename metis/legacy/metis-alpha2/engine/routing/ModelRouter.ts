/**
 * Model router — multi-provider routing with health checks and failover.
 *
 * Ported from metis/routing/router.py + metis/routing/strategy.py + metis/routing/health.py.
 */

import type { BaseProvider } from '../providers/BaseProvider.js';
import type { ProviderCapabilities } from '../core/types.js';

// ─── Provider Entry ───────────────────────────────────────────

export interface ProviderEntry {
  id: string;
  provider: BaseProvider;
  priority: number;
  enabled: boolean;
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  lastHealthCheck: number;
  consecutiveFailures: number;
}

// ─── Health Monitor ───────────────────────────────────────────

export class HealthMonitor {
  private readonly checkIntervalMs: number;

  constructor(checkIntervalMs = 30_000) {
    this.checkIntervalMs = checkIntervalMs;
  }

  async check(entry: ProviderEntry): Promise<boolean> {
    const now = Date.now();
    if (now - entry.lastHealthCheck < this.checkIntervalMs) {
      return entry.healthStatus !== 'unhealthy';
    }

    try {
      const result = await entry.provider.healthCheck();
      const healthy = result.status === 'healthy';
      entry.healthStatus = healthy ? 'healthy' : 'unhealthy';
      entry.lastHealthCheck = now;

      if (healthy) {
        entry.consecutiveFailures = 0;
      } else {
        entry.consecutiveFailures++;
      }

      return healthy;
    } catch {
      entry.healthStatus = 'unhealthy';
      entry.lastHealthCheck = now;
      entry.consecutiveFailures++;
      return false;
    }
  }
}

// ─── Routing Strategies ───────────────────────────────────────

export type RoutingStrategy = 'primary-fallback' | 'round-robin' | 'least-failures';

function selectByStrategy(
  entries: ProviderEntry[],
  strategy: RoutingStrategy,
): ProviderEntry | null {
  const healthy = entries.filter((e) => e.enabled && e.healthStatus !== 'unhealthy');
  if (healthy.length === 0) {
    // Fallback: try all entries regardless of health
    const enabled = entries.filter((e) => e.enabled);
    return enabled[0] ?? null;
  }

  switch (strategy) {
    case 'primary-fallback':
      // Sort by priority (lower = higher priority)
      healthy.sort((a, b) => a.priority - b.priority);
      return healthy[0] ?? null;

    case 'round-robin':
      return healthy[Math.floor(Math.random() * healthy.length)] ?? null;

    case 'least-failures':
      healthy.sort((a, b) => a.consecutiveFailures - b.consecutiveFailures);
      return healthy[0] ?? null;

    default:
      return healthy[0] ?? null;
  }
}

// ─── Model Router ─────────────────────────────────────────────

export class ModelRouter {
  private readonly entries: ProviderEntry[] = [];
  private readonly healthMonitor: HealthMonitor;
  private readonly strategy: RoutingStrategy;

  constructor(options?: {
    healthMonitor?: HealthMonitor;
    strategy?: RoutingStrategy;
  }) {
    this.healthMonitor = options?.healthMonitor ?? new HealthMonitor();
    this.strategy = options?.strategy ?? 'primary-fallback';
  }

  /** Register a provider. */
  addProvider(id: string, provider: BaseProvider, priority = 100): void {
    this.entries.push({
      id,
      provider,
      priority,
      enabled: true,
      healthStatus: 'unknown',
      lastHealthCheck: 0,
      consecutiveFailures: 0,
    });
  }

  /** Remove a provider by id. */
  removeProvider(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  /** Get the best available provider. */
  async getProvider(): Promise<BaseProvider | null> {
    if (this.entries.length === 0) return null;
    if (this.entries.length === 1) return this.entries[0]!.provider;

    // Run health checks
    for (const entry of this.entries) {
      await this.healthMonitor.check(entry);
    }

    const selected = selectByStrategy(this.entries, this.strategy);
    return selected?.provider ?? null;
  }

  /** Report a failure for a provider (triggers failover awareness). */
  reportFailure(provider: BaseProvider): void {
    const entry = this.entries.find((e) => e.provider === provider);
    if (entry) {
      entry.consecutiveFailures++;
      if (entry.consecutiveFailures >= 3) {
        entry.healthStatus = 'unhealthy';
      }
    }
  }

  /** Report a success (resets failure count). */
  reportSuccess(provider: BaseProvider): void {
    const entry = this.entries.find((e) => e.provider === provider);
    if (entry) {
      entry.consecutiveFailures = 0;
      entry.healthStatus = 'healthy';
    }
  }

  /** List all provider entries and their status. */
  listProviders(): ProviderEntry[] {
    return [...this.entries];
  }

  /** Get aggregated capabilities from the primary provider. */
  capabilities(): ProviderCapabilities | null {
    const entry = this.entries.find((e) => e.enabled);
    return entry?.provider.capabilities() ?? null;
  }
}
