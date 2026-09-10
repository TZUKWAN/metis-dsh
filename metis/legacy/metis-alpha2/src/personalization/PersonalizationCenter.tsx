import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DefinitionProvenanceSchema,
  FullAccessPolicySchema,
  MemoryPolicySchema,
  PersonalizationDefinitionSchema,
  type AgentDefinition,
  type ArchivedPersonalizationDefinition,
  type McpDefinition,
  type PersonalizationDefinition,
  type PersonalizationIntegrityIssue,
  type PersonalizationMutationResult,
  type PersonalizationVersionView,
  type ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import McpActivationPanel, {
  type McpActivationPanelDependencies,
} from './McpActivationPanel';
import McpCredentialPanel from './McpCredentialPanel';
import {
  missingMcpSecrets,
  usePersonalizationSecrets,
  type PersonalizationSecretVaultHandle,
} from './mcpCredentialVault.js';
import { SkillStudioDialog } from './SkillStudioPanel';
import { McpBuilderDialog } from './McpBuilderDialog';
import { availableUserId, createDefinition } from './personalizationLib.js';
import ScenarioWorkbench from './ScenarioWorkbench.js';
import { RotateCcw, Trash2, Upload, X } from 'lucide-react';
import './PersonalizationCenter.css';

import MarketBrowserPanel from './MarketBrowserPanel.js';
import { ExtensionInstaller } from './ExtensionInstaller.js';
import { CapabilityVaultPanel } from './CapabilityVaultPanel';

type Kind = PersonalizationDefinition['kind'];

export interface PersonalizationCenterProps {
  onActivateScenario?: (scenarioId: string) => void | Promise<void>;
}

function isDirectlyEditable(definition: PersonalizationDefinition): boolean {
  if (definition.provenance.origin !== 'user' || !definition.id.startsWith('user:')) return false;
  if (definition.provenance.sourceUrl !== null
    || definition.provenance.sourceRevision !== null
    || definition.provenance.installedDigest !== null) return false;
  if (definition.kind === 'mcp') return false;
  return definition.kind !== 'skill'
    || (definition.sourceMode === 'markdown' && definition.packageEntry === null);
}

const KIND_ORDER: Kind[] = ['scenario', 'skill', 'mcp', 'rules'];
const KIND_LABELS = {
  zh: { scenario: '场景', agent: '智能体', skill: '技能', mcp: 'MCP', rules: 'Metis.md' },
  en: { scenario: 'Scenarios', agent: 'Agents', skill: 'Skills', mcp: 'MCP', rules: 'Metis.md' },
} as const;

const LIBRARY_LABELS = {
  zh: { scenario: '场景库', agent: '智能体库', skill: '技能库', mcp: 'MCP 库', rules: 'Metis.md 库' },
  en: { scenario: 'Scenario library', agent: 'Agent library', skill: 'Skill library', mcp: 'MCP library', rules: 'Metis.md library' },
} as const;

/** 技能分类沿用场景的「category: 标签」机制（刘总 2026-09）：分类名存进定义 tags，随定义持久化。 */
const SKILL_CATEGORY_PREFIX = 'category:';
function skillCategoryOf(definition: PersonalizationDefinition): string {
  const marker = definition.tags.find((tag) => tag.startsWith(SKILL_CATEGORY_PREFIX));
  return marker?.slice(SKILL_CATEGORY_PREFIX.length).trim() ?? '';
}

const MEMORY_SCOPE_OPTIONS: ReadonlyArray<{
  value: AgentDefinition['memory']['scope'];
  zh: string;
  en: string;
}> = [
  { value: 'none', zh: '不保留', en: 'None' },
  { value: 'session', zh: '当前会话', en: 'Session' },
  { value: 'project', zh: '当前项目', en: 'Project' },
  { value: 'scenario', zh: '当前场景', en: 'Scenario' },
];




const PERSONALIZATION_DRAFT_PREFIX = 'metis:personalization-draft:v1:';
const PERSONALIZATION_DRAFT_DEBOUNCE_MS = 200;

interface StoredPersonalizationDraft {
  version: 1;
  baseRevision: number;
  draft: PersonalizationDefinition;
}

const volatilePersonalizationDrafts = new Map<string, StoredPersonalizationDraft>();
const volatileOnlyPersonalizationDraftIds = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDraftOutput(value: unknown): value is AgentDefinition['output'] {
  if (!isRecord(value)
    || typeof value.format !== 'string'
    || !('schema' in value)
    || (value.schema !== null && !isRecord(value.schema))
    || typeof value.requireEvidenceEnvelope !== 'boolean'
    || typeof value.includeIntegrityReport !== 'boolean') return false;
  if (value.plan === undefined || value.plan === null) return true;
  return isRecord(value.plan)
    && typeof value.plan.primaryDeliverable === 'string'
    && isStringArray(value.plan.supportingArtifacts)
    && isStringArray(value.plan.qualityCriteria);
}

function isDraftWorkflow(value: unknown): value is ScenarioDefinition['workflow'] {
  return Array.isArray(value) && value.every((step) => isRecord(step)
    && typeof step.id === 'string'
    && typeof step.name === 'string'
    && typeof step.description === 'string'
    && typeof step.agentId === 'string'
    && isStringArray(step.skillIds)
    && isStringArray(step.toolIds)
    && isStringArray(step.mcpIds)
    && isStringArray(step.dependsOn)
    && typeof step.maxTurns === 'number');
}

/**
 * Editor drafts deliberately accept temporarily incomplete business values (for example an empty
 * required name while it is being replaced). Stable structure is still checked so malformed
 * storage cannot reach the editor as an arbitrary object.
 */
function isPersonalizationEditorDraft(value: unknown): value is PersonalizationDefinition {
  if (!isRecord(value)
    || value.contractVersion !== 1
    || typeof value.id !== 'string'
    || !['scenario', 'agent', 'skill', 'mcp', 'rules'].includes(String(value.kind))
    || typeof value.name !== 'string'
    || typeof value.description !== 'string'
    || typeof value.enabled !== 'boolean'
    || !isStringArray(value.tags)
    || !Number.isSafeInteger(value.revision)
    || !DefinitionProvenanceSchema.safeParse(value.provenance).success) return false;

  if (value.kind === 'agent') {
    return typeof value.role === 'string'
      && typeof value.systemPrompt === 'string'
      && (value.modelPreference === null || typeof value.modelPreference === 'string')
      && isStringArray(value.skillIds)
      && isStringArray(value.toolIds)
      && isStringArray(value.mcpIds)
      && MemoryPolicySchema.safeParse(value.memory).success
      && isDraftOutput(value.output)
      && typeof value.maxTurns === 'number'
      && typeof value.retryLimit === 'number';
  }
  if (value.kind === 'skill') {
    return ['markdown', 'package', 'url'].includes(String(value.sourceMode))
      && typeof value.markdown === 'string'
      && typeof value.systemPrompt === 'string'
      && isStringArray(value.toolIds)
      && isStringArray(value.mcpIds)
      && typeof value.maxTurns === 'number'
      && (value.inputSchema === null || isRecord(value.inputSchema))
      && (value.outputSchema === null || isRecord(value.outputSchema))
      && (value.packageEntry === null || typeof value.packageEntry === 'string');
  }
  if (value.kind === 'scenario') {
    return isStringArray(value.agentIds)
      && isStringArray(value.skillIds)
      && isStringArray(value.mcpIds)
      && isStringArray(value.rulesIds)
      && isDraftWorkflow(value.workflow)
      && FullAccessPolicySchema.safeParse(value.fullAccess).success
      && MemoryPolicySchema.safeParse(value.memory).success
      && isDraftOutput(value.output)
      && isStringArray(value.triggerPhrases)
      && ['research', 'writing', 'analysis', 'funding', 'presentation_reserved', 'custom']
        .includes(String(value.capability));
  }
  if (value.kind === 'rules') {
    return ['global', 'scenario', 'project'].includes(String(value.scope))
      && (value.scopeId === null || typeof value.scopeId === 'string')
      && typeof value.markdown === 'string';
  }
  return PersonalizationDefinitionSchema.safeParse(value).success;
}

function personalizationDraftKey(definitionId: string): string {
  return `${PERSONALIZATION_DRAFT_PREFIX}${definitionId}`;
}

function parseStoredPersonalizationDraft(raw: string): StoredPersonalizationDraft | null {
  try {
    const candidate = JSON.parse(raw) as Partial<StoredPersonalizationDraft>;
    if (candidate.version !== 1 || !Number.isInteger(candidate.baseRevision)) return null;
    if (!isPersonalizationEditorDraft(candidate.draft)) return null;
    return { version: 1, baseRevision: candidate.baseRevision!, draft: candidate.draft };
  } catch {
    return null;
  }
}

function personalizationDefinitionSignature(definition: PersonalizationDefinition): string {
  const parsed = PersonalizationDefinitionSchema.safeParse(definition);
  return JSON.stringify(parsed.success ? parsed.data : definition);
}

function readPersonalizationDraft(definition: PersonalizationDefinition): PersonalizationDefinition | null {
  const key = personalizationDraftKey(definition.id);
  let stored = volatilePersonalizationDrafts.get(definition.id) ?? null;
  let durableStorageReadable = false;
  try {
    let raw = window.localStorage.getItem(key);
    durableStorageReadable = true;
    if (!raw) {
      raw = window.sessionStorage.getItem(key);
      if (raw) {
        window.localStorage.setItem(key, raw);
      }
    }
    if (raw) {
      stored = parseStoredPersonalizationDraft(raw);
      if (!stored) {
        clearPersonalizationDraft(definition.id);
        return null;
      }
      volatilePersonalizationDrafts.set(definition.id, stored);
    } else if (!volatileOnlyPersonalizationDraftIds.has(definition.id)) {
      volatilePersonalizationDrafts.delete(definition.id);
      stored = null;
    }
  } catch {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) stored = parseStoredPersonalizationDraft(raw);
    } catch {
      // The in-memory mirror remains available when browser storage is restricted.
    }
  }
  if (durableStorageReadable && stored) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // localStorage remains the durable copy when session storage is restricted.
    }
  }
  if (!stored
    || stored.baseRevision !== definition.revision
    || stored.draft.id !== definition.id
    || stored.draft.kind !== definition.kind) {
    if (stored) clearPersonalizationDraft(definition.id);
    return null;
  }
  return stored.draft;
}

function writePersonalizationDraft(
  definition: PersonalizationDefinition,
  draft: PersonalizationDefinition,
): void {
  const stored: StoredPersonalizationDraft = {
    version: 1,
    baseRevision: definition.revision,
    draft,
  };
  volatilePersonalizationDrafts.set(definition.id, stored);
  let persisted = false;
  try {
    const serialized = JSON.stringify(stored);
    window.localStorage.setItem(personalizationDraftKey(definition.id), serialized);
    persisted = true;
    window.sessionStorage.setItem(personalizationDraftKey(definition.id), serialized);
    volatileOnlyPersonalizationDraftIds.delete(definition.id);
  } catch {
    try {
      window.sessionStorage.setItem(personalizationDraftKey(definition.id), JSON.stringify(stored));
      persisted = true;
    } catch {
      // The in-memory mirror still protects navigation within this renderer session.
    }
    if (persisted) volatileOnlyPersonalizationDraftIds.delete(definition.id);
    else volatileOnlyPersonalizationDraftIds.add(definition.id);
  }
}

function clearPersonalizationDraft(definitionId: string): void {
  volatilePersonalizationDrafts.delete(definitionId);
  volatileOnlyPersonalizationDraftIds.delete(definitionId);
  try {
    window.localStorage.removeItem(personalizationDraftKey(definitionId));
    window.sessionStorage.removeItem(personalizationDraftKey(definitionId));
  } catch {
    try {
      window.sessionStorage.removeItem(personalizationDraftKey(definitionId));
    } catch {
      // A restricted storage implementation does not affect the in-memory cleanup.
    }
  }
}

function retainedPersonalizationDraftIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(PERSONALIZATION_DRAFT_PREFIX)) {
          ids.add(key.slice(PERSONALIZATION_DRAFT_PREFIX.length));
        }
      }
    }
    volatileOnlyPersonalizationDraftIds.forEach((id) => ids.add(id));
    volatilePersonalizationDrafts.forEach((_draft, id) => {
      if (!ids.has(id)) volatilePersonalizationDrafts.delete(id);
    });
  } catch {
    // The in-memory mirror is authoritative when browser storage is restricted.
    volatilePersonalizationDrafts.forEach((_draft, id) => ids.add(id));
  }
  return ids;
}



function editableCopy(definition: PersonalizationDefinition): PersonalizationDefinition {
  const now = Date.now();
  return {
    ...definition,
    revision: definition.revision + 1,
    provenance: {
      ...definition.provenance,
      locallyModified: true,
      updatedAt: now,
    },
  };
}

function rebasePersonalizationDraft(
  savedDefinition: PersonalizationDefinition,
  retainedDraft: PersonalizationDefinition,
): PersonalizationDefinition {
  const baseline = editableCopy(savedDefinition);
  if (retainedDraft.id !== savedDefinition.id || retainedDraft.kind !== savedDefinition.kind) {
    return baseline;
  }
  return {
    ...baseline,
    ...retainedDraft,
    contractVersion: savedDefinition.contractVersion,
    id: savedDefinition.id,
    kind: savedDefinition.kind,
    revision: baseline.revision,
    provenance: {
      ...baseline.provenance,
      ...retainedDraft.provenance,
      locallyModified: true,
      updatedAt: Math.max(retainedDraft.provenance.updatedAt, baseline.provenance.updatedAt),
    },
  } as PersonalizationDefinition;
}

function resultMessage(result: PersonalizationMutationResult, zh: boolean): string {
  if (result.ok) return zh ? '已保存' : 'Saved';
  const labels: Record<string, [string, string]> = {
    invalid_request: ['内容不符合严格合同', 'Content does not match the strict contract'],
    not_found: ['未找到定义', 'Definition not found'],
    factory_protected: ['内置原版受保护，请先创建可编辑副本', 'Built-in factory version is protected; create an editable copy'],
    revision_conflict: ['版本已变更，请刷新后重试', 'The definition changed; reload and try again'],
    dependency_invalid: ['引用的智能体、技能或 MCP 不可用', 'A referenced agent, skill, or MCP is unavailable'],
    io_error: ['持久化失败', 'Persistence failed'],
  };
  return (labels[result.code] ?? ['操作失败', 'Operation failed'])[zh ? 0 : 1];
}

