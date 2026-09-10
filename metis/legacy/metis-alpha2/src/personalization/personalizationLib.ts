/**
 * personalizationLib — 场景/定义创建与 ID 工具（场景重构 P2 抽取，供
 * PersonalizationCenter 与场景工作台/AI 创建对话框共用）。
 */
import type {
  AgentDefinition,
  McpDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { normalizeScenarioHarness } from '../../engine/personalization/ScenarioHarness.js';

export type Kind = 'scenario' | 'agent' | 'skill' | 'mcp' | 'rules';

const KIND_NAMESPACE: Record<Kind, string> = {
  scenario: 'scenarios',
  agent: 'agents',
  skill: 'skills',
  mcp: 'mcp',
  rules: 'rules',
};

export function localId(name: string, fallback = 'custom'): string {
  const normalized = name.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .slice(0, 80)
    .replace(/[^a-z0-9]+$/gu, '');
  return normalized || fallback;
}

export function availableUserId(
  kind: Kind,
  name: string,
  definitions: readonly PersonalizationDefinition[],
): string {
  const prefix = `user:${KIND_NAMESPACE[kind]}/`;
  const base = localId(name, `custom-${kind}`);
  const occupied = new Set(definitions.map((definition) => definition.id));
  if (!occupied.has(`${prefix}${base}`)) return `${prefix}${base}`;
  let ordinal = 2;
  while (occupied.has(`${prefix}${base}-${ordinal}`)) ordinal += 1;
  return `${prefix}${base}-${ordinal}`;
}

export function userProvenance(now: number) {
  return {
    origin: 'user' as const,
    author: 'Local user',
    version: '1.0.0',
    license: null,
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefinition(kind: Kind, name: string, all: readonly PersonalizationDefinition[]): PersonalizationDefinition {
  const now = Date.now();
  const id = availableUserId(kind, name, all);
  const common = {
    contractVersion: 1 as const,
    id,
    kind,
    name,
    description: '',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: userProvenance(now),
  };
  const memory = {
    scope: 'project' as const,
    retainDecisions: true,
    retainArtifacts: true,
    maxSummaryChars: 100_000,
  };
  const output = {
    format: 'artifact_bundle' as const,
    schema: null,
    plan: null,
    requireEvidenceEnvelope: true,
    includeIntegrityReport: true,
  };
  if (kind === 'skill') {
    return {
      ...common,
      kind,
      sourceMode: 'markdown',
      markdown: `# ${name}\n\n## Instructions\n\n`,
      systemPrompt: '',
      toolIds: [],
      mcpIds: [],
      maxTurns: 12,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
    } satisfies SkillDefinitionV2;
  }
  if (kind === 'agent') {
    return {
      ...common,
      kind,
      role: name,
      systemPrompt: '',
      modelPreference: null,
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      memory,
      output,
      maxTurns: 20,
      retryLimit: 2,
    } satisfies AgentDefinition;
  }
  if (kind === 'mcp') {
    return {
      ...common,
      kind,
      sourceMode: 'url',
      transport: 'stdio',
      command: 'node',
      args: [],
      environment: {},
      sourceUrl: null,
      exposedTools: [],
      workingDirectoryToken: null,
    } satisfies McpDefinition;
  }
  if (kind === 'rules') {
    return {
      ...common,
      kind,
      scope: 'project',
      scopeId: null,
      markdown: `# Metis.md\n\n## ${name}\n\n`,
    } satisfies MetisRulesDefinition;
  }
  return normalizeScenarioHarness({
    ...common,
    kind,
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory,
    output: {
      ...output,
      plan: {
        primaryDeliverable: name,
        supportingArtifacts: [],
        qualityCriteria: [],
      },
    },
    triggerPhrases: [],
    capability: 'custom',
  } satisfies ScenarioDefinition);
}

/** 深拷贝（解耦持久化对象与编辑态）。 */
export function cloneDefinition<T extends PersonalizationDefinition>(definition: T): T {
  return JSON.parse(JSON.stringify(definition)) as T;
}

// ─── 通用分类管理工具（localStorage-backed） ─────────────────────

export interface Category {
  id: string;
  name: string;
}

const CATEGORIES_KEY_PREFIX = 'metis-';
const CATEGORIES_KEY_SUFFIX = '-categories:v1';
const CATEGORY_MAP_KEY_SUFFIX = '-category-map:v1';

function categoriesKey(kind: string): string {
  return `${CATEGORIES_KEY_PREFIX}${kind}${CATEGORIES_KEY_SUFFIX}`;
}

function categoryMapKey(kind: string): string {
  return `${CATEGORIES_KEY_PREFIX}${kind}${CATEGORY_MAP_KEY_SUFFIX}`;
}

export function readCategories(kind: string): Category[] {
  try {
    const raw = localStorage.getItem(categoriesKey(kind));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Category =>
      item && typeof item.id === 'string' && typeof item.name === 'string',
    );
  } catch {
    return [];
  }
}

export function writeCategories(kind: string, list: Category[]): void {
  try {
    localStorage.setItem(categoriesKey(kind), JSON.stringify(list));
  } catch { // best-effort
  }
}

export function readCategoryMap(kind: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(categoryMapKey(kind));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function writeCategoryMap(kind: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(categoryMapKey(kind), JSON.stringify(map));
  } catch { // best-effort
  }
}

export function createCategory(kind: string, name: string): Category {
  const list = readCategories(kind);
  const category: Category = { id: `cat-${Date.now().toString(36)}`, name: name.trim() };
  list.push(category);
  writeCategories(kind, list);
  return category;
}

export function renameCategory(kind: string, categoryId: string, newName: string): void {
  const list = readCategories(kind);
  const index = list.findIndex((c) => c.id === categoryId);
  if (index >= 0) {
    const existing = list[index]!;
    existing.name = newName.trim();
    writeCategories(kind, list);
  }
}

export function deleteCategory(kind: string, categoryId: string): void {
  const list = readCategories(kind).filter((c) => c.id !== categoryId);
  writeCategories(kind, list);
  const map = readCategoryMap(kind);
  for (const [definitionId, assignedCategoryId] of Object.entries(map)) {
    if (assignedCategoryId === categoryId) {
      delete map[definitionId];
    }
  }
  writeCategoryMap(kind, map);
}

export function assignToCategory(kind: string, definitionId: string, categoryId: string | null): void {
  const map = readCategoryMap(kind);
  if (categoryId) {
    map[definitionId] = categoryId;
  } else {
    delete map[definitionId];
  }
  writeCategoryMap(kind, map);
}

export function getDefinitionsInCategory(kind: string, categoryId: string): string[] {
  const map = readCategoryMap(kind);
  return Object.entries(map)
    .filter(([, assignedId]) => assignedId === categoryId)
    .map(([definitionId]) => definitionId);
}
