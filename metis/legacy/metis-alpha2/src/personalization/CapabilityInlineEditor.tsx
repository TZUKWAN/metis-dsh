/**
 * CapabilityInlineEditor — 场景「能力与运行」页就地创建/编辑组件的模态窗。
 *
 * 设计约束（对齐 PersonalizationRepository 的 CAS 语义）：
 * - 新建：expectedRevision=0；id 被归档记录占用返回 revision_conflict 时换唯一 id 重试。
 * - 编辑：提交 revision = 当前版本 + 1；内置原版受保护，保存自动转为用户副本（fork 语义）。
 * - 场景内新建 Metis.md 固定 scope=scenario + scopeId=本场景，保证绑定后 resolver 可通过。
 * - 智能体「场景专属」用 tags 标记（schema 为 strictObject，不能加自定义字段）。
 */
import { useState } from 'react';
import { Pencil, Sparkles, X } from 'lucide-react';
import type {
  AgentDefinition,
  McpDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { availableUserId, cloneDefinition, createDefinition } from './personalizationLib.js';
import { currentTimestamp, scenarioOnlyTag, SCENARIO_TAG_PREFIX } from './CapabilityInlineEditorUtils.js';

export type InlineKind = 'agent' | 'skill' | 'mcp' | 'rules';
export type InlineMode = 'create' | 'edit';

const KIND_LABELS = {
  zh: { agent: '智能体', skill: '技能', mcp: 'MCP', rules: 'Metis.md' } as Record<InlineKind, string>,
  en: { agent: 'Agent', skill: 'Skill', mcp: 'MCP', rules: 'Metis.md' } as Record<InlineKind, string>,
};

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

function parseArgLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function parseEnvLines(value: string): { entries: Record<string, { secret: boolean; value: string }>; invalidKeys: string[] } {
  const entries: Record<string, { secret: boolean; value: string }> = {};
  const invalidKeys: string[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    const key = (equals >= 0 ? trimmed.slice(0, equals) : trimmed).trim();
    const val = equals >= 0 ? trimmed.slice(equals + 1).trim() : '';
    if (!ENV_KEY_PATTERN.test(key)) {
      invalidKeys.push(key || '(empty)');
      continue;
    }
    entries[key] = { secret: false, value: val };
  }
  return { entries, invalidKeys };
}

function formatEnvEntries(definition: McpDefinition): { editable: string; managedKeys: string[] } {
  const lines: string[] = [];
  const managedKeys: string[] = [];
  for (const [key, entry] of Object.entries(definition.environment ?? {})) {
    if (entry.secret) {
      managedKeys.push(key);
      continue;
    }
    lines.push(`${key}=${entry.value ?? ''}`);
  }
  return { editable: lines.join('\n'), managedKeys };
}

/** 内置原版转用户副本：保留 parentId/parentVersion 溯源，清除安装器专有来源字段。 */
function toUserCopy(definition: PersonalizationDefinition, all: readonly PersonalizationDefinition[]): PersonalizationDefinition {
  const copy = cloneDefinition(definition);
  copy.id = availableUserId(definition.kind, `${definition.name} copy`, all);
  copy.revision = 1;
  copy.provenance = {
    ...copy.provenance,
    origin: 'user',
    parentId: definition.id,
    parentVersion: definition.provenance.version,
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    locallyModified: true,
    updatedAt: currentTimestamp(),
  };
  return copy;
}

export default function CapabilityInlineEditor({
  zh, kind, mode, scenarioId, definition, definitions, save, onClose, onSaved,
}: {
  zh: boolean;
  kind: InlineKind;
  mode: InlineMode;
  scenarioId: string;
  definition: PersonalizationDefinition | null;
  definitions: readonly PersonalizationDefinition[];
  save(definition: PersonalizationDefinition, expectedRevision: number): Promise<{ ok: boolean; code?: string; definition?: PersonalizationDefinition }>;
  onClose(): void;
  onSaved(saved: PersonalizationDefinition, createdNew: boolean): void | Promise<void>;
}) {
  const isCreate = mode === 'create';
  const agent = definition?.kind === 'agent' ? definition : null;
  const skill = definition?.kind === 'skill' ? definition : null;
  const mcp = definition?.kind === 'mcp' ? definition : null;
  const rules = definition?.kind === 'rules' ? definition : null;
  const mcpEnv = mcp ? formatEnvEntries(mcp) : { editable: '', managedKeys: [] };

  const [name, setName] = useState(definition?.name ?? (isCreate ? (zh ? `新建${KIND_LABELS.zh[kind]}` : `New ${KIND_LABELS.en[kind]}`) : ''));
  const [description, setDescription] = useState(definition?.description ?? '');
  const [role, setRole] = useState(agent?.role ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [scenarioOnly, setScenarioOnly] = useState(agent ? agent.tags.some((tag) => tag.startsWith(SCENARIO_TAG_PREFIX)) : Boolean(scenarioId));
  const [markdown, setMarkdown] = useState(skill?.markdown ?? rules?.markdown ?? (kind === 'rules' ? '# Metis.md\n\n' : ''));
  const [command, setCommand] = useState(mcp?.command ?? 'node');
  const [args, setArgs] = useState(mcp ? mcp.args.join('\n') : '');
  const [env, setEnv] = useState(mcpEnv.editable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // AI 辅助创建（智能体）：描述需求 → 生成草稿填入表单 → 用户确认修改后保存。
  const [aiNeed, setAiNeed] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');

  const label = KIND_LABELS[zh ? 'zh' : 'en'][kind];

  const runAiGenerate = async () => {
    const metis = window.metis;
    if (!metis?.aiGenerateAgent) {
      setAiError(zh ? 'AI 生成服务不可用，请检查模型连接。' : 'AI generation unavailable; check the model connection.');
      return;
    }
    if (aiNeed.trim().length < 2) return;
    setAiBusy(true);
    setAiError('');
    try {
      const result = await metis.aiGenerateAgent({ description: aiNeed.trim() });
      if (!result.ok || !result.agent) {
        setAiError(zh ? `生成失败（${result.code ?? 'unknown'}）${result.message ?? ''}` : `Generation failed (${result.code ?? 'unknown'}) ${result.message ?? ''}`);
        return;
      }
      setName(result.agent.name);
      setDescription(result.agent.description);
      setRole(result.agent.role);
      setSystemPrompt(result.agent.systemPrompt);
    } catch {
      setAiError(zh ? '生成未完成，请重试。' : 'Generation did not complete. Retry.');
    } finally {
      setAiBusy(false);
    }
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(zh ? '请填写名称。' : 'Name is required.');
      return;
    }
    if (kind === 'mcp' && !command.trim()) {
      setError(zh ? '请填写启动命令。' : 'Command is required.');
      return;
    }
    let environment: McpDefinition['environment'] = {};
    const managedEnvKeys = mcpEnv.managedKeys;
    if (kind === 'mcp') {
      const parsed = parseEnvLines(env);
      if (parsed.invalidKeys.length > 0) {
        setError(zh
          ? `环境变量名不合法：${parsed.invalidKeys.join('、')}（需大写字母/下划线开头）`
          : `Invalid environment keys: ${parsed.invalidKeys.join(', ')}`);
        return;
      }
      environment = { ...parsed.entries };
      for (const key of managedEnvKeys) {
        const original = mcp?.environment[key];
        if (original) environment[key] = original;
      }
    }

    setBusy(true);
    setError('');
    try {
      let next: PersonalizationDefinition;
      const builtin = definition ? definition.provenance.origin === 'builtin' || definition.id.startsWith('builtin:') : false;
      if (isCreate) {
        next = createDefinition(kind, trimmedName, definitions);
      } else if (!definition) {
        setError(zh ? '原定义不存在，请刷新后重试。' : 'The original definition is missing; reload and retry.');
        return;
      } else if (builtin) {
        next = toUserCopy(definition, definitions);
      } else {
        next = cloneDefinition(definition);
        next.revision = definition.revision + 1;
        next.provenance = { ...next.provenance, locallyModified: true, updatedAt: currentTimestamp() };
      }
      const asNew = isCreate || builtin;

      next.name = trimmedName;
      next.description = description;
      if (next.kind === 'agent') {
        const target = next as AgentDefinition;
        target.role = role.trim() || trimmedName;
        target.systemPrompt = systemPrompt;
        const otherTags = target.tags.filter((tag) => !tag.startsWith(SCENARIO_TAG_PREFIX));
        target.tags = scenarioOnly ? [...otherTags, scenarioOnlyTag(scenarioId)] : otherTags;
      }
      if (next.kind === 'skill') {
        (next as SkillDefinitionV2).markdown = markdown;
      }
      if (next.kind === 'mcp') {
        const target = next as McpDefinition;
        if (isCreate) target.sourceMode = 'generated';
        target.command = command.trim();
        target.args = parseArgLines(args);
        target.environment = environment;
      }
      if (next.kind === 'rules') {
        const target = next as MetisRulesDefinition;
        if (isCreate) {
          target.scope = 'scenario';
          target.scopeId = scenarioId;
        }
        target.markdown = markdown;
      }

      let result = await save(next, asNew ? 0 : definition!.revision);
      if (!result.ok && result.code === 'revision_conflict' && asNew) {
        // 归档记录占用了默认 id：换唯一 id 重试一次（与 PersonalizationCenter.saveNew 一致）。
        next = { ...next, id: `${next.id}-${currentTimestamp().toString(36)}` };
        result = await save(next, 0);
      }
      if (!result.ok || !result.definition) {
        setError(zh
          ? `保存失败（${result.code ?? 'unknown'}）`
          : `Save failed (${result.code ?? 'unknown'})`);
        return;
      }
      await onSaved(result.definition, asNew);
    } catch {
      setError(zh ? '保存未完成，请重试。' : 'Save did not complete. Retry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scai-overlay" role="dialog" aria-modal="true" aria-label={isCreate ? (zh ? `新建${label}` : `New ${label}`) : (zh ? `编辑${label}` : `Edit ${label}`)} data-testid="sw-inline-editor">
      <div className="scai-dialog sw-cie">
        <header className="scai-dialog__head">
          <h2>{isCreate
            ? (zh ? `新建${label}` : `New ${label}`)
            : (zh ? `编辑${label}` : `Edit ${label}`)} {mode === 'edit' && definition && <Pencil size={14} aria-hidden="true" />}</h2>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}><X size={14} aria-hidden="true" /></button>
        </header>
        <div className="scai-dialog__body">
          {mode === 'edit' && definition?.provenance.origin === 'builtin' && (
            <p className="sw-cie__hint" role="note">{zh ? '内置原版受保护：保存将创建可编辑副本并绑定到本场景，原件保持不变。' : 'The factory original is protected: saving creates an editable copy bound to this scenario.'}</p>
          )}
          <label className="scai-field">
            <span>{zh ? '名称' : 'Name'}</span>
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} data-testid="sw-cie-name" />
          </label>
          <label className="scai-field">
            <span>{zh ? '说明' : 'Description'}</span>
            <textarea rows={2} value={description} maxLength={4000} onChange={(event) => setDescription(event.target.value)} data-testid="sw-cie-description" />
          </label>

          {kind === 'agent' && <>
            {isCreate && (
              <div className="sw-cie__ai">
                <label className="scai-field">
                  <span>{zh ? 'AI 辅助创建（可选）' : 'AI-assisted creation (optional)'}</span>
                  <textarea
                    rows={2}
                    value={aiNeed}
                    onChange={(event) => setAiNeed(event.target.value)}
                    placeholder={zh ? '描述你想要的智能体，如：擅长政策文本分析、能拆解政策条目并归因' : 'Describe the agent you want'}
                    data-testid="sw-cie-ai-need"
                  />
                </label>
                <button type="button" className="btn-secondary btn-sm" disabled={aiBusy || aiNeed.trim().length < 2} onClick={() => void runAiGenerate()} data-testid="sw-cie-ai-run">
                  <Sparkles size={12} aria-hidden="true" /> {aiBusy ? (zh ? '生成中…' : 'Generating…') : (zh ? 'AI 生成草稿' : 'Generate draft')}
                </button>
                {aiError && <p className="sw-cie__error" role="alert" data-testid="sw-cie-ai-error">{aiError}</p>}
              </div>
            )}
            <label className="scai-field">
              <span>{zh ? '角色' : 'Role'}</span>
              <input value={role} maxLength={200} onChange={(event) => setRole(event.target.value)} placeholder={zh ? '如：文献综述专家' : 'e.g. Literature review expert'} data-testid="sw-cie-role" />
            </label>
            <label className="scai-field">
              <span>{zh ? '系统指令' : 'System instructions'}</span>
              <textarea rows={8} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder={zh ? '描述这个智能体的职责、方法与输出要求…' : 'Describe duties, methods, and output expectations…'} data-testid="sw-cie-system-prompt" />
            </label>
            <label className="sw-cie__check">
              <input type="checkbox" checked={scenarioOnly} onChange={(event) => setScenarioOnly(event.target.checked)} data-testid="sw-cie-scenario-only" />
              <span>{zh ? '场景专属（仅本场景的绑定列表中显示）' : 'Scenario-only (visible only to this scenario)'}</span>
            </label>
          </>}

          {kind === 'skill' && (
            <label className="scai-field">
              <span>{zh ? '技能 Markdown（SKILL.md 内容）' : 'Skill Markdown (SKILL.md content)'}</span>
              <textarea rows={12} value={markdown} onChange={(event) => setMarkdown(event.target.value)} data-testid="sw-cie-markdown" />
            </label>
          )}

          {kind === 'mcp' && <>
            <label className="scai-field">
              <span>{zh ? '启动命令' : 'Command'}</span>
              <input value={command} maxLength={4096} onChange={(event) => setCommand(event.target.value)} placeholder="npx" data-testid="sw-cie-command" />
            </label>
            <label className="scai-field">
              <span>{zh ? '参数（每行一个）' : 'Arguments (one per line)'}</span>
              <textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} data-testid="sw-cie-args" />
            </label>
            <label className="scai-field">
              <span>{zh ? '环境变量（每行 KEY=VALUE）' : 'Environment (KEY=VALUE per line)'}</span>
              <textarea rows={3} value={env} onChange={(event) => setEnv(event.target.value)} placeholder={'API_KEY=abc'} data-testid="sw-cie-env" />
            </label>
            {mcpEnv.managedKeys.length > 0 && (
              <p className="sw-cie__hint">{zh
                ? `由安装器管理的密钥项（${mcpEnv.managedKeys.join('、')}）保持不变。`
                : `Installer-managed secret keys (${mcpEnv.managedKeys.join(', ')}) remain unchanged.`}</p>
            )}
          </>}

          {kind === 'rules' && (
            <label className="scai-field">
              <span>Metis.md</span>
              <textarea rows={12} value={markdown} onChange={(event) => setMarkdown(event.target.value)} data-testid="sw-cie-rules-markdown" />
            </label>
          )}

          {error && <p className="sw-cie__error" role="alert" data-testid="sw-cie-error">{error}</p>}
        </div>
        <footer className="scai-dialog__actions sw-cie__actions">
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
          <button type="button" className="btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void handleSave()} data-testid="sw-cie-save">
            {busy ? (zh ? '保存中…' : 'Saving…') : (mode === 'edit' && definition?.provenance.origin === 'builtin'
              ? (zh ? '存为副本并绑定' : 'Save as copy & bind')
              : (zh ? '保存' : 'Save'))}
          </button>
        </footer>
      </div>
    </div>
  );
}