function csv(values: readonly string[]): string { return values.join(', '); }
/** 回收站条目的剩余保留天数（向上取整，永不低于 0）。 */
function remainingTrashDays(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}
function parseCsv(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))];
}

function boundedInteger(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function DefinitionReferencePicker({
  label,
  help,
  kind,
  definitions,
  selectedIds,
  onChange,
  filter,
  emptyLabel,
  compact = false,
  onCreate,
  createLabel,
}: {
  label: string;
  help: string;
  kind: Kind;
  definitions: readonly PersonalizationDefinition[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  filter?: (definition: PersonalizationDefinition) => boolean;
  emptyLabel: string;
  compact?: boolean;
  onCreate?: () => void;
  createLabel?: string;
}) {
  const candidates = definitions.filter((definition) => (
    definition.kind === kind
    && (definition.enabled || selectedIds.includes(definition.id))
    && (!filter || filter(definition) || selectedIds.includes(definition.id))
  ));
  const selected = new Set(selectedIds);
  return <fieldset className={`personalization-reference-picker${compact ? ' is-compact' : ''}`}>
    <legend>{label}</legend>
    <p>{help}</p>
    {candidates.length === 0
      ? <div className="personalization-reference-picker__empty">
          <span>{emptyLabel}</span>
          {onCreate && <button type="button" className="btn-sm btn-secondary" onClick={onCreate} data-testid={`quick-create-${kind}`}>{createLabel ?? (kind === 'agent' ? '新建智能体' : kind === 'skill' ? '新建技能' : kind === 'mcp' ? '新建 MCP' : '新建 Metis.md')}</button>}
        </div>
      : <div className="personalization-reference-picker__options">
          {candidates.map((definition) => <label key={definition.id} data-definition-id={definition.id}>
            <input
              type="checkbox"
              checked={selected.has(definition.id)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selectedIds, definition.id]
                  : selectedIds.filter((id) => id !== definition.id);
                onChange([...new Set(next)]);
              }}
            />
            <span>
              <strong>{definition.name}</strong>
              <small>{definition.provenance.origin === 'builtin' ? 'Metis' : (definition.description || definition.id)}</small>
            </span>
          </label>)}
        </div>}
  </fieldset>;
}

type SimpleSchemaFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

const SIMPLE_SCHEMA_TYPE_OPTIONS: ReadonlyArray<{
  value: SimpleSchemaFieldType;
  zh: string;
  en: string;
}> = [
  { value: 'string', zh: '文本', en: 'Text' },
  { value: 'number', zh: '数值', en: 'Number' },
  { value: 'integer', zh: '整数', en: 'Integer' },
  { value: 'boolean', zh: '是 / 否', en: 'Yes / No' },
  { value: 'array', zh: '列表', en: 'List' },
  { value: 'object', zh: '对象', en: 'Object' },
];
interface SimpleSchemaField {
  name: string;
  type: SimpleSchemaFieldType;
  description: string;
  required: boolean;
}

const SIMPLE_SCHEMA_DRAFT_ROWS_KEY = 'x-metis-visual-schema-draft-rows';
const SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY = 'x-metis-visual-schema-replacement';

interface SimpleSchemaDraftState {
  rows: SimpleSchemaField[];
  preserveEmptyObject: boolean;
}

interface SimpleSchemaReplacementDraft extends SimpleSchemaDraftState {
  original: Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSimpleSchemaField(value: unknown): value is SimpleSchemaField {
  const record = recordValue(value);
  return record !== null
    && typeof record.name === 'string'
    && ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(String(record.type))
    && typeof record.description === 'string'
    && typeof record.required === 'boolean';
}

function isSimpleSchemaRowsValid(rows: readonly SimpleSchemaField[]): boolean {
  const names = rows.map((row) => row.name.trim());
  return names.every((name) => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name))
    && new Set(names).size === names.length;
}

function readSimpleSchemaDraftState(value: unknown): SimpleSchemaDraftState | null {
  if (Array.isArray(value)) {
    return value.every(isSimpleSchemaField) ? { rows: value, preserveEmptyObject: false } : null;
  }
  const record = recordValue(value);
  if (!record
    || !Array.isArray(record.rows)
    || !record.rows.every(isSimpleSchemaField)
    || typeof record.preserveEmptyObject !== 'boolean') return null;
  return { rows: record.rows, preserveEmptyObject: record.preserveEmptyObject };
}

function readInvalidSimpleSchemaDraft(schema: Record<string, unknown> | null): SimpleSchemaDraftState | null {
  if (schema === null || Object.keys(schema).length !== 1) return null;
  return readSimpleSchemaDraftState(schema[SIMPLE_SCHEMA_DRAFT_ROWS_KEY]);
}

function buildInvalidSimpleSchemaDraft(
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject: boolean,
): Record<string, unknown> {
  return { [SIMPLE_SCHEMA_DRAFT_ROWS_KEY]: { rows, preserveEmptyObject } };
}

function readSimpleSchemaReplacementDraft(
  schema: Record<string, unknown> | null,
): SimpleSchemaReplacementDraft | null {
  if (schema === null || Object.keys(schema).length !== 1) return null;
  const replacement = recordValue(schema[SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY]);
  const state = readSimpleSchemaDraftState(replacement);
  const original = recordValue(replacement?.original);
  return replacement && state && original ? { ...state, original } : null;
}

function buildSimpleSchemaReplacementDraft(
  original: Record<string, unknown>,
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject: boolean,
): Record<string, unknown> {
  return {
    [SIMPLE_SCHEMA_REPLACEMENT_DRAFT_KEY]: {
      original,
      rows,
      preserveEmptyObject,
    },
  };
}

function readSimpleSchema(schema: Record<string, unknown> | null): SimpleSchemaField[] | null {
  if (schema === null) return [];
  const invalidDraft = readInvalidSimpleSchemaDraft(schema);
  if (invalidDraft) return invalidDraft.rows;
  const replacementDraft = readSimpleSchemaReplacementDraft(schema);
  if (replacementDraft) return replacementDraft.rows;
  if (schema.type !== 'object') return null;
  const topLevelKeys = Object.keys(schema);
  if (topLevelKeys.length !== 4
    || !['type', 'additionalProperties', 'properties', 'required']
      .every((key) => Object.hasOwn(schema, key))
    || schema.additionalProperties !== false
    || !Array.isArray(schema.required)
    || !schema.required.every((item) => typeof item === 'string')
    || new Set(schema.required).size !== schema.required.length) return null;
  const properties = recordValue(schema.properties);
  if (!properties) return null;
  const required = new Set(schema.required);
  if ([...required].some((name) => !Object.hasOwn(properties, name))) return null;
  const supported = new Set<SimpleSchemaFieldType>(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  const rows: SimpleSchemaField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = recordValue(rawProperty);
    if (!property
      || typeof property.type !== 'string'
      || !supported.has(property.type as SimpleSchemaFieldType)
      || Object.keys(property).some((key) => key !== 'type' && key !== 'description')
      || (property.description !== undefined
        && (typeof property.description !== 'string'
          || property.description.length === 0
          || property.description.trim() !== property.description))) return null;
    rows.push({
      name,
      type: property.type as SimpleSchemaFieldType,
      description: typeof property.description === 'string' ? property.description : '',
      required: required.has(name),
    });
  }
  return rows;
}

function isStrictEmptySimpleSchema(schema: Record<string, unknown> | null): boolean {
  if (!schema || readInvalidSimpleSchemaDraft(schema) || readSimpleSchemaReplacementDraft(schema)) return false;
  const parsed = readSimpleSchema(schema);
  return parsed !== null && parsed.length === 0 && schema !== null;
}

function buildSimpleSchema(
  rows: readonly SimpleSchemaField[],
  preserveEmptyObject = false,
): Record<string, unknown> | null {
  if (rows.length === 0 && !preserveEmptyObject) return null;
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(rows.map((row) => [row.name, {
      type: row.type,
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    }])),
    required: rows.filter((row) => row.required).map((row) => row.name),
  };
}

function SimpleSchemaEditor({
  label,
  value,
  onChange,
  onValidityChange,
  zh,
}: {
  label: string;
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
  onValidityChange: (valid: boolean) => void;
  zh: boolean;
}) {
  const parsed = readSimpleSchema(value);
  const invalidDraft = readInvalidSimpleSchemaDraft(value);
  const restoredReplacement = readSimpleSchemaReplacementDraft(value);
  const [rows, setRows] = useState<SimpleSchemaField[]>(parsed ?? []);
  const [unsupported, setUnsupported] = useState(parsed === null);
  const [replacementOriginal, setReplacementOriginal] = useState<Record<string, unknown> | null>(
    restoredReplacement?.original ?? null,
  );
  const [replacementMode, setReplacementMode] = useState(restoredReplacement !== null);
  const [preserveEmptyObject, setPreserveEmptyObject] = useState(
    invalidDraft?.preserveEmptyObject
      ?? restoredReplacement?.preserveEmptyObject
      ?? isStrictEmptySimpleSchema(value),
  );
  const [error, setError] = useState(invalidDraft
    ? (zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.')
    : '');

  const commit = (next: SimpleSchemaField[]) => {
    setRows(next);
    const names = next.map((row) => row.name.trim());
    const valid = isSimpleSchemaRowsValid(next);
    if (!valid) {
      setError(zh ? '字段名必须唯一，以字母或下划线开头。' : 'Field names must be unique and start with a letter or underscore.');
      onChange(replacementMode && replacementOriginal
        ? buildSimpleSchemaReplacementDraft(replacementOriginal, next, preserveEmptyObject)
        : buildInvalidSimpleSchemaDraft(next, preserveEmptyObject));
      onValidityChange(false);
      return;
    }
    setError('');
    const normalizedRows = next.map((row, index) => ({ ...row, name: names[index]! }));
    if (replacementMode && replacementOriginal) {
      onChange(buildSimpleSchemaReplacementDraft(replacementOriginal, normalizedRows, preserveEmptyObject));
      onValidityChange(false);
    } else {
      onChange(buildSimpleSchema(normalizedRows, preserveEmptyObject));
      onValidityChange(true);
    }
  };

  if (unsupported) return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    <div className="personalization-boundary"><strong>{zh ? '已保留现有复杂结构' : 'Existing advanced schema preserved'}</strong><span>{zh ? '此结构超出可视化字段编辑器范围。只有明确选择替换时才会清空。' : 'This schema is more complex than the visual field editor. It remains unchanged unless you explicitly replace it.'}</span></div>
    <button type="button" onClick={() => {
      if (!value) return;
      setUnsupported(false);
      setRows([]);
      setError('');
      setReplacementOriginal(value);
      setReplacementMode(true);
      setPreserveEmptyObject(true);
      onChange(buildSimpleSchemaReplacementDraft(value, [], true));
      onValidityChange(false);
    }}>{zh ? '替换为可视化字段' : 'Replace with visual fields'}</button>
  </fieldset>;

  return <fieldset className="personalization-schema-editor">
    <legend>{label}</legend>
    {replacementMode && replacementOriginal && <div className="personalization-boundary">
      <strong>{zh ? '可视化替换尚未应用' : 'Visual replacement not applied'}</strong>
      <span>{zh ? '原始高级结构仍可恢复。应用替换后才能保存定义。' : 'The original advanced schema remains recoverable. Apply the replacement before saving the definition.'}</span>
      <div className="personalization-actions">
        <button type="button" onClick={() => {
          setRows([]);
          setError('');
          setReplacementMode(false);
          setReplacementOriginal(null);
          setUnsupported(true);
          setPreserveEmptyObject(false);
          onChange(replacementOriginal);
          onValidityChange(true);
        }}>{zh ? '取消替换' : 'Cancel replacement'}</button>
        <button type="button" disabled={!isSimpleSchemaRowsValid(rows)} onClick={() => {
          const names = rows.map((row) => row.name.trim());
          const normalizedRows = rows.map((row, index) => ({ ...row, name: names[index]! }));
          setRows(normalizedRows);
          setReplacementMode(false);
          setReplacementOriginal(null);
          setError('');
          onChange(buildSimpleSchema(normalizedRows, preserveEmptyObject));
          onValidityChange(true);
        }}>{zh ? '应用可视化替换' : 'Apply visual replacement'}</button>
      </div>
    </div>}
    <p>{zh ? '逐项定义字段；Metis 会生成严格结构，不需要直接编写 JSON。' : 'Define fields one by one. Metis builds a strict schema without raw JSON editing.'}</p>
    <div className="personalization-schema-fields">
      {rows.map((row, index) => <div className="personalization-schema-field" key={`schema-field-${index}`}>
        <label><span>{zh ? '字段名' : 'Field name'}</span><input value={row.name} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label>
        <label><span>{zh ? '类型' : 'Type'}</span><select value={row.type} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as SimpleSchemaFieldType } : item))}>{SIMPLE_SCHEMA_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
        <label className="personalization-schema-field__description"><span>{zh ? '说明' : 'Description'}</span><input value={row.description} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /></label>
        <label className="personalization-schema-field__required"><input type="checkbox" checked={row.required} onChange={(event) => commit(rows.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />{zh ? '必填' : 'Required'}</label>
        <button type="button" onClick={() => commit(rows.filter((_item, itemIndex) => itemIndex !== index))}>{zh ? '删除' : 'Remove'}</button>
      </div>)}
    </div>
    {error && <p className="personalization-schema-error" role="alert">{error}</p>}
    <button type="button" onClick={() => {
      let ordinal = rows.length + 1;
      while (rows.some((row) => row.name === `field_${ordinal}`)) ordinal += 1;
      commit([...rows, { name: `field_${ordinal}`, type: 'string', description: '', required: false }]);
    }}>{zh ? '添加字段' : 'Add field'}</button>
  </fieldset>;
}


