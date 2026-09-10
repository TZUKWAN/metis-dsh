/**
 * ResearchStrategyStore — durable storage for user-defined research workflow
 * strategies and paper structure templates.
 *
 * Strategies and templates live in the shared `memory` table under the
 * `research_strategy` category (same pattern as goal/autonomous checkpoints),
 * so backups and restores cover them.
 */

import type { PersistenceStore } from './PersistenceStore.js';
import {
  ResearchStrategySchema,
  PaperStructureTemplateSchema,
  type ResearchStrategy,
  type PaperStructureTemplate,
} from '../runtime/ResearchStrategyContract.js';
import { defaultResearchStrategy } from '../research/researchActions.js';

const CATEGORY = 'research_strategy';
const STRATEGY_PREFIX = 'rs_strategy:';
const STRUCTURE_PREFIX = 'rs_structure:';
const DEFAULT_STRATEGY_ID = 'strategy_default_general';
const DEFAULT_STRUCTURE_ID = 'structure_default_general';

function parse<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, value: string): T | undefined {
  try {
    const result = schema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export class ResearchStrategyStore {
  private readonly store: PersistenceStore;

  constructor(store: PersistenceStore) {
    this.store = store;
  }

  listStrategies(): ResearchStrategy[] {
    const out: ResearchStrategy[] = [];
    for (const entry of this.store.getMemoryByCategory(CATEGORY)) {
      if (!entry.key.startsWith(STRATEGY_PREFIX)) continue;
      const strategy = parse(ResearchStrategySchema, entry.value);
      if (strategy) out.push(strategy);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getStrategy(id: string): ResearchStrategy | undefined {
    const entry = this.store.getMemory(`${STRATEGY_PREFIX}${id}`);
    return entry ? parse(ResearchStrategySchema, entry.value) : undefined;
  }

  /** The default strategy; falls back to the built-in general path. */
  getDefaultStrategy(): ResearchStrategy {
    const found = this.getStrategy(DEFAULT_STRATEGY_ID);
    if (found) return found;
    const builtin = defaultResearchStrategy();
    return {
      ...builtin,
      description: builtin.description,
      createdAt: 0,
      updatedAt: 0,
      isDefault: true,
    };
  }

  saveStrategy(strategy: ResearchStrategy): void {
    this.store.setMemory(
      `${STRATEGY_PREFIX}${strategy.id}`,
      JSON.stringify(strategy),
      CATEGORY,
    );
  }

  deleteStrategy(id: string): void {
    this.store.deleteMemory(`${STRATEGY_PREFIX}${id}`);
  }

  listStructures(): PaperStructureTemplate[] {
    const out: PaperStructureTemplate[] = [];
    for (const entry of this.store.getMemoryByCategory(CATEGORY)) {
      if (!entry.key.startsWith(STRUCTURE_PREFIX)) continue;
      const template = parse(PaperStructureTemplateSchema, entry.value);
      if (template) out.push(template);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getStructure(id: string): PaperStructureTemplate | undefined {
    const entry = this.store.getMemory(`${STRUCTURE_PREFIX}${id}`);
    return entry ? parse(PaperStructureTemplateSchema, entry.value) : undefined;
  }

  saveStructure(template: PaperStructureTemplate): void {
    this.store.setMemory(
      `${STRUCTURE_PREFIX}${template.id}`,
      JSON.stringify(template),
      CATEGORY,
    );
  }

  deleteStructure(id: string): void {
    this.store.deleteMemory(`${STRUCTURE_PREFIX}${id}`);
  }
}

export { DEFAULT_STRATEGY_ID, DEFAULT_STRUCTURE_ID };
