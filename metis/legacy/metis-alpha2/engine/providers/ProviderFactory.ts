/**
 * Provider factory with pluggable type registry.
 *
 * Ported from metis/providers/factory.py.
 */

import type { BaseProvider } from './BaseProvider.js';
import { OpenAICompatProvider } from './OpenAICompatProvider.js';
import { FakeProvider } from './FakeProvider.js';

type ProviderConstructor = new (...args: unknown[]) => BaseProvider;

const PROVIDER_REGISTRY = new Map<string, ProviderConstructor>();

export function registerProvider(type: string, cls: ProviderConstructor): void {
  PROVIDER_REGISTRY.set(type, cls);
}

export function buildProvider(options: {
  providerType?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  [key: string]: unknown;
}): BaseProvider {
  const type = options.providerType ?? 'openai_compat';
  const Cls = PROVIDER_REGISTRY.get(type);

  if (!Cls) {
    const available = [...PROVIDER_REGISTRY.keys()].sort().join(', ') || '(none)';
    throw new Error(`Unknown provider type '${type}'. Available: ${available}`);
  }

  if (Cls === OpenAICompatProvider) {
    if (!options.baseUrl) throw new Error('baseUrl is required for OpenAICompatProvider');
    if (!options.apiKey) throw new Error('apiKey is required for OpenAICompatProvider');
    return new OpenAICompatProvider({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
    });
  }

  if (Cls === FakeProvider) {
    return new FakeProvider(options as ConstructorParameters<typeof FakeProvider>[0]);
  }

  return new Cls(options);
}

// ─── Default registrations ────────────────────────────────────

registerProvider('openai_compat', OpenAICompatProvider as unknown as ProviderConstructor);
// Test-only provider. Only activated if user explicitly sets provider to 'fake'.
// Never used in production unless deliberately configured.
registerProvider('fake', FakeProvider as unknown as ProviderConstructor);