function SecretVaultPanel({ vault }: { vault: PersonalizationSecretVaultHandle }) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const busy = vault.busy;

  const loadStatus = !vault.available
    ? (zh ? '加密凭据库不可用' : 'Encrypted credential vault is unavailable')
    : vault.loadError === 'ipc'
      ? (zh ? '无法连接加密凭据库，请重试。' : 'The encrypted credential vault could not be reached. Try again.')
      : vault.loadError
        ? `${zh ? '无法读取凭据元数据' : 'Credential metadata unavailable'}: ${vault.loadError}`
        : '';

  const save = async () => {
    const result = await vault.save(name.trim(), value);
    if (!result.ok) {
      setStatus(result.transport
        ? (zh ? '保存未完成，凭据值仍保留在输入框中，可直接重试。' : 'Save did not complete. The credential value remains in the field so you can retry.')
        : `${zh ? '保存失败' : 'Save failed'}: ${result.code}`);
      return;
    }
    setValue('');
    setName('');
    setStatus(zh ? '凭据已由操作系统加密保存；值不会回显' : 'Credential encrypted by the operating system; values are never displayed');
  };

  const remove = async (secretName: string) => {
    const result = await vault.remove(secretName);
    if (!result.ok) {
      setStatus(result.transport
        ? (zh ? '删除未完成，请重试。' : 'Remove did not complete. Try again.')
        : `${zh ? '删除失败' : 'Remove failed'}: ${result.code}`);
      return;
    }
    setStatus(zh ? '凭据已删除' : 'Credential removed');
  };

  return <section className="personalization-installer" aria-label={zh ? '加密凭据库' : 'Encrypted credential vault'}>
    <div className="personalization-installer__header">
      <div><span className="personalization-eyebrow">{zh ? '凭据' : 'SECRETS'}</span><h2>{zh ? 'MCP 凭据' : 'MCP credentials'}</h2></div>
      <span>{zh ? '值仅在主进程通过系统安全存储加密；界面和配置包只使用 ${secret:NAME} 引用。' : 'Values are encrypted through OS secure storage in the main process; UI and bundles use only ${secret:NAME} references.'}</span>
    </div>
    {/* 刘总反馈（2026-10）：全局面板弱化为后备，说明这是不归属任何具体 MCP 的通用凭据。 */}
    <p className="personalization-installer__mode-help">{zh ? '通用凭据（不属于任何具体 MCP）。单个 MCP 的凭据请在该 MCP 条目的「凭据」入口录入。' : 'Shared credentials (not tied to any specific MCP). Enter per-MCP credentials from the "Credentials" entry on each MCP item.'}</p>
    <div className="personalization-grid personalization-grid--2">
      <label><span>{zh ? '环境变量名称' : 'Environment name'}</span><input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="ZOTERO_API_KEY" autoComplete="off" spellCheck={false} /></label>
      <label><span>{zh ? '凭据值' : 'Credential value'}</span><input type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" /></label>
    </div>
    <div className="personalization-actions"><button className="btn-primary" type="button" disabled={busy || !name.trim() || !value} onClick={() => void save()}>{zh ? '加密保存' : 'Save encrypted'}</button><span role="status" aria-live="polite">{status || loadStatus}</span></div>
    <div className="personalization-cards">
      {vault.secrets.map((secret) => <article className="personalization-card" key={secret.name}>
        <div className="personalization-card__select"><strong>{secret.name}</strong><span>{zh ? '值已隐藏' : 'Value hidden'} · {new Date(secret.updatedAt).toLocaleString()}</span></div>
        <div className="personalization-card__actions"><button type="button" disabled={busy} onClick={() => void remove(secret.name)}>{zh ? '删除' : 'Remove'}</button></div>
      </article>)}
      {vault.secrets.length === 0 && <p className="personalization-empty">{zh ? '还没有保存凭据。' : 'No credentials saved.'}</p>}
    </div>
  </section>;
}

function DefinitionEditor({
  definition,
  definitions,
  onSaved,
  onDraftStateChange,
  onQuickCreate,
}: {
  definition: PersonalizationDefinition;
  definitions: readonly PersonalizationDefinition[];
  onSaved: (saved?: PersonalizationDefinition) => Promise<void>;
  onDraftStateChange: (definitionId: string, retained: boolean) => void;
  /** 场景编辑器空状态里的「新建 X」跳转（创建后返回场景并重新选中）。 */
  onQuickCreate?: (kind: Kind) => void;
}) {
  const { locale, t } = useTranslation();
  const zh = locale === 'zh';
  const [initialDraftState] = useState(() => {
    const fresh = editableCopy(definition);
    const retained = readPersonalizationDraft(definition);
    return { fresh, draft: retained ?? fresh, restored: retained !== null };
  });
  const [draft, setDraft] = useState<PersonalizationDefinition>(initialDraftState.draft);
  const [inputSchemaValid, setInputSchemaValid] = useState(
    initialDraftState.draft.kind !== 'skill'
      || (readInvalidSimpleSchemaDraft(initialDraftState.draft.inputSchema) === null
        && readSimpleSchemaReplacementDraft(initialDraftState.draft.inputSchema) === null),
  );
  const [outputSchemaValid, setOutputSchemaValid] = useState(
    initialDraftState.draft.kind !== 'skill'
      || (readInvalidSimpleSchemaDraft(initialDraftState.draft.outputSchema) === null
        && readSimpleSchemaReplacementDraft(initialDraftState.draft.outputSchema) === null),
  );
  const baselineSignatureRef = useRef(JSON.stringify(initialDraftState.fresh));
  const baseDefinitionRef = useRef(definition);
  const latestDraftRef = useRef(initialDraftState.draft);
  const observedDraftRef = useRef(initialDraftState.draft);
  const draftPersistenceTimerRef = useRef<number | null>(null);
  const draftPersistencePendingRef = useRef(false);
  const savedRevisionReloadPendingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draftRetention, setDraftRetention] = useState<'preserved' | 'restored' | null>(
    initialDraftState.restored ? 'restored' : null,
  );
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<PersonalizationVersionView[]>([]);
  // Metis.md 保存方式选择：存为副本（保留原件）/ 覆盖原件。
  const [rulesSaveChoiceOpen, setRulesSaveChoiceOpen] = useState(false);
  const factoryProtected = definition.provenance.origin === 'builtin' || definition.id.startsWith('builtin:');

  const loadVersions = useCallback(async () => {
    try {
      const response = await window.metis?.listPersonalizationVersions?.({ contractVersion: 1, id: definition.id });
      setVersions(response?.versions ?? []);
    } catch {
      setVersions([]);
      setStatus(zh ? '无法读取版本历史，但当前草稿仍可编辑。' : 'Version history could not be loaded, but the current draft remains editable.');
    }
  }, [definition.id, zh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void loadVersions(); });
    return () => { cancelled = true; };
  }, [loadVersions]);

  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    const stackedLayout = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1120px)').matches
      : window.innerWidth <= 1120;
    if (stackedLayout && typeof heading.scrollIntoView === 'function') {
      heading.scrollIntoView({ block: 'start', inline: 'nearest' });
    }
  }, [definition.id, definition.revision]);

  const flushPendingDraft = useCallback((updateEditorState = true) => {
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
      draftPersistenceTimerRef.current = null;
    }
    if (!draftPersistencePendingRef.current) return;
    draftPersistencePendingRef.current = false;

    const baseDefinition = baseDefinitionRef.current;
    const latestDraft = latestDraftRef.current;
    const draftSignature = personalizationDefinitionSignature(latestDraft);
    if (draftSignature === baselineSignatureRef.current) {
      clearPersonalizationDraft(baseDefinition.id);
      onDraftStateChange(baseDefinition.id, false);
      if (updateEditorState) setDraftRetention(null);
      return;
    }
    writePersonalizationDraft(baseDefinition, latestDraft);
    onDraftStateChange(baseDefinition.id, true);
    if (updateEditorState) setDraftRetention('preserved');
  }, [onDraftStateChange]);

  useEffect(() => {
    latestDraftRef.current = draft;
    if (observedDraftRef.current === draft) return;
    observedDraftRef.current = draft;
    draftPersistencePendingRef.current = true;
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
    }
    onDraftStateChange(definition.id, true);
    setDraftRetention('preserved');
    if (savedRevisionReloadPendingRef.current) {
      flushPendingDraft(true);
      return;
    }
    draftPersistenceTimerRef.current = window.setTimeout(() => {
      flushPendingDraft(true);
    }, PERSONALIZATION_DRAFT_DEBOUNCE_MS);
  }, [definition.id, draft, flushPendingDraft, onDraftStateChange]);

  useEffect(() => () => {
    flushPendingDraft(false);
  }, [flushPendingDraft]);

  const finishSuccessfulMutation = async (
    submittedSignature: string,
    savedDefinition: PersonalizationDefinition,
  ) => {
    flushPendingDraft(false);
    const parsedSavedDefinition = PersonalizationDefinitionSchema.safeParse(savedDefinition);
    if (!parsedSavedDefinition.success) {
      await onSaved();
      return;
    }
    const persistedDefinition = parsedSavedDefinition.data;
    const retained = latestDraftRef.current;
    const hasNewerEdits = personalizationDefinitionSignature(retained) !== submittedSignature;
    const nextDraft = hasNewerEdits
      ? rebasePersonalizationDraft(persistedDefinition, retained)
      : editableCopy(persistedDefinition);

    baseDefinitionRef.current = persistedDefinition;
    baselineSignatureRef.current = personalizationDefinitionSignature(editableCopy(persistedDefinition));
    latestDraftRef.current = nextDraft;
    observedDraftRef.current = nextDraft;
    setDraft(nextDraft);
    if (hasNewerEdits) {
      writePersonalizationDraft(persistedDefinition, nextDraft);
      onDraftStateChange(persistedDefinition.id, true);
      setDraftRetention('preserved');
    } else {
      clearPersonalizationDraft(persistedDefinition.id);
      onDraftStateChange(persistedDefinition.id, false);
      setDraftRetention(null);
    }
    savedRevisionReloadPendingRef.current = true;
    try {
      await onSaved(persistedDefinition);
    } finally {
      savedRevisionReloadPendingRef.current = false;
    }
  };

  const updateCommon = (patch: Partial<Pick<PersonalizationDefinition, 'name' | 'description' | 'enabled'>>) => {
    setDraft((current) => ({ ...current, ...patch } as PersonalizationDefinition));
  };

  const updateWorkflowStep = (index: number, patch: Partial<ScenarioDefinition['workflow'][number]>) => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const previousId = current.workflow[index]?.id;
      const nextId = patch.id;
      return {
        ...current,
        workflow: current.workflow.map((step, stepIndex) => {
          const updatedStep = stepIndex === index ? { ...step, ...patch } : step;
          if (!previousId || nextId === undefined || nextId === previousId) return updatedStep;
          return {
            ...updatedStep,
            dependsOn: updatedStep.dependsOn.map((dependencyId) => dependencyId === previousId ? nextId : dependencyId),
          };
        }),
      };
    });
  };

  const addWorkflowStep = () => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const stepNumber = current.workflow.reduce((maximum, step) => {
        const match = /^step-(\d+)$/u.exec(step.id);
        if (!match) return maximum;
        const suffix = Number(match[1]);
        return Number.isSafeInteger(suffix) ? Math.max(maximum, suffix) : maximum;
      }, current.workflow.length) + 1;
      return {
        ...current,
        workflow: [...current.workflow, {
          id: `step-${stepNumber}`,
          name: zh ? `步骤 ${stepNumber}` : `Step ${stepNumber}`,
          description: '',
          skillIds: [],
          toolIds: [],
          mcpIds: [],
          dependsOn: current.workflow.length ? [current.workflow[current.workflow.length - 1]?.id ?? ''] : [],
          maxTurns: 12,
        }],
      };
    });
  };

  const removeWorkflowStep = (index: number) => {
    setDraft((current) => {
      if (current.kind !== 'scenario') return current;
      const removedId = current.workflow[index]?.id;
      if (!removedId) return current;
      return {
        ...current,
        workflow: current.workflow
          .filter((_step, stepIndex) => stepIndex !== index)
          .map((step) => ({
            ...step,
            dependsOn: step.dependsOn.filter((dependencyId) => dependencyId !== removedId),
          })),
      };
    });
  };

  const save = async () => {
    if (draft.kind === 'skill' && (!inputSchemaValid || !outputSchemaValid)) {
      setStatus(zh
        ? '请先修正字段名称；当前编辑已保留，但不会提交旧结构。'
        : 'Correct the field names first. Your edits are preserved and the previous schema will not be submitted.');
      return;
    }
    if (draft.kind === 'scenario'
      && draft.output.plan != null
      && !draft.output.plan.primaryDeliverable.trim()) {
      setStatus(t('personalization.outputPrimaryRequiredSave'));
      return;
    }
    if (!window.metis?.savePersonalization) {
      setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable');
      return;
    }
    flushPendingDraft(false);
    const submittedSignature = personalizationDefinitionSignature(draft);
    setSaving(true);
    try {
      if (draft.kind === 'skill' && draft.sourceMode === 'markdown' && window.metis.applyPersonalizationExtension) {
        const result = await window.metis.applyPersonalizationExtension({
        contractVersion: 1,
        mode: 'skill_markdown',
        operationId: crypto.randomUUID(),
        expectedRevision: definition.revision,
        id: draft.id,
        name: draft.name,
        description: draft.description,
        author: draft.provenance.author,
        version: draft.provenance.version,
        markdown: draft.markdown,
        toolIds: draft.toolIds,
        mcpIds: draft.mcpIds,
        tags: draft.tags,
        maxTurns: draft.maxTurns,
        inputSchema: draft.inputSchema,
        outputSchema: draft.outputSchema,
      });
        setStatus(result.ok
          ? (zh ? '已保存，并写入签名来源记录' : 'Saved with a signed source record')
          : `${zh ? '保存失败' : 'Save failed'}: ${result.code}`);
        if (result.ok) {
          await finishSuccessfulMutation(submittedSignature, result.definition);
        }
        return;
      }
      const result = await window.metis.savePersonalization({
        contractVersion: 1,
        definition: draft,
        expectedRevision: definition.revision,
      });
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await finishSuccessfulMutation(submittedSignature, result.definition);
      }
    } catch {
      setStatus(zh
        ? '保存未完成：无法连接个性化服务，你的本地编辑已保留。'
        : 'Save did not complete: the personalization service could not be reached. Your local edits are preserved.');
    } finally {
      setSaving(false);
    }
  };

  const restore = async (sourceRevision: number) => {
    flushPendingDraft(false);
    const submittedSignature = personalizationDefinitionSignature(draft);
    try {
      const result = await window.metis?.restorePersonalization?.({
        contractVersion: 1,
        id: definition.id,
        sourceRevision,
        expectedRevision: definition.revision,
      });
      if (!result) {
        setStatus(zh ? '版本恢复服务不可用。' : 'Version restore service is unavailable.');
        return;
      }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await finishSuccessfulMutation(submittedSignature, result.definition);
      }
    } catch {
      setStatus(zh ? '版本恢复未完成，当前内容未改变。' : 'Version restore did not complete; the current content is unchanged.');
    }
  };

  // Metis.md 存为副本：以当前草稿内容 fork 出新文档（原件不动），保存后切换选中到副本。
  const saveRulesAsCopy = async () => {
    if (draft.kind !== 'rules') return;
    if (!window.metis?.savePersonalization) {
      setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable');
      return;
    }
    setRulesSaveChoiceOpen(false);
    setSaving(true);
    try {
      let copy = {
        ...draft,
        id: availableUserId('rules', `${draft.name} copy`, definitions),
        revision: 1,
        provenance: {
          ...draft.provenance,
          origin: 'user' as const,
          parentId: definition.id,
          parentVersion: definition.provenance.version,
          sourceUrl: null,
          sourceRevision: null,
          installedDigest: null,
          locallyModified: true,
          updatedAt: Date.now(),
        },
      } as PersonalizationDefinition;
      let result = await window.metis.savePersonalization({ contractVersion: 1, definition: copy, expectedRevision: 0 });
      if (!result.ok && result.code === 'revision_conflict') {
        // 默认 id 被归档记录占用：换唯一 id 重试一次。
        copy = { ...copy, id: `${copy.id}-${Date.now().toString(36)}` };
        result = await window.metis.savePersonalization({ contractVersion: 1, definition: copy, expectedRevision: 0 });
      }
      if (!result.ok || result.code !== 'saved' || !result.definition) {
        setStatus(`${zh ? '副本保存失败' : 'Copy save failed'}: ${result.code ?? 'unknown'}`);
        return;
      }
      setStatus(zh ? '已存为副本，原件保持不变。' : 'Saved as a copy; the original is unchanged.');
      flushPendingDraft(false);
      await onSaved(result.definition);
    } catch {
      setStatus(zh ? '副本保存未完成，请重试。' : 'Copy save did not complete. Retry.');
    } finally {
      setSaving(false);
    }
  };

  const presentationReserved = draft.kind === 'scenario'
    && draft.capability === 'presentation_reserved';
  const schemaEditorsValid = draft.kind !== 'skill' || (inputSchemaValid && outputSchemaValid);
  // UX: 场景的「最终交付物」只保留一个普通文本字段，避免复杂的输出计划表单。
  const scenarioDeliverable = draft.kind === 'scenario'
    ? (draft.output.plan?.primaryDeliverable ?? '')
    : '';
  const updateScenarioDeliverable = (value: string) => {
    if (draft.kind !== 'scenario') return;
    const next = value.trim();
    const existing = draft.output.plan;
    setDraft({
      ...draft,
      output: {
        ...draft.output,
        plan: next
          ? {
              primaryDeliverable: next,
              supportingArtifacts: existing?.supportingArtifacts ?? [],
              qualityCriteria: existing?.qualityCriteria ?? [],
            }
          : null,
      },
    });
  };

  return (
    <section className="personalization-editor" aria-label={zh ? '定义编辑器' : 'Definition editor'}>
      <div className="personalization-editor__header">
        <div>
          <span className="personalization-eyebrow">{KIND_LABELS[zh ? 'zh' : 'en'][draft.kind]}</span>
          <h2 ref={headingRef} tabIndex={-1}>{draft.name}</h2>
          <code>{draft.id}</code>
        </div>
        <div className="personalization-editor__header-actions">
          <span className="personalization-revision">r{definition.revision}</span>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || !draft.name.trim() || !schemaEditorsValid}
            onClick={() => { if (draft.kind === 'rules') setRulesSaveChoiceOpen(true); else void save(); }}
          >
            {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
          </button>
        </div>
      </div>
      <p className="personalization-draft-notice" role="status" aria-live="polite">
        {draftRetention === 'restored'
          ? (zh ? '已恢复保留的草稿' : 'Preserved draft restored')
          : draftRetention === 'preserved'
            ? (zh ? '草稿已自动保留' : 'Draft preserved automatically')
            : ''}
      </p>
      <label>
        <span>{zh ? '名称' : 'Name'}</span>
        <input value={draft.name} maxLength={200} onChange={(event) => updateCommon({ name: event.target.value })} />
      </label>
      <label>
        <span>{zh ? '说明' : 'Description'}</span>
        <textarea value={draft.description} rows={3} maxLength={4000} onChange={(event) => updateCommon({ description: event.target.value })} />
      </label>
      {!presentationReserved && <label className="personalization-switch">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => updateCommon({ enabled: event.target.checked })} />
        <span>{zh ? '启用此定义' : 'Enable this definition'}</span>
      </label>}

      {presentationReserved && <div className="personalization-boundary" role="note">
        <strong>{zh ? 'PPT 场景仅保留空间' : 'Presentation scenario is reserved only'}</strong>
        <span>{zh
          ? '在你确认 PPT 产品方案之前，这里只允许修改名称与说明，不会启用或挂载智能体、技能、MCP、触发词与工作流。'
          : 'Until its product specification is approved, only the name and description may be edited. Agents, Skills, MCPs, triggers, and workflows remain unavailable.'}</span>
      </div>}

      {draft.kind === 'skill' && <>
        <div className="personalization-boundary" role="note"><strong>{zh ? 'Markdown 技能直接编辑' : 'Direct Markdown skill editing'}</strong><span>{zh ? '这里适合编写或修改单文件技能。ZIP、文件夹和 GitHub / URL 技能请使用上方安装器，来源与脚本才能一起保存。' : 'Use this editor for a single-file skill. Install ZIP, folder, or GitHub / URL skills through the installer above so their source and scripts are preserved together.'}</span></div>
        <label><span>{zh ? '技能 Markdown' : 'Skill Markdown'}</span><textarea rows={16} value={draft.markdown} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })} /></label>
        <label><span>{zh ? '系统指令' : 'System instructions'}</span><textarea rows={8} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></label>
        <label><span>{zh ? '允许的工具 ID（逗号或换行）' : 'Allowed tool IDs (comma or newline)'}</span><textarea rows={3} value={csv(draft.toolIds)} onChange={(event) => setDraft({ ...draft, toolIds: parseCsv(event.target.value) })} /></label>
        <DefinitionReferencePicker label={zh ? '允许此技能使用的 MCP' : 'MCP available to this skill'} help={zh ? '按名称选择；不需要手工复制 ID。' : 'Choose by name; no ID copying is required.'} kind="mcp" definitions={definitions} selectedIds={draft.mcpIds} onChange={(mcpIds) => setDraft({ ...draft, mcpIds })} emptyLabel={zh ? '还没有可用的 MCP。' : 'No MCP definitions are available.'} />
        <label><span>{zh ? '最大轮次' : 'Maximum turns'}</span><input type="number" min={1} max={100} value={draft.maxTurns} onChange={(event) => setDraft({ ...draft, maxTurns: boundedInteger(event.target.value, 1, 100, draft.maxTurns) })} /></label>
        <div className="personalization-grid personalization-grid--2">
          <SimpleSchemaEditor key={`${definition.id}:${definition.revision}:input`} label={zh ? '输入字段' : 'Input fields'} value={draft.inputSchema} onChange={(inputSchema) => setDraft({ ...draft, inputSchema })} onValidityChange={setInputSchemaValid} zh={zh} />
          <SimpleSchemaEditor key={`${definition.id}:${definition.revision}:output`} label={zh ? '输出字段' : 'Output fields'} value={draft.outputSchema} onChange={(outputSchema) => setDraft({ ...draft, outputSchema })} onValidityChange={setOutputSchemaValid} zh={zh} />
        </div>
      </>}

      {draft.kind === 'scenario' && !presentationReserved && <>
        <div className="personalization-boundary">
          <strong>{zh ? '全权限运行' : 'Full Access'}</strong>
          <span>{zh ? '运行时不做逐步权限确认，允许用户随时发消息引导或打断。' : 'No per-action permission prompts; the user may steer or interrupt at any time.'}</span>
        </div>
        <DefinitionReferencePicker label={zh ? '场景可使用的技能' : 'Skills available to this scenario'} help={zh ? '工作流步骤只能从这些技能中选择。' : 'Workflow steps can choose from this scenario-level set.'} kind="skill" definitions={definitions} selectedIds={draft.skillIds} onChange={(skillIds) => setDraft({ ...draft, skillIds, workflow: draft.workflow.map((step) => ({ ...step, skillIds: step.skillIds.filter((id) => skillIds.includes(id)) })) })} emptyLabel={zh ? '还没有可用技能。' : 'No skills are available.'} onCreate={onQuickCreate ? () => onQuickCreate('skill') : undefined} createLabel={zh ? '新建技能' : 'Create a skill'} />
        <DefinitionReferencePicker label={zh ? '场景可使用的 MCP' : 'MCP available to this scenario'} help={zh ? '工作流步骤只能从这些 MCP 中选择。' : 'Workflow steps can choose from this scenario-level set.'} kind="mcp" definitions={definitions} selectedIds={draft.mcpIds} onChange={(mcpIds) => setDraft({ ...draft, mcpIds, workflow: draft.workflow.map((step) => ({ ...step, mcpIds: step.mcpIds.filter((id) => mcpIds.includes(id)) })) })} emptyLabel={zh ? '还没有可用 MCP。' : 'No MCP definitions are available.'} onCreate={onQuickCreate ? () => onQuickCreate('mcp') : undefined} createLabel={zh ? '新建 MCP' : 'Create an MCP'} />
        <DefinitionReferencePicker label={zh ? '场景专属 Metis.md' : 'Scenario-specific Metis.md'} help={zh ? '全局 Metis.md 会自动生效；这里只选择绑定到该场景的规则。项目 Metis.md 由“当前项目 Metis.md”独立管理。' : 'Global Metis.md applies automatically. Select only scenario-bound rules here; project Metis.md is managed separately.'} kind="rules" definitions={definitions} selectedIds={draft.rulesIds} onChange={(rulesIds) => setDraft({ ...draft, rulesIds })} filter={(candidate) => candidate.kind === 'rules' && candidate.scope === 'scenario' && candidate.scopeId === draft.id} emptyLabel={zh ? '还没有绑定到此场景的 Metis.md。' : 'No Metis.md definition is bound to this scenario yet.'} onCreate={onQuickCreate ? () => onQuickCreate('rules') : undefined} createLabel={zh ? '新建 Metis.md' : 'Create a Metis.md'} />
        <div className="personalization-grid personalization-grid--2">
          <label><span>{zh ? '记忆范围' : 'Memory scope'}</span><select value={draft.memory.scope} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, scope: event.target.value as ScenarioDefinition['memory']['scope'] } })}>{MEMORY_SCOPE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option[zh ? 'zh' : 'en']}</option>)}</select></label>
          <label><span>{zh ? '记忆摘要上限' : 'Memory summary limit'}</span><input type="number" min={1000} max={500000} value={draft.memory.maxSummaryChars} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, maxSummaryChars: boundedInteger(event.target.value, 1000, 500000, draft.memory.maxSummaryChars) } })} /></label>
        </div>
        <div className="personalization-inline-checks">
          <label><input type="checkbox" checked={draft.memory.retainDecisions} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainDecisions: event.target.checked } })} />{zh ? '保留场景决策摘要' : 'Retain scenario decisions'}</label>
          <label><input type="checkbox" checked={draft.memory.retainArtifacts} onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retainArtifacts: event.target.checked } })} />{zh ? '保留场景产物索引' : 'Retain scenario artifacts'}</label>
        </div>
        <details className="personalization-deliverable" open={Boolean(scenarioDeliverable)}>
          <summary>{zh ? '最终交付物（可选）' : 'Final deliverable (optional)'}</summary>
          <p className="personalization-deliverable__help">{zh ? '填写后，模型完成工作流后会按此汇总最终结果；不填则直接汇总最后一步的输出。' : 'If filled, the model summarizes the final result against this deliverable after the workflow finishes; otherwise the last step output is summarized.'}</p>
          <label><span>{zh ? '交付物描述' : 'Deliverable description'}</span><textarea rows={2} value={scenarioDeliverable} onChange={(event) => updateScenarioDeliverable(event.target.value)} placeholder={zh ? '例如：一份关于地方救济制度演变的综述报告' : 'e.g. A review report on the evolution of local relief systems'} /></label>
        </details>
        <div className="personalization-truth-lock" role="note"><strong>{zh ? '真实性底座自动生效' : 'Truth controls apply automatically'}</strong><span>{zh ? '证据封装、完整性报告、引用与来源状态不提供关闭开关。' : 'Evidence envelopes, integrity reports, citation checks, and source-state checks cannot be disabled here.'}</span></div>
        <div className="personalization-workflow">
          <div className="personalization-workflow__header"><div><strong>{zh ? '工作流步骤' : 'Workflow steps'}</strong><p>{zh ? '依赖关系决定真实执行顺序；失败步骤会阻断其下游。' : 'Dependencies define execution order; failed steps block downstream work.'}</p></div><button type="button" onClick={addWorkflowStep}>{zh ? '添加步骤' : 'Add step'}</button></div>
          {draft.workflow.map((step, index) => <article className="personalization-step" key={`${step.id}-${index}`}>
            <div className="personalization-step__title"><strong>{index + 1}. {step.name || step.id}</strong><button type="button" onClick={() => removeWorkflowStep(index)}>{zh ? '移除' : 'Remove'}</button></div>
            <div className="personalization-grid personalization-grid--2">
              <label><span>ID</span><input value={step.id} onChange={(event) => updateWorkflowStep(index, { id: event.target.value })} /></label>
              <label><span>{zh ? '名称' : 'Name'}</span><input value={step.name} onChange={(event) => updateWorkflowStep(index, { name: event.target.value })} /></label>
              <label><span>{zh ? '依赖步骤 ID' : 'Dependency step IDs'}</span><input value={csv(step.dependsOn)} onChange={(event) => updateWorkflowStep(index, { dependsOn: parseCsv(event.target.value) })} /></label>
            </div>
            <label><span>{zh ? '步骤说明' : 'Step description'}</span><textarea rows={2} value={step.description} onChange={(event) => updateWorkflowStep(index, { description: event.target.value })} /></label>
            <div className="personalization-grid personalization-grid--2">
              <DefinitionReferencePicker compact label={zh ? '步骤技能' : 'Step skills'} help={zh ? '从场景已允许的技能中选择。' : 'Choose from skills allowed by the scenario.'} kind="skill" definitions={definitions} selectedIds={step.skillIds} onChange={(skillIds) => updateWorkflowStep(index, { skillIds })} filter={(candidate) => draft.skillIds.includes(candidate.id)} emptyLabel={zh ? '请先为场景选择技能。' : 'Select scenario skills first.'} />
              <label><span>{zh ? '工具 ID' : 'Tool IDs'}</span><textarea rows={2} value={csv(step.toolIds)} onChange={(event) => updateWorkflowStep(index, { toolIds: parseCsv(event.target.value) })} /></label>
              <DefinitionReferencePicker compact label={zh ? '步骤 MCP' : 'Step MCP'} help={zh ? '从场景已允许的 MCP 中选择。' : 'Choose from MCP allowed by the scenario.'} kind="mcp" definitions={definitions} selectedIds={step.mcpIds} onChange={(mcpIds) => updateWorkflowStep(index, { mcpIds })} filter={(candidate) => draft.mcpIds.includes(candidate.id)} emptyLabel={zh ? '请先为场景选择 MCP。' : 'Select scenario MCP first.'} />
              <label><span>{zh ? '最大轮次' : 'Maximum turns'}</span><input type="number" min={1} max={100} value={step.maxTurns} onChange={(event) => updateWorkflowStep(index, { maxTurns: boundedInteger(event.target.value, 1, 100, step.maxTurns) })} /></label>
            </div>
          </article>)}
        </div>
      </>}

      {draft.kind === 'rules' && <>
        <label><span>Metis.md</span><textarea rows={20} value={draft.markdown} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })} data-testid="personalization-rules-markdown" /></label>
      </>}

      {draft.kind === 'mcp' && <>
        <label><span>{zh ? 'MCP 来源模式' : 'MCP source mode'}</span><select value={draft.sourceMode} onChange={(event) => setDraft({ ...draft, sourceMode: event.target.value as McpDefinition['sourceMode'] })}><option value="generated">{zh ? '描述需求，由 Metis 构建' : 'Describe requirements; Metis builds it'}</option><option value="url">{zh ? 'URL / GitHub 地址' : 'URL / GitHub'}</option></select></label>
        <div className="personalization-boundary"><strong>{zh ? '托管运行时' : 'Managed runtime'}</strong><span>{zh ? '启动程序、参数和工作目录由已验证安装记录决定，不能在界面中替换为任意命令。' : 'Executable, arguments, and working directory come from the verified installation record and cannot be replaced with arbitrary commands.'}</span></div>
        <label><span>{zh ? '安装来源（只读）' : 'Installation source (read-only)'}</span><input value={draft.sourceUrl ?? ''} readOnly /></label>
      </>}

      <div className="personalization-actions">
        <button className="btn-primary" disabled={saving || !draft.name.trim() || !schemaEditorsValid} onClick={() => { if (draft.kind === 'rules') setRulesSaveChoiceOpen(true); else void save(); }}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存新版本' : 'Save new revision')}</button>
        <span role="status" aria-live="polite">{status}</span>
      </div>
      {rulesSaveChoiceOpen && draft.kind === 'rules' && (
        <div className="personalization-rules-save-choice" role="dialog" aria-modal="true" aria-label={zh ? '选择保存方式' : 'Choose save method'} data-testid="rules-save-choice">
          <strong>{zh ? '保存 Metis.md' : 'Save Metis.md'}</strong>
          <span>{zh ? '存为副本（保留原件，创建一份新的可编辑文档），还是覆盖原件？' : 'Save as a copy (keep the original in a new editable document) or overwrite the original?'}</span>
          <div className="personalization-rules-save-choice__actions">
            <button type="button" className="btn-secondary" onClick={() => setRulesSaveChoiceOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
            <button
              type="button"
              className="btn-secondary"
              disabled={factoryProtected}
              title={factoryProtected ? (zh ? '内置原版受保护，只能存为副本。' : 'The factory original is protected; only a copy can be saved.') : undefined}
              onClick={() => { setRulesSaveChoiceOpen(false); void save(); }}
              data-testid="rules-save-overwrite"
            >{zh ? '覆盖原件' : 'Overwrite original'}</button>
            <button type="button" className="btn-primary" onClick={() => void saveRulesAsCopy()} data-testid="rules-save-copy">{zh ? '存为副本' : 'Save as copy'}</button>
          </div>
        </div>
      )}
      <details className="personalization-history">
        <summary>{zh ? `版本历史（${versions.length}）` : `Version history (${versions.length})`}</summary>
        <div>
          {versions.map((version) => (
            <article key={version.revision}>
              <span><strong>r{version.revision}</strong><code>{version.contentDigest.slice(0, 12)}</code></span>
              <time>{new Date(version.createdAt).toLocaleString()}</time>
              {version.revision !== definition.revision && <button onClick={() => void restore(version.revision)}>{zh ? '恢复此版本' : 'Restore this version'}</button>}
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

export default function PersonalizationCenter({ onActivateScenario }: PersonalizationCenterProps = {}) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [definitions, setDefinitions] = useState<PersonalizationDefinition[]>([]);
  const [archivedDefinitions, setArchivedDefinitions] = useState<ArchivedPersonalizationDefinition[]>([]);
  const [integrityIssues, setIntegrityIssues] = useState<PersonalizationIntegrityIssue[]>([]);
  const [recoveringIntegrityIssueId, setRecoveringIntegrityIssueId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('scenario');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 技能工坊对话弹窗：context 非空表示「选中已安装技能做定制化优化」。 */
  const [skillStudio, setSkillStudio] = useState<{ context: PersonalizationDefinition | null } | null>(null);
  /** MCP 构建对话弹窗：context 非空表示基于已安装 MCP 优化。 */
  const [mcpBuilder, setMcpBuilder] = useState<{ context: PersonalizationDefinition | null } | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draftIds, setDraftIds] = useState<Set<string>>(() => retainedPersonalizationDraftIds());
  /** 技能库两步删除确认：记录处于「待确认永久删除」状态的卡片 id。 */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  /** 库面板视图：items=正常列表，trash=回收站（技能/MCP/Metis.md 共用）。 */
  const [libraryMode, setLibraryMode] = useState<'items' | 'trash'>('items');
  /** 回收站条目的两步「彻底删除」确认 id。 */
  const [trashDeleteId, setTrashDeleteId] = useState<string | null>(null);
  // 刘总反馈（2026-10）：MCP 凭据改为按条目录入；这里共享一份凭据库元数据（仅名称，不含值），
  // 供全局面板、条目上的「凭据未配置」标记与条目内录入区共用，避免重复 IPC。
  const mcpSecrets = usePersonalizationSecrets(kind === 'mcp');
  /** 当前展开凭据录入区的 MCP 条目 id。 */
  const [secretsEditorId, setSecretsEditorId] = useState<string | null>(null);
  // 模板识别（论文结构）：粘贴模板 → AI 解析为逐节写作指引 → 用户修改后保存。
  const [tplOpen, setTplOpen] = useState(false);
  const [tplText, setTplText] = useState('');
  const [tplBusy, setTplBusy] = useState(false);
  const [tplStatus, setTplStatus] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplSections, setTplSections] = useState<Array<{ title: string; instruction: string }>>([]);
  /** 场景编辑器空状态「新建 X」跳转后，保存成功时返回场景并重新选中。 */
  const pendingReturnRef = useRef<{ createdKind: Kind; createdId: string; returnSelectedId: string | null } | null>(null);
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const mcpActivationDependencies = useMemo<McpActivationPanelDependencies>(() => ({
    activateMcp: async (request) => (
      window.metis?.activatePersonalizationMcp?.(request) ?? null
    ),
  }), []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const list = window.metis?.listPersonalization;
      if (!list) throw new Error('personalization bridge unavailable');
      const response = await list({ contractVersion: 1, includeDisabled: true });
      const next = response.definitions;
      setDefinitions(next);
      let issues: PersonalizationIntegrityIssue[] = [];
      try {
        const integrity = await window.metis?.listPersonalizationIntegrityIssues?.({ contractVersion: 1 });
        issues = integrity?.issues ?? [];
      } catch {
        // The verified catalog stays usable even if diagnostics are unavailable.
      }
      setIntegrityIssues(issues);
      // The current preload exposes this call.  Keeping its failure isolated
      // lets an older running desktop shell keep its active scene list usable
      // during a hot renderer refresh; it never fabricates trash data.
      let archived: ArchivedPersonalizationDefinition[] = [];
      try {
        // 全量回收站：场景、技能、MCP 与 Metis.md 共用同一保留窗口。
        const trash = await window.metis?.listPersonalizationTrash?.({ contractVersion: 1 });
        archived = trash?.definitions ?? [];
      } catch {
        // The primary definition list above remains authoritative and usable.
      }
      setArchivedDefinitions(archived);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : null);
    } catch {
      setLoadError(zh
        ? '无法加载个性化配置。已保留当前页面，可直接重试。'
        : 'Personalization configurations could not be loaded. The current page is preserved and you can retry.');
    } finally {
      setLoading(false);
    }
  }, [zh]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; };
  }, [load]);

  const userDefinitions = useMemo(
    () => definitions.filter((item) => item.provenance.origin !== 'builtin'),
    [definitions],
  );
  /** 场景工作台可见定义：用户定义 + 预装技能/MCP（不含预置场景）。 */
  const workbenchDefinitions = useMemo(
    () => definitions.filter((item) => item.provenance.origin !== 'builtin' || item.kind === 'skill' || item.kind === 'mcp'),
    [definitions],
  );
  const visibleIntegrityIssues = useMemo(() => integrityIssues.filter((issue) => issue.kind === kind), [integrityIssues, kind]);
  const recoverIntegrityIssue = useCallback(async (issue: PersonalizationIntegrityIssue) => {
    if (issue.latestVerifiedRevision === null) {
      setStatus(zh ? '该异常场景没有可验证的历史版本，已保持隔离，不能自动恢复。' : 'This quarantined item has no verified history and remains isolated.');
      return;
    }
    const recover = window.metis?.recoverPersonalizationIntegrityIssue;
    if (!recover) {
      setStatus(zh ? '安全恢复服务不可用。' : 'The trusted recovery service is unavailable.');
      return;
    }
    setRecoveringIntegrityIssueId(issue.id);
    try {
      const result = await recover({
        contractVersion: 1,
        id: issue.id,
        sourceRevision: issue.latestVerifiedRevision,
        expectedCurrentRevision: issue.currentRevision,
      });
      if (!result.ok || result.code !== 'saved') {
        setStatus(zh ? `恢复未完成：${result.code}` : `Recovery did not complete: ${result.code}`);
        return;
      }
      setStatus(zh ? `已从已验证的 r${issue.latestVerifiedRevision} 创建新的可信版本。异常快照已隔离保存。` : `Published a new trusted version from verified r${issue.latestVerifiedRevision}; the quarantined snapshot was retained.`);
      await load();
    } catch {
      setStatus(zh ? '恢复服务暂时不可用，异常数据仍保持隔离。' : 'Recovery is unavailable; the quarantined data remains isolated.');
    } finally {
      setRecoveringIntegrityIssueId(null);
    }
  }, [load, zh]);
  const filtered = useMemo(() => userDefinitions.filter((item) => item.kind === kind), [userDefinitions, kind]);
  /** 已安装管理区含预装/内置定义（卡片标注「内置」）；选中内置项走「创建可编辑副本」流程。 */
  const libraryDefinitions = useMemo(() => definitions.filter((item) => item.kind === kind), [definitions, kind]);
  const selected = definitions.find((item) => item.id === selectedId) ?? null;
  /** 技能分类分组（category: 标签，刘总 2026-09）；未分类排在最后。 */
  const skillGroups = useMemo(() => {
    const groups = new Map<string, PersonalizationDefinition[]>();
    for (const definition of libraryDefinitions) {
      const category = skillCategoryOf(definition);
      const list = groups.get(category) ?? [];
      list.push(definition);
      groups.set(category, list);
    }
    return [...groups.entries()].sort(([left], [right]) => {
      if (left === '') return 1;
      if (right === '') return -1;
      return left.localeCompare(right, zh ? 'zh-CN' : 'en');
    });
  }, [libraryDefinitions, zh]);
  const skillCategories = useMemo(
    () => skillGroups.map(([category]) => category).filter(Boolean),
    [skillGroups],
  );
  /** 当前 kind 的回收站条目（归档时间倒序由持久层保证）。 */
  const archivedForKind = useMemo(
    () => archivedDefinitions.filter((item) => item.definition.kind === kind),
    [archivedDefinitions, kind],
  );

  const handleDraftStateChange = useCallback((definitionId: string, retained: boolean) => {
    setDraftIds((current) => {
      if (current.has(definitionId) === retained) return current;
      const next = new Set(current);
      if (retained) next.add(definitionId);
      else next.delete(definitionId);
      return next;
    });
  }, []);

  const afterExtensionInstall = async (definitionId: string) => {
    await load();
    setSelectedId(definitionId);
  };

  const saveNew = async (definition: PersonalizationDefinition) => {
    try {
      // 新建时若 id 被历史（含已删除/归档）记录占用，后端返回 revision_conflict；改用唯一 id 重试，保证「新建」总能成功。
      let active = definition;
      let result = await window.metis?.savePersonalization({ contractVersion: 1, definition: active, expectedRevision: 0 });
      if (result && !result.ok && result.code === 'revision_conflict') {
        active = { ...definition, id: `${definition.id}-${Date.now().toString(36)}` };
        result = await window.metis?.savePersonalization({ contractVersion: 1, definition: active, expectedRevision: 0 });
      }
      if (!result) { setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable'); return null; }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await load();
        setSelectedId(result.definition.id);
        return result.definition;
      }
      return null;
    } catch {
      setStatus(zh ? '新建未完成，没有创建半成品。请重试。' : 'Creation did not complete and no partial definition was created. Try again.');
      return null;
    }
  };

  const create = async () => {
    const defaultName = zh ? `我的${KIND_LABELS.zh[kind]}` : `My ${KIND_LABELS.en[kind]}`;
    const definition = createDefinition(kind, defaultName, definitions);
    // Metis.md 固定项目级：project 作用域要求 scopeId（resolver 以 user:projects/<projectId> 匹配）。
    if (definition.kind === 'rules') {
      definition.scope = 'project';
      definition.scopeId = `user:projects/${activeProjectId ?? 'unbound'}`;
    }
    await saveNew(definition);
  };

  // 场景编辑器空状态「新建 X」：切换到对应类型创建，保存后自动回到场景。
  const quickCreate = async (targetKind: Kind) => {
    const returnSelectedId = selectedId;
    const created = createDefinition(
      targetKind,
      zh ? `我的${KIND_LABELS.zh[targetKind]}` : `My ${KIND_LABELS.en[targetKind]}`,
      definitions,
    );
    if (created.kind === 'rules') {
      created.scope = 'project';
      created.scopeId = `user:projects/${activeProjectId ?? 'unbound'}`;
    }
    pendingReturnRef.current = { createdKind: targetKind, createdId: created.id, returnSelectedId };
    setKind(targetKind);
    await saveNew(created);
  };

  const handleEditorSaved = async (saved?: PersonalizationDefinition) => {
    await load();
    const pending = pendingReturnRef.current;
    if (pending && saved && saved.kind === pending.createdKind && saved.id === pending.createdId) {
      pendingReturnRef.current = null;
      setKind('scenario');
      setSelectedId(pending.returnSelectedId);
      setStatus(zh ? '已创建，回到场景继续配置。' : 'Created; back to the scenario to continue.');
      return;
    }
    if (saved && saved.id !== selectedId) {
      // Metis.md 存为副本：切换选中到新副本继续编辑。
      setSelectedId(saved.id);
    }
  };

  const updateTplSection = (index: number, field: 'title' | 'instruction', value: string) => {
    setTplSections((prev) => prev.map((section, i) => (i === index ? { ...section, [field]: value } : section)));
  };

  const removeTplSection = (index: number) => {
    setTplSections((prev) => prev.filter((_, i) => i !== index));
  };

  const parsePaperTemplate = async () => {
    const text = tplText.trim();
    if (text.length < 10) {
      setTplStatus(zh ? '请先粘贴论文结构模板文本。' : 'Paste a paper template first.');
      return;
    }
    if (!window.metis?.aiParsePaperTemplate) {
      setTplStatus(zh ? '模板解析服务不可用，请检查模型连接后重试。' : 'Template parsing is unavailable. Check the model connection and retry.');
      return;
    }
    setTplBusy(true);
    setTplStatus('');
    try {
      const result = await window.metis.aiParsePaperTemplate({ text });
      if (!result.ok || !result.sections || result.sections.length < 3) {
        setTplStatus(zh
          ? `模板解析失败（${result.code ?? 'parse_failed'}），请调整模板文本后重试。`
          : `Template parse failed (${result.code ?? 'parse_failed'}). Adjust the text and retry.`);
        return;
      }
      setTplSections(result.sections);
      setTplName(zh ? '解析的论文模板' : 'Parsed paper template');
      setTplStatus(zh
        ? `解析出 ${result.sections.length} 个章节，可逐节修改写作指引后保存。`
        : `Parsed ${result.sections.length} sections; edit each writing guide and save.`);
    } catch {
      setTplStatus(zh ? '模板解析未完成，请重试。' : 'Template parsing did not complete. Try again.');
    } finally {
      setTplBusy(false);
    }
  };

  // 模板识别支持两种方式：粘贴文本，或上传文件（txt/md/docx/pdf，复用材料导入读取文本）。
  const importTemplateFile = async () => {
    if (!window.metis?.openReferenceFileDialog || !window.metis?.importScenarioMaterials) {
      setTplStatus(zh ? '文件导入服务不可用。' : 'File import is unavailable.');
      return;
    }
    setTplBusy(true);
    setTplStatus('');
    try {
      const paths = await window.metis.openReferenceFileDialog();
      if (!paths || paths.length === 0) { setTplBusy(false); return; }
      const result = await window.metis.importScenarioMaterials({ contractVersion: 1, paths });
      if (!result?.ok || !result.materials || result.materials.length === 0) {
        setTplStatus(zh ? ('文件读取失败：' + (result?.error ?? result?.code ?? 'import_failed')) : ('File read failed: ' + (result?.error ?? result?.code ?? 'import_failed')));
        return;
      }
      const combined = result.materials.map((material) => material.text).filter(Boolean).join('\n\n');
      setTplText((prev) => (prev.trim() ? prev + '\n\n' + combined : combined));
      setTplStatus(zh ? ('已读取 ' + result.materials.length + ' 个文件，文本已填入。') : ('Loaded ' + result.materials.length + ' file(s) into the text box.'));
    } catch {
      setTplStatus(zh ? '文件导入未完成，请重试。' : 'File import did not complete. Try again.');
    } finally {
      setTplBusy(false);
    }
  };

  const savePaperTemplate = async () => {
    const name = tplName.trim();
    if (!name || tplSections.length === 0) return;
    const result = await window.metis?.structureSave?.({
      id: `structure-${Date.now().toString(36)}`,
      name,
      sections: tplSections.map((section, index) => ({
        id: `sec-${index + 1}`,
        title: section.title,
        instruction: section.instruction,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isDefault: false,
    });
    setTplStatus(result?.ok
      ? (zh ? `已保存论文结构「${name}」，可在自主科研中使用。` : `Paper structure "${name}" saved — usable in autonomous research.`)
      : (zh ? '保存失败，请重试。' : 'Save failed, please retry.'));
  };

  const fork = async (definition: PersonalizationDefinition) => {
    try {
      const result = await window.metis?.forkPersonalization({
        contractVersion: 1,
        sourceId: definition.id,
        targetId: availableUserId(definition.kind, `${definition.name} copy`, definitions),
        author: 'Local user',
      });
      if (!result) { setStatus(zh ? '副本服务不可用。' : 'Copy service is unavailable.'); return; }
      setStatus(resultMessage(result, zh));
      if (result.ok && result.code === 'saved') {
        await load();
        setSelectedId(result.definition.id);
      }
    } catch {
      setStatus(zh ? '创建可编辑副本失败，内置原版未改变。' : 'The editable copy could not be created; the factory original is unchanged.');
    }
  };

  const archive = async (definition: PersonalizationDefinition): Promise<{ ok: boolean; message?: string }> => {
    try {
      const result = await window.metis?.archivePersonalization({ contractVersion: 1, id: definition.id, expectedRevision: definition.revision });
      if (!result) {
        const message = zh ? '归档服务不可用。' : 'Archive service is unavailable.';
        setStatus(message);
        return { ok: false, message };
      }
      const message = result.ok
        ? (definition.kind === 'scenario'
          ? (zh ? '已移入回收站，可在 7 天内恢复。' : 'Moved to Trash. You can restore it within 7 days.')
          : (zh ? '已移入归档；内置原版始终保留' : 'Archived; the factory original remains available'))
        : resultMessage(result, zh);
      setStatus(message);
      if (result.ok) {
        clearPersonalizationDraft(definition.id);
        handleDraftStateChange(definition.id, false);
        await load();
      }
      return { ok: result.ok, message };
    } catch {
      const message = zh ? '归档未完成，定义仍保留。' : 'Archive did not complete; the definition remains available.';
      setStatus(message);
      return { ok: false, message };
    }
  };

  /** 永久删除技能：连同全部版本历史与已安装包文件，操作不可恢复。 */
  const deleteSkillPermanently = async (definition: PersonalizationDefinition): Promise<void> => {
    try {
      if (typeof window.metis?.deletePersonalization !== 'function') {
        // 运行中的外壳早于本功能：接口缺失时给出可执行指引，而不是含糊的失败。
        setStatus(zh
          ? '当前 METIS 外壳版本较旧，尚未包含删除接口。请完全退出应用后重新启动，让新外壳加载后再删除。'
          : 'The running app shell predates the delete API. Fully quit and restart METIS, then try again.');
        setPendingDeleteId(null);
        return;
      }
      const result = await window.metis.deletePersonalization({
        contractVersion: 1,
        id: definition.id,
        expectedRevision: definition.revision,
      });
      if (!result) {
        setStatus(zh ? '删除服务不可用，技能仍保留。' : 'The delete service is unavailable; the skill remains.');
        return;
      }
      if (result.ok) {
        setStatus(zh
          ? `已永久删除技能「${definition.name}」，该操作不可恢复。`
          : `Skill "${definition.name}" was permanently deleted. This cannot be undone.`);
        clearPersonalizationDraft(definition.id);
        handleDraftStateChange(definition.id, false);
        if (selectedId === definition.id) setSelectedId(null);
        await load();
      } else if (result.code === 'dependency_invalid') {
        const count = result.issues.length;
        setStatus(zh
          ? `无法删除：该技能仍被 ${count} 个配置引用，请先在相关场景或智能体中移除引用再删除。`
          : `Cannot delete: still referenced by ${count} configuration(s); remove those references first.`);
      } else {
        setStatus(resultMessage(result, zh));
      }
    } catch {
      setStatus(zh ? '删除未完成，技能仍保留。' : 'Delete did not complete; the skill remains available.');
    } finally {
      setPendingDeleteId(null);
    }
  };

  /** 设置技能分类（category: 标签机制）：写入 tags 后走与编辑器一致的签名保存通道。 */
  const saveSkillCategory = async (definition: PersonalizationDefinition, category: string): Promise<void> => {
    if (definition.kind !== 'skill') return;
    const clean = category.trim().replace(/\s+/gu, ' ');
    if (clean === skillCategoryOf(definition)) return;
    const tags = [
      ...definition.tags.filter((tag) => !tag.startsWith(SKILL_CATEGORY_PREFIX)),
      ...(clean ? [`${SKILL_CATEGORY_PREFIX}${clean}`] : []),
    ];
    const next = {
      ...editableCopy(definition),
      tags,
    } as Extract<PersonalizationDefinition, { kind: 'skill' }>;
    try {
      if (next.sourceMode === 'markdown' && window.metis?.applyPersonalizationExtension) {
        const result = await window.metis.applyPersonalizationExtension({
          contractVersion: 1,
          mode: 'skill_markdown',
          operationId: crypto.randomUUID(),
          expectedRevision: definition.revision,
          id: next.id,
          name: next.name,
          description: next.description,
          author: next.provenance.author,
          version: next.provenance.version,
          markdown: next.markdown,
          toolIds: next.toolIds,
          mcpIds: next.mcpIds,
          tags: next.tags,
          maxTurns: next.maxTurns,
          inputSchema: next.inputSchema,
          outputSchema: next.outputSchema,
        });
        setStatus(result.ok
          ? (zh ? `已归类到「${clean || '未分类'}」` : `Moved to "${clean || 'Uncategorized'}"`)
          : `${zh ? '分类保存失败' : 'Category save failed'}: ${result.code}`);
        if (result.ok) await load();
        return;
      }
      const result = await window.metis?.savePersonalization({
        contractVersion: 1,
        definition: next,
        expectedRevision: definition.revision,
      });
      if (!result) { setStatus(zh ? '个性化服务不可用' : 'Personalization service is unavailable'); return; }
      setStatus(result.ok ? (zh ? `已归类到「${clean || '未分类'}」` : `Moved to "${clean || 'Uncategorized'}"`) : resultMessage(result, zh));
      if (result.ok) await load();
    } catch {
      setStatus(zh ? '分类保存未完成，请重试。' : 'Category save did not complete; retry.');
    }
  };

  /** 恢复回收站中的定义（技能/MCP/Metis.md）：原样恢复，不改动任何已保存内容。 */
  const restoreFromLibraryTrash = async (item: ArchivedPersonalizationDefinition): Promise<void> => {
    try {
      if (typeof window.metis?.restorePersonalizationFromTrash !== 'function') {
        setStatus(zh
          ? '当前 METIS 外壳版本较旧，尚未包含回收站恢复接口。请完全退出应用后重新启动，让新外壳加载后再试。'
          : 'The running app shell predates the trash restore API. Fully quit and restart METIS, then try again.');
        return;
      }
      const result = await window.metis.restorePersonalizationFromTrash({
        contractVersion: 1,
        id: item.definition.id,
        expectedRevision: item.definition.revision,
      });
      if (!result) {
        setStatus(zh ? '回收站恢复服务不可用。' : 'The trash restore service is unavailable.');
        return;
      }
      if (result.ok && result.code === 'restored') {
        setStatus(zh ? `已恢复到${LIBRARY_LABELS[zh ? 'zh' : 'en'][kind]}。` : `Restored to the ${LIBRARY_LABELS[zh ? 'zh' : 'en'][kind]}.`);
        setLibraryMode('items');
        await load();
        setSelectedId(item.definition.id);
      } else {
        setStatus(resultMessage(result, zh));
      }
    } catch {
      setStatus(zh ? '恢复未完成，内容仍在回收站。' : 'Restore did not complete; the item remains in Trash.');
    }
  };

  /** 彻底删除回收站条目：连同全部版本历史与已安装包文件，操作不可恢复。 */
  const deleteFromLibraryTrash = async (item: ArchivedPersonalizationDefinition): Promise<void> => {
    try {
      if (typeof window.metis?.deletePersonalization !== 'function') {
        setStatus(zh
          ? '当前 METIS 外壳版本较旧，尚未包含删除接口。请完全退出应用后重新启动，让新外壳加载后再试。'
          : 'The running app shell predates the delete API. Fully quit and restart METIS, then try again.');
        setTrashDeleteId(null);
        return;
      }
      const result = await window.metis.deletePersonalization({
        contractVersion: 1,
        id: item.definition.id,
        expectedRevision: item.definition.revision,
      });
      if (!result) {
        setStatus(zh ? '删除服务不可用，内容仍在回收站。' : 'The delete service is unavailable; the item remains in Trash.');
        return;
      }
      if (result.ok) {
        setStatus(zh ? `已彻底删除「${item.definition.name}」，该操作不可恢复。` : `"${item.definition.name}" was permanently deleted. This cannot be undone.`);
        clearPersonalizationDraft(item.definition.id);
        handleDraftStateChange(item.definition.id, false);
        await load();
      } else if (result.code === 'dependency_invalid') {
        const count = result.issues.length;
        setStatus(zh
          ? `无法删除：仍被 ${count} 个配置引用，请先移除相关引用。`
          : `Cannot delete: still referenced by ${count} configuration(s); remove those references first.`);
      } else {
        setStatus(resultMessage(result, zh));
      }
    } catch {
      setStatus(zh ? '删除未完成，内容仍在回收站。' : 'Delete did not complete; the item remains in Trash.');
    } finally {
      setTrashDeleteId(null);
    }
  };

  const restoreScenarioFromTrash = async (id: string): Promise<{ ok: boolean; message?: string }> => {
    const item = archivedDefinitions.find((candidate) => candidate.definition.id === id && candidate.definition.kind === 'scenario');
    if (!item) {
      const message = zh ? '回收站中未找到该场景；请刷新后重试。' : 'The scenario was not found in Trash. Refresh and try again.';
      setStatus(message);
      return { ok: false, message };
    }
    try {
      const result = await window.metis?.restorePersonalizationFromTrash?.({
        contractVersion: 1,
        id: item.definition.id,
        expectedRevision: item.definition.revision,
      });
      if (!result) {
        const message = zh ? '回收站恢复服务不可用。' : 'Trash restore service is unavailable.';
        setStatus(message);
        return { ok: false, message };
      }
      const message = result.ok && result.code === 'restored'
        ? (zh ? '已恢复到场景列表。' : 'Restored to the scenario list.')
        : resultMessage(result, zh);
      setStatus(message);
      if (result.ok && result.code === 'restored') {
        await load();
        setSelectedId(result.definition.id);
      }
      return { ok: result.ok, message };
    } catch {
      const message = zh ? '恢复未完成，场景仍在回收站。' : 'Restore did not complete; the scenario remains in Trash.';
      setStatus(message);
      return { ok: false, message };
    }
  };

  const exportBundle = async () => {
    if (!selected) {
      setStatus(zh ? '请先选择要导出的根定义' : 'Choose a root definition to export');
      return;
    }
    try {
      const result = await window.metis?.exportPersonalizationBundle?.({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        rootDefinitionIds: [selected.id],
      });
      if (!result) { setStatus(zh ? '配置包服务不可用' : 'Bundle service is unavailable'); return; }
      setStatus(result.ok
        ? (zh ? `已导出 ${result.definitionCount} 个相互依赖的定义` : `Exported ${result.definitionCount} linked definitions`)
        : result.code === 'cancelled' ? (zh ? '已取消导出' : 'Export cancelled') : `${zh ? '导出失败' : 'Export failed'}: ${result.code}`);
    } catch {
      setStatus(zh ? '导出未完成，未写出不完整配置包。' : 'Export did not complete; no partial bundle was written.');
    }
  };

  const importBundle = async () => {
    try {
      const result = await window.metis?.importPersonalizationBundle?.({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
      });
      if (!result) { setStatus(zh ? '配置包服务不可用' : 'Bundle service is unavailable'); return; }
      if (!result.ok) {
        setStatus(result.code === 'cancelled' ? (zh ? '已取消导入' : 'Import cancelled') : `${zh ? '导入失败' : 'Import failed'}: ${result.code}`);
        return;
      }
      setStatus(zh ? `已原子导入 ${result.definitionCount} 个定义` : `Atomically imported ${result.definitionCount} definitions`);
      await load();
    } catch {
      setStatus(zh ? '导入未完成，原有配置未改变。' : 'Import did not complete; existing configurations are unchanged.');
    }
  };

  const isScenarioKind = kind === 'scenario';
  // 非场景页到此只剩技能/MCP 两种库（Metis.md 标签已移除，场景走工作台）。
  const libraryKind: 'skill' | 'mcp' = kind === 'mcp' ? 'mcp' : 'skill';
  const scenarioTemplatePanel = isScenarioKind && tplOpen ? (
            <div className="scai-overlay" data-testid="template-parse-modal" role="dialog" aria-modal="true" aria-label={zh ? '模板识别' : 'Template recognition'}>
              <div className="scai-dialog">
                <header className="scai-dialog__head">
                  <h2>{zh ? '模板识别（论文结构）' : 'Template recognition (paper structure)'}</h2>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setTplOpen(false)} aria-label={zh ? '关闭' : 'Close'}><X size={14} aria-hidden="true" /></button>
                </header>
                <div className="scai-dialog__body">
                <div className="personalization-template__panel" data-testid="template-parse-panel">
                  <p>{zh ? '粘贴论文写作模板，或上传模板文件（txt/md/docx/pdf），AI 会解析为逐节写作指引，你可修改后保存为论文结构，供自主科研使用。' : 'Paste a paper template or upload a template file (txt/md/docx/pdf). AI parses it into per-section writing guides you can edit and save as a paper structure for autonomous research.'}</p>
                  <label>
                    <span>{zh ? '模板文本' : 'Template text'}</span>
                    <textarea rows={3} value={tplText} onChange={(event) => setTplText(event.target.value)} data-testid="template-parse-input" placeholder={zh ? '粘贴模板文本…' : 'Paste template text…'} />
                  </label>
                  <div className="personalization-ai-create__actions">
                    <button type="button" className="btn-secondary btn-sm" disabled={tplBusy} onClick={() => void importTemplateFile()} data-testid="template-upload-file">
                      <Upload size={13} aria-hidden="true" /> {zh ? '上传文件' : 'Upload file'}
                    </button>
                    <button type="button" className="btn-primary btn-sm" disabled={tplBusy || tplText.trim().length < 10} onClick={() => void parsePaperTemplate()} data-testid="template-parse-submit">
                      {tplBusy ? (zh ? '解析中…' : 'Parsing…') : (zh ? '解析模板' : 'Parse template')}
                    </button>
                  </div>
                  {tplSections.length > 0 && (
                    <div className="personalization-template__sections" data-testid="template-parse-sections">
                      <label>
                        <span>{zh ? '结构名称' : 'Structure name'}</span>
                        <input className="settings-input" value={tplName} onChange={(event) => setTplName(event.target.value)} data-testid="template-name-input" />
                      </label>
                      {tplSections.map((section, index) => (
                        <div key={index} className="personalization-template__section" data-testid="template-section">
                          <input
                            className="settings-input"
                            value={section.title}
                            aria-label={zh ? `第 ${index + 1} 节标题` : `Section ${index + 1} title`}
                            onChange={(event) => updateTplSection(index, 'title', event.target.value)}
                          />
                          <textarea
                            rows={2}
                            value={section.instruction}
                            aria-label={zh ? `第 ${index + 1} 节写作指引` : `Section ${index + 1} writing guide`}
                            onChange={(event) => updateTplSection(index, 'instruction', event.target.value)}
                          />
                          <button type="button" className="btn-secondary btn-sm" onClick={() => removeTplSection(index)}>
                            {zh ? '删除' : 'Remove'}
                          </button>
                        </div>
                      ))}
                      <div className="personalization-ai-create__actions">
                        <button type="button" className="btn-primary btn-sm" disabled={!tplName.trim()} onClick={() => void savePaperTemplate()} data-testid="template-save">
                          {zh ? '保存为论文结构' : 'Save as paper structure'}
                        </button>
                      </div>
                    </div>
                  )}
                  {tplStatus && <p className="personalization-ai-create__status" role="status" aria-live="polite" data-testid="template-parse-status">{tplStatus}</p>}
                </div>
                </div>
              </div>
            </div>
  ) : null;


  return (
    <div className="personalization-page">
      {/* 场景是组合主体；技能、MCP 与 Metis.md 仍可直接切换和配置。 */}
      <nav className="personalization-tabs" aria-label={zh ? '场景分类' : 'Scenario categories'}>
        <button type="button" className={kind === 'scenario' ? 'active' : ''} aria-pressed={kind === 'scenario'} onClick={() => { setKind('scenario'); setSelectedId(null); setLibraryMode('items'); }}>{KIND_LABELS[zh ? 'zh' : 'en'].scenario}<span>{userDefinitions.filter((definition) => definition.kind === 'scenario').length}</span></button>
        {KIND_ORDER.filter((item) => item !== 'scenario' && item !== 'rules').map((item) => <button key={item} type="button" className={kind === item ? 'active' : ''} aria-pressed={kind === item} onClick={() => { setKind(item); setSelectedId(null); setLibraryMode('items'); }}>{KIND_LABELS[zh ? 'zh' : 'en'][item]}{!isScenarioKind && <span>{userDefinitions.filter((definition) => definition.kind === item).length}</span>}</button>)}
      </nav>

      <div className="personalization-bundle-actions" aria-label={zh ? '配置包导入导出' : 'Bundle import and export'}>
        <button type="button" onClick={() => void importBundle()}>{zh ? '导入配置包' : 'Import bundle'}</button>
        <button type="button" disabled={!selected} onClick={() => void exportBundle()}>{zh ? '导出所选配置' : 'Export selected configuration'}</button>
        <span>{zh ? '配置包包含所选定义及其依赖；凭据不会导出。' : 'Bundles include the selected definition graph; credentials are never exported.'}</span>
      </div>

      {isScenarioKind && !loading && loadError && (
        <div className="personalization-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div>
      )}
      {visibleIntegrityIssues.length > 0 && <section className="personalization-integrity-notice" role="alert" aria-label={zh ? '场景完整性恢复' : 'Personalization integrity recovery'}>
        <strong>{zh ? '发现已隔离的保存异常' : 'Quarantined saved items detected'}</strong>
        <p>{zh ? '这些定义没有通过版本完整性校验，因此不会被执行或静默当作不存在。可以仅从已验证历史版本恢复；异常快照会保留用于审计。' : 'These definitions failed version-integrity verification, so they are not executed or silently treated as absent. Recovery only uses verified history and retains the quarantined snapshot.'}</p>
        <div>
          {visibleIntegrityIssues.map((issue) => <article key={issue.id}>
            <span><strong>{issue.id}</strong><small>{zh ? `当前 r${issue.currentRevision}：${issue.code}` : `current r${issue.currentRevision}: ${issue.code}`}</small></span>
            {issue.latestVerifiedRevision === null
              ? <em>{zh ? '没有可验证历史版本；保持隔离。' : 'No verified history; remains quarantined.'}</em>
              : <button type="button" disabled={recoveringIntegrityIssueId === issue.id} onClick={() => void recoverIntegrityIssue(issue)}>{recoveringIntegrityIssueId === issue.id ? (zh ? '恢复中…' : 'Recovering…') : (zh ? `从可信 r${issue.latestVerifiedRevision} 恢复` : `Recover from trusted r${issue.latestVerifiedRevision}`)}</button>}
          </article>)}
        </div>
      </section>}
      {status && <p className="personalization-load-error" role="status">{status}</p>}
      {isScenarioKind ? (
        <ScenarioWorkbench
          zh={zh}
          // 刘总反馈：步骤编辑器要能直接勾选 METIS 预装技能/MCP，因此额外放行 builtin 的 skill/mcp；
          // 场景库仍只展示用户定义，不暴露工厂预置场景。
          definitions={workbenchDefinitions}
          projectId={activeProjectId}
          archivedScenarios={archivedDefinitions.filter((item) => item.definition.kind === 'scenario')}
          selectedId={selectedId}
          onSelect={setSelectedId}
          save={async (definition, expectedRevision) => {
            const result = await window.metis?.savePersonalization({ contractVersion: 1, definition, expectedRevision });
            return result ?? { ok: false, code: 'unavailable' as const };
          }}
          createScenario={() => void create()}
          onActivateScenario={(id) => onActivateScenario?.(id)}
          onDeleteScenario={async (id) => {
            const definition = userDefinitions.find((item) => item.id === id && item.kind === 'scenario');
            if (!definition) return { ok: false, message: zh ? '未找到可删除的场景。' : 'The scenario to delete was not found.' };
            return archive(definition);
          }}
          onRestoreScenario={restoreScenarioFromTrash}
          reload={load}
          onOpenTemplateRecognize={() => setTplOpen(true)}
        />
      ) : (
      <div className="personalization-layout personalization-layout--single">
        <section
          className="personalization-detail personalization-detail--library"
          aria-label={zh ? '场景详情' : 'Scenario details'}
        >
        {/* A 区：已安装管理（刘总 2026-09 重构：卡片式呈现含预装/内置，取消左侧孤立小卡片）。 */}
        <section className="personalization-installed" aria-label={LIBRARY_LABELS[zh ? 'zh' : 'en'][kind]}>
          <div className="personalization-library__header">
            <div><h2>{kind === 'skill' ? (zh ? '已安装技能' : 'Installed skills') : (zh ? '已安装 MCP' : 'Installed MCPs')}</h2><p>{zh ? '你创建、安装的内容与预装内置项' : 'Your creations, installs, and built-in presets'}</p></div>
            <div className="personalization-library__actions">
              <button
                type="button"
                className={libraryMode === 'trash' ? 'personalization-library__trash-toggle active' : 'personalization-library__trash-toggle'}
                aria-pressed={libraryMode === 'trash'}
                data-testid="personalization-library-trash-toggle"
                onClick={() => setLibraryMode((mode) => (mode === 'trash' ? 'items' : 'trash'))}
              >
                <Trash2 size={13} />{zh ? '回收站' : 'Trash'}<small>{archivedForKind.length}</small>
              </button>
              {kind !== 'mcp' && libraryMode === 'items' && <button className="btn-primary" onClick={() => void create()}>{zh ? '新建' : 'New'}</button>}
            </div>
          </div>
          {loading && <p>{zh ? '正在加载…' : 'Loading…'}</p>}
          {!loading && loadError && <div className="personalization-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div>}
          {libraryMode === 'trash' ? (
           <>
            {!loading && !loadError && archivedForKind.length === 0 && (
              <p>{zh
                ? '回收站为空。已删除内容保留 7 天，到期自动清理；也可在此恢复或彻底删除。'
                : 'Trash is empty. Deleted items are kept for 7 days, then cleaned up automatically; restore or purge them here.'}</p>
            )}
            <div className="personalization-cards">
             {archivedForKind.map((item, index) => (
              <article key={item.definition.id} className="personalization-card personalization-card--trashed">
               <div className="personalization-card__select personalization-card__select--static" data-testid={`personalization-trash-item-${index}`}>
                <span className="personalization-card__meta"><b>{item.definition.provenance.origin === 'url' ? (zh ? 'URL 安装' : 'URL install') : (zh ? '自定义' : 'Custom')}</b><span>r{item.definition.revision}</span></span>
                <strong>{item.definition.name}</strong>
                <span>{zh
                  ? `剩余 ${remainingTrashDays(item.expiresAt)} 天后自动清理`
                  : `${remainingTrashDays(item.expiresAt)} day(s) until automatic cleanup`}</span>
               </div>
               <div className="personalization-card__actions">
                {trashDeleteId === item.definition.id ? (
                 <span className="personalization-card__delete-confirm">
                  {zh ? '彻底删除？不可恢复' : 'Purge forever? Irreversible'}
                  <button
                    className="personalization-card__delete personalization-card__delete--armed"
                    data-testid={`personalization-trash-purge-confirm-${index}`}
                    onClick={() => void deleteFromLibraryTrash(item)}
                  >
                    {zh ? '确认彻底删除' : 'Confirm purge'}
                  </button>
                  <button onClick={() => setTrashDeleteId(null)}>{zh ? '取消' : 'Cancel'}</button>
                 </span>
                ) : (
                 <>
                  <button data-testid={`personalization-trash-restore-${index}`} onClick={() => void restoreFromLibraryTrash(item)}>
                    <RotateCcw size={12} />{zh ? '恢复' : 'Restore'}
                  </button>
                  <button
                    className="personalization-card__delete"
                    data-testid={`personalization-trash-purge-${index}`}
                    title={zh ? '永久删除该内容及其全部版本历史' : 'Permanently delete this item and its version history'}
                    onClick={() => setTrashDeleteId(item.definition.id)}
                  >
                    {zh ? '彻底删除' : 'Purge'}
                  </button>
                 </>
                )}
               </div>
              </article>
             ))}
            </div>
           </>
          ) : (
            <>
          {!loading && !loadError && filtered.length === 0 && (
            <p>{zh ? '还没有自定义内容。' : 'No custom definitions yet.'}</p>
          )}
          {kind === 'skill' && libraryDefinitions.length > 0 && (
            <datalist id="personalization-skill-category-options">
              {skillCategories.map((category) => <option key={category} value={category} />)}
            </datalist>
          )}
          {(() => {
            // 卡片序号跨分组连续，保证 data-testid 稳定。
            let cardIndex = 0;
            const renderCard = (definition: PersonalizationDefinition) => {
              const index = cardIndex;
              cardIndex += 1;
              // 刘总反馈（2026-10）：已启用且声明了凭据但凭据库缺失的 MCP，条目上打「凭据未配置」标记。
              const mcpMissing = definition.kind === 'mcp' ? missingMcpSecrets(definition, mcpSecrets.secretNames) : [];
              const isBuiltin = definition.provenance.origin === 'builtin';
              const skillCategory = definition.kind === 'skill' ? skillCategoryOf(definition) : '';
              return <article key={definition.id} className={`personalization-card ${selectedId === definition.id ? 'selected' : ''}`}>
                <button className="personalization-card__select" data-definition-id={definition.id} onClick={() => setSelectedId(definition.id)}>
                  <span className="personalization-card__meta"><b>{isBuiltin ? (zh ? '内置' : 'Built-in') : (zh ? '自定义' : 'Custom')}</b><span>r{definition.revision}</span></span>
                  <strong>{definition.name}</strong>
                  <span>{definition.description || (zh ? '暂无说明' : 'No description')}</span>
                </button>
                <div className="personalization-card__actions">
                  {draftIds.has(definition.id) && <span className="personalization-card__draft">{zh ? '草稿已保留' : 'Draft preserved'}</span>}
                  {mcpMissing.length > 0 && (
                    <span className="personalization-card__secrets-missing" data-testid={`personalization-mcp-secrets-missing-${index}`}>
                      {zh ? `凭据未配置（${mcpMissing.join('、')}）` : `Credentials missing (${mcpMissing.join(', ')})`}
                    </span>
                  )}
                  {definition.kind === 'mcp' && (
                    <button
                      type="button"
                      data-testid={`personalization-mcp-secrets-${index}`}
                      aria-expanded={secretsEditorId === definition.id}
                      onClick={() => setSecretsEditorId((current) => (current === definition.id ? null : definition.id))}
                    >
                      {zh ? '凭据' : 'Credentials'}
                    </button>
                  )}
                  {definition.kind === 'skill' && !isBuiltin && (
                    <input
                      className="personalization-card__category"
                      list="personalization-skill-category-options"
                      defaultValue={skillCategory}
                      key={`${definition.id}:${skillCategory}`}
                      placeholder={zh ? '分类' : 'Category'}
                      aria-label={zh ? '技能分类' : 'Skill category'}
                      data-testid={`personalization-skill-category-${index}`}
                      onBlur={(event) => void saveSkillCategory(definition, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveSkillCategory(definition, (event.target as HTMLInputElement).value);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    data-testid={`personalization-studio-optimize-${index}`}
                    onClick={() => {
                      if (definition.kind === 'skill') setSkillStudio({ context: definition });
                      else if (definition.kind === 'mcp') setMcpBuilder({ context: definition });
                    }}
                  >
                    {zh ? '对话优化' : 'Improve via chat'}
                  </button>
                  {isBuiltin
                    ? <button onClick={() => void fork(definition)}>{zh ? '创建可编辑副本' : 'Create editable copy'}</button>
                    : <button onClick={() => void archive(definition)}>{definition.kind === 'mcp' ? (zh ? '删除' : 'Delete') : (zh ? '归档' : 'Archive')}</button>}
                  {kind === 'skill' && !isBuiltin && (
                    pendingDeleteId === definition.id ? (
                      <span className="personalization-card__delete-confirm">
                        {zh ? '永久删除？不可恢复' : 'Delete forever? Irreversible'}
                        <button
                          className="personalization-card__delete personalization-card__delete--armed"
                          data-testid={`personalization-skill-delete-confirm-${index}`}
                          onClick={() => void deleteSkillPermanently(definition)}
                        >
                          {zh ? '确认删除' : 'Confirm'}
                        </button>
                        <button onClick={() => setPendingDeleteId(null)}>{zh ? '取消' : 'Cancel'}</button>
                      </span>
                    ) : (
                      <button
                        className="personalization-card__delete"
                        data-testid={`personalization-skill-delete-${index}`}
                        title={zh ? '永久删除该技能及其全部版本历史' : 'Permanently delete this skill and its version history'}
                        onClick={() => setPendingDeleteId(definition.id)}
                      >
                        {zh ? '删除' : 'Delete'}
                      </button>
                    )
                  )}
                </div>
                {definition.kind === 'mcp' && secretsEditorId === definition.id && (
                  <McpCredentialPanel definition={definition} vault={mcpSecrets} testId={`personalization-mcp-secrets-panel-${index}`} />
                )}
              </article>;
            };
            // 技能按分类分组展示（category: 标签）；MCP 平铺。
            return kind === 'skill'
              ? skillGroups.map(([category, group]) => (
                  <div className="personalization-category-group" key={category || '__uncategorized'}>
                    <h3 className="personalization-category-group__title">{category || (zh ? '未分类' : 'Uncategorized')}</h3>
                    <div className="personalization-cards">{group.map(renderCard)}</div>
                  </div>
                ))
              : <div className="personalization-cards">{libraryDefinitions.map(renderCard)}</div>;
          })()}
            </>
          )}
          <div className="personalization-library__status" role="status" aria-live="polite">{status}</div>
        </section>

        {/* 选中项详情与编辑器：紧跟已安装管理区。 */}
        {selected?.kind === 'mcp' && (
          <McpActivationPanel
            definition={selected}
            dependencies={mcpActivationDependencies}
            onActivated={(definition) => {
              setDefinitions((current) => current.map((item) => item.id === definition.id ? definition : item));
              setSelectedId(definition.id);
              void load();
            }}
          />
        )}
        {!selected && <div className="personalization-welcome"><h2>{zh ? '选择或新建配置' : 'Choose or create a configuration'}</h2><p>{zh ? '这里只展示你创建或安装的内容。' : 'Only content you create or install is shown here.'}</p></div>}
        {selected && isDirectlyEditable(selected) && <DefinitionEditor key={`${selected.id}:${selected.revision}`} definition={selected} definitions={userDefinitions} onSaved={handleEditorSaved} onDraftStateChange={handleDraftStateChange} onQuickCreate={quickCreate} />}
        {selected && !isDirectlyEditable(selected) && (
          <div className="personalization-welcome">
            <h2>{selected.name}</h2>
            {selected.provenance.origin === 'builtin' ? (
              <>
                <p>{zh
                  ? '内置定义受保护，不能直接修改或删除；创建可编辑副本后即可编辑，副本与原内置互不影响。'
                  : 'Built-in definitions are protected from direct edits and deletion; create an editable copy to customize it.'}</p>
                <button type="button" onClick={() => void fork(selected)}>{zh ? '创建可编辑副本' : 'Create editable copy'}</button>
              </>
            ) : (
              <p>{zh
                ? '这是由受控安装器或 MCP Builder 管理的定义。来源、安装摘要和启用状态不能手工伪造；请使用上方安装、验证或重新安装流程，或点卡片上的「对话优化」由 Metis Builder 定制。'
                : 'This definition is managed by the controlled installer or MCP Builder. Source provenance, installation digests, and activation state cannot be edited by hand; use the install, verify, or reinstall flow above, or "Improve via chat" on the card.'}</p>
            )}
          </div>
        )}

        {/* B 区：搜索并安装在线技能/MCP（市场）。 */}
        <MarketBrowserPanel kind={libraryKind} zh={zh} definitions={userDefinitions} onInstalled={(definitionId) => afterExtensionInstall(definitionId)} />
        {/* C 区：安装（本地包 / URL / 配置）与能力库。 */}
        <ExtensionInstaller key={libraryKind} kind={libraryKind} definitions={userDefinitions} onInstalled={afterExtensionInstall} onRefresh={load} />
        <CapabilityVaultPanel key={`vault-${libraryKind}`} zh={zh} initialKind={libraryKind} lockKind onInstalled={(definitionId) => afterExtensionInstall(definitionId)} />
        {/* D 区：对话式创造/构建。 */}
        {kind === 'skill' ? (
          <section className="personalization-installer" aria-label={zh ? '创造技能' : 'Create skill'}>
            <div className="personalization-installer__header">
              <div><span className="personalization-eyebrow">{zh ? '技能工坊' : 'SKILL STUDIO'}</span><h2>{zh ? '创造技能' : 'Create a skill'}</h2></div>
              <span>{zh ? '通过对话把经验萃取为结构化技能并快速验证；选中已安装技能卡片上的「对话优化」可带入其内容做定制。' : 'Turn experience into a structured skill through conversation with quick validation; use "Improve via chat" on an installed skill card to customize it.'}</span>
            </div>
            <div className="personalization-actions">
              <button type="button" className="btn-primary" data-testid="personalization-skill-studio-open" onClick={() => setSkillStudio({ context: null })}>{zh ? '对话创造技能' : 'Create skill via chat'}</button>
            </div>
          </section>
        ) : (
          <section className="personalization-installer" aria-label={zh ? '构建 MCP' : 'Build MCP'}>
            <div className="personalization-installer__header">
              <div><span className="personalization-eyebrow">MCP BUILDER</span><h2>{zh ? '构建 MCP' : 'Build an MCP'}</h2></div>
              <span>{zh ? '通过对话描述需求，由 Metis Builder 构建、验证并注册；选中已安装 MCP 卡片上的「对话优化」可做定制。' : 'Describe the need in a dialog and Metis Builder constructs, validates, and registers it; use "Improve via chat" on an installed MCP card to customize it.'}</span>
            </div>
            <div className="personalization-actions">
              <button type="button" className="btn-primary" data-testid="personalization-mcp-builder-open" onClick={() => setMcpBuilder({ context: null })}>{zh ? '对话构建 MCP' : 'Build MCP via chat'}</button>
            </div>
          </section>
        )}
        {/* 刘总反馈（2026-10）：全局凭据面板弱化为后备并移到底部；单个 MCP 的凭据在条目卡片上录入。 */}
        {kind === 'mcp' && <SecretVaultPanel vault={mcpSecrets} />}
        </section>
        {skillStudio && (
          <SkillStudioDialog
            zh={zh}
            contextSkill={skillStudio.context}
            onClose={() => setSkillStudio(null)}
            onSave={async (draft) => {
              await window.metis?.savePersonalization({
                contractVersion: 1,
                kind: 'skill',
                name: draft.name,
                description: (zh ? '技能工坊沉淀' : 'Skill Studio capture'),
                enabled: true,
                tags: ['skill-studio'],
                sourceMode: 'markdown',
                markdown: draft.systemPrompt,
                systemPrompt: draft.systemPrompt,
                toolIds: [],
                mcpIds: [],
                maxTurns: 10,
                inputSchema: null,
                outputSchema: null,
                packageEntry: null,
              } as never);
              await load();
            }}
          />
        )}
        {mcpBuilder && (
          <McpBuilderDialog
            zh={zh}
            contextMcp={mcpBuilder.context}
            onClose={() => setMcpBuilder(null)}
            onInstalled={(definitionId) => afterExtensionInstall(definitionId)}
          />
        )}
      </div>
      )}
      {scenarioTemplatePanel}
    </div>
  );
}
