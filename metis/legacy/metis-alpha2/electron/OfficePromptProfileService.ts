import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { getArtifactPromptDefinition } from '../engine/artifacts/prompts/ArtifactPromptRegistry.js';
import { OFFICE_CAPABILITY_DEFINITIONS, OFFICE_SLOT_TO_BASE_PROMPT, getOfficeCapability } from '../engine/artifacts/prompts/OfficeCapabilityRegistry.js';

/**
 * METIS Office Prompt Profile 服务(2026-09-05 刘总要求,任务5)。
 *
 * 每种 Office 格式支持任意数量 Profile;一个 Profile = 该格式全部真实 slot 的一套内容。
 * 内置(builtin)Profile 可直接编辑;删除走软删除(tombstone),升级不复活。
 * 解析优先级:Outcome 显式绑定 → 格式默认 Profile → 内置 Profile slot → 通用 Registry default。
 * 全删光时仍有 internal fallback(通用 Registry default),AI 永不因缺 Profile 崩溃。
 */

export interface OfficePromptProfile {
  id: string;
  officeKind: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Profile 全局风格与行为段（T8，2026-09-08）：跨该 Profile 全部 AI Action 生效。 */
  globalPrompt: string;
  slots: Record<string, string>;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 内置 Global Prompt（可编辑 built-in，不硬编码进 runtime contract）。 */
export const OFFICE_BUILTIN_GLOBAL_PROMPTS: Record<string, string> = {
  word: [
    '你正在协助生成和修改中文哲学社会科学学术文稿。',
    '整体表达保持严谨、克制、连贯和论证导向。',
    '正文以连续学术论述为主。每一段承担明确的论证功能，围绕中心判断展开，并通过概念、理论、文献或证据支撑该判断。',
    '保持核心概念前后一致。出现定义变化时必须明确说明，避免概念语义无提示漂移。',
    '标题应体现学术逻辑和论证层级。避免营销化、口号化、产品说明书式标题。',
    '减少机械化罗列，减少大量「首先、其次、最后」，减少过多短段与无必要的冒号；避免宣传性表达与没有依据的总结性判断。',
    '已有引用、脚注、参考文献和证据关系应尽可能保留。',
    '涉及事实、文献与理论判断时，区分来源事实、已有学者观点与当前分析判断。',
    '禁止为了缩短文字而任意删除有效理论论证、引用和核心限定条件。',
  ].join('\n'),
  ppt: [
    '你正在协助设计学术型演示文稿。',
    '每页优先表达一个核心判断。页面标题优先使用具有信息含量的结论性标题，仅在实际模板或正式结构要求下使用单纯栏目标题。',
    '页面正文控制信息密度。优先通过关键判断、机制关系、比较、流程、时间线、图示、数据与关键数字组织内容。',
    '避免将论文长段正文直接搬入幻灯片；避免连续大量 bullet、过小字体、无信息价值的装饰、重复标题与为填满页面堆积图标。',
    '学术图表应尽可能保留图表标题、变量含义、必要注释与数据来源。',
    '整套演示文稿需要形成连续叙事：前一页的问题应能自然引出后一页的判断。',
  ].join('\n'),
  markdown: [
    '使用稳定、清晰的 Markdown 层级组织研究内容。',
    '一级标题用于主要文档结构；二级、三级标题用于论证层级；通常避免超过四级标题。',
    '连续学术论证优先使用自然段。列表适用于并列关系、条件、步骤、对比与清单；不要为了结构化外观把所有正文转换成列表。',
    '表格只用于真正适合二维比较的信息。数学表达使用规范 LaTeX，代码块声明语言。',
    '引用、链接和资料来源保持可追溯。',
    '研究笔记允许存在假设、待验证判断、Evidence Gap、反例与 TODO，但必须明确标识这些状态。',
  ].join('\n'),
};


const MAX_SLOT_CHARS = 20_000;

function builtinProfileSpec(kind: string): { name: string; description: string; globalPrompt: string; slots: Record<string, string> } | null {
  const capability = OFFICE_CAPABILITY_DEFINITIONS.find((definition) => definition.kind === kind);
  if (!capability || !capability.aiEnabled) return null;
  const slots: Record<string, string> = {};
  for (const action of capability.aiActions) {
    const baseId = OFFICE_SLOT_TO_BASE_PROMPT[action.slotId];
    const baseDefinition = baseId ? getArtifactPromptDefinition(baseId) : undefined;
    slots[action.slotId] = baseDefinition?.defaultPrompt ?? '';
  }
  return {
    name: `${capability.label} · 通用默认`,
    description: 'METIS 出厂默认工作方式;可直接编辑,恢复随时可用。',
    globalPrompt: OFFICE_BUILTIN_GLOBAL_PROMPTS[capability.kind] ?? '',
    slots,
  };
}

export class OfficePromptProfileService {
  constructor(private readonly db: Database) {}

  /** 启动种子:每个 aiEnabled 格式确保有一个内置通用 Profile(幂等)。 */
  ensureBuiltinProfiles(): void {
    for (const definition of OFFICE_CAPABILITY_DEFINITIONS) {
      const spec = builtinProfileSpec(definition.kind);
      if (!spec) continue;
      const existing = this.db.prepare(
        'SELECT id FROM office_prompt_profiles WHERE office_kind = ? AND builtin = 1 AND deleted_at IS NULL',
      ).get(definition.kind) as { id: string } | undefined;
      if (existing) continue;
      const now = Date.now();
      this.db.prepare(
        'INSERT INTO office_prompt_profiles (id, office_kind, name, description, builtin, slots_json, global_prompt, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)',
      ).run(`office_${definition.kind}_default`, definition.kind, spec.name, spec.description, JSON.stringify(spec.slots), spec.globalPrompt, now, now);
    }
  }

  listProfiles(officeKind: string): OfficePromptProfile[] {
    const rows = this.db.prepare(
      'SELECT * FROM office_prompt_profiles WHERE office_kind = ? AND deleted_at IS NULL ORDER BY builtin DESC, updated_at DESC',
    ).all(officeKind) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeProfile(row)).filter((item): item is OfficePromptProfile => item !== null);
  }

  getProfile(profileId: string): OfficePromptProfile | null {
    const row = this.db.prepare('SELECT * FROM office_prompt_profiles WHERE id = ? AND deleted_at IS NULL').get(profileId) as Record<string, unknown> | undefined;
    return row ? this.decodeProfile(row) : null;
  }

  private decodeProfile(row: Record<string, unknown>): OfficePromptProfile | null {
    let slots: Record<string, string> = {};
    try {
      const parsed = JSON.parse((row.slots_json as string) || '{}') as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') slots[key] = value;
      }
    } catch { slots = {}; }
    return {
      id: row.id as string,
      officeKind: row.office_kind as string,
      name: row.name as string,
      description: row.description as string,
      builtin: row.builtin === 1,
      globalPrompt: typeof row.global_prompt === 'string' ? row.global_prompt : '',
      slots,
      deletedAt: (row.deleted_at as number | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  createProfile(input: { officeKind: string; name: string; description?: string; fromProfileId?: string }): { ok: true; profile: OfficePromptProfile } | { ok: false; code: string } {
    const capability = getOfficeCapability(input.officeKind);
    if (!capability) return { ok: false, code: 'unknown_office_kind' };
    const name = input.name.trim() || '未命名 Profile';
    let slots: Record<string, string> = {};
    if (input.fromProfileId) {
      const source = this.getProfile(input.fromProfileId);
      if (!source || source.officeKind !== input.officeKind) return { ok: false, code: 'source_profile_not_found' };
      slots = { ...source.slots };
    } else {
      const builtin = this.listProfiles(input.officeKind).find((profile) => profile.builtin);
      slots = builtin ? { ...builtin.slots } : {};
    }
    let globalPrompt = '';
    if (input.fromProfileId) {
      const source = this.getProfile(input.fromProfileId);
      globalPrompt = source?.globalPrompt ?? '';
    } else {
      const builtin = this.listProfiles(input.officeKind).find((profile) => profile.builtin);
      globalPrompt = builtin?.globalPrompt ?? OFFICE_BUILTIN_GLOBAL_PROMPTS[input.officeKind] ?? '';
    }
    const now = Date.now();
    const profile: OfficePromptProfile = {
      id: `office_profile_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      officeKind: input.officeKind,
      name: name.slice(0, 120),
      description: (input.description ?? '').slice(0, 500),
      builtin: false,
      globalPrompt,
      slots,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(
      'INSERT INTO office_prompt_profiles (id, office_kind, name, description, builtin, slots_json, global_prompt, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)',
    ).run(profile.id, profile.officeKind, profile.name, profile.description, JSON.stringify(profile.slots), profile.globalPrompt, profile.createdAt, profile.updatedAt);
    return { ok: true, profile };
  }

  updateProfile(profileId: string, patch: { name?: string; description?: string }): OfficePromptProfile | null {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    const next = {
      ...profile,
      name: (patch.name ?? profile.name).slice(0, 120),
      description: (patch.description ?? profile.description).slice(0, 500),
      updatedAt: Date.now(),
    };
    this.db.prepare('UPDATE office_prompt_profiles SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, next.updatedAt, profileId);
    return next;
  }

  /** 软删除(tombstone);内置与用户 Profile 同规则,可恢复。 */
  deleteProfile(profileId: string): boolean {
    const profile = this.getProfile(profileId);
    if (!profile) return false;
    this.db.prepare('UPDATE office_prompt_profiles SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), profileId);
    this.db.prepare('DELETE FROM office_prompt_profile_defaults WHERE profile_id = ?').run(profileId);
    this.db.prepare('DELETE FROM office_prompt_outcome_bindings WHERE profile_id = ?').run(profileId);
    return true;
  }

  restoreProfile(profileId: string): OfficePromptProfile | null {
    const row = this.db.prepare('SELECT * FROM office_prompt_profiles WHERE id = ? AND deleted_at IS NOT NULL').get(profileId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE office_prompt_profiles SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), profileId);
    return this.getProfile(profileId);
  }

  listDeletedProfiles(officeKind: string): OfficePromptProfile[] {
    const rows = this.db.prepare('SELECT * FROM office_prompt_profiles WHERE office_kind = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(officeKind) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeProfile(row)).filter((item): item is OfficePromptProfile => item !== null);
  }

  /** 编辑 slot:写 profile + revision;空内容=回到该 slot 的回退值(删除覆盖)。 */
  setSlot(profileId: string, slotId: string, content: string, source: 'manual' | 'assistant' | 'import' = 'manual'): { ok: true; profile: OfficePromptProfile } | { ok: false; code: string } {
    const profile = this.getProfile(profileId);
    if (!profile) return { ok: false, code: 'profile_not_found' };
    const capability = getOfficeCapability(profile.officeKind);
    if (!capability?.aiActions.some((action) => action.slotId === slotId)) return { ok: false, code: 'unknown_slot' };
    if (content.length > MAX_SLOT_CHARS) return { ok: false, code: 'invalid_content' };
    const nextSlots = { ...profile.slots };
    if (content.trim()) nextSlots[slotId] = content;
    else delete nextSlots[slotId];
    const now = Date.now();
    // 任务1（§七）：profile mutation + revision 是一次用户动作跨两表，必须同事务。
    this.db.transaction(() => {
      this.db.prepare('UPDATE office_prompt_profiles SET slots_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nextSlots), now, profileId);
      this.db.prepare(
        'INSERT INTO office_prompt_profile_revisions (id, profile_id, slot_id, content, created_at, source) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(`orev_${randomUUID().replace(/-/g, '').slice(0, 16)}`, profileId, slotId, content, now, source);
    })();
    return { ok: true, profile: this.getProfile(profileId)! };
  }

  // ── 默认 Profile(每格式一个)──

  setDefaultProfile(officeKind: string, profileId: string): { ok: true } | { ok: false; code: string } {
    const profile = this.getProfile(profileId);
    if (!profile || profile.officeKind !== officeKind) return { ok: false, code: 'profile_not_found' };
    this.db.prepare(
      'INSERT INTO office_prompt_profile_defaults (office_kind, profile_id) VALUES (?, ?) ON CONFLICT(office_kind) DO UPDATE SET profile_id = excluded.profile_id',
    ).run(officeKind, profileId);
    return { ok: true };
  }

  getDefaultProfileId(officeKind: string): string | null {
    const row = this.db.prepare('SELECT profile_id FROM office_prompt_profile_defaults WHERE office_kind = ?').get(officeKind) as { profile_id: string } | undefined;
    return row?.profile_id ?? null;
  }

  // ── Outcome 显式绑定 ──

  bindOutcome(outcomeId: string, profileId: string): { ok: true } | { ok: false; code: string } {
    const profile = this.getProfile(profileId);
    if (!profile) return { ok: false, code: 'profile_not_found' };
    this.db.prepare(
      'INSERT INTO office_prompt_outcome_bindings (outcome_id, profile_id) VALUES (?, ?) ON CONFLICT(outcome_id) DO UPDATE SET profile_id = excluded.profile_id',
    ).run(outcomeId, profileId);
    return { ok: true };
  }

  unbindOutcome(outcomeId: string): void {
    this.db.prepare('DELETE FROM office_prompt_outcome_bindings WHERE outcome_id = ?').run(outcomeId);
  }

  getOutcomeBinding(outcomeId: string): string | null {
    const row = this.db.prepare('SELECT profile_id FROM office_prompt_outcome_bindings WHERE outcome_id = ?').get(outcomeId) as { profile_id: string } | undefined;
    return row?.profile_id ?? null;
  }

  /**
   * 统一解析入口:Outcome 显式绑定 → 格式默认 Profile → 内置 Profile → 通用 Registry。
   * 返回 null 表示该 slot 无覆盖,使用任务4 Registry 的 defaultPrompt(内部 fallback)。
   */
  /** 编辑 Profile 全局风格段（T8）。空串=回退 built-in。 */
  setGlobalPrompt(profileId: string, content: string): OfficePromptProfile | null {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    const now = Date.now();
    // 任务1（§七）：mutation + revision 同事务（与 setSlot 同理）。
    this.db.transaction(() => {
      this.db.prepare('UPDATE office_prompt_profiles SET global_prompt = ?, updated_at = ? WHERE id = ?')
        .run(content.slice(0, MAX_SLOT_CHARS), now, profileId);
      this.db.prepare('INSERT INTO office_prompt_profile_revisions (id, profile_id, slot_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`opr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, profileId, '__global__', content.slice(0, MAX_SLOT_CHARS), now);
    })();
    return this.getProfile(profileId);
  }

  /** 解析 Profile 全局段：Outcome 绑定 → Kind 默认 → builtin（含 built-in global prompt fallback）。 */
  resolveGlobal(officeKind: string, outcomeId: string | null): string | null {
    const read = (profileId: string | null): string | null => {
      if (!profileId) return null;
      const profile = this.getProfile(profileId);
      if (!profile || profile.officeKind !== officeKind) return null;
      if (profile.globalPrompt.trim()) return profile.globalPrompt;
      if (profile.builtin) return OFFICE_BUILTIN_GLOBAL_PROMPTS[officeKind] ?? null;
      return null;
    };
    if (outcomeId) {
      const bound = read(this.getOutcomeBinding(outcomeId));
      if (bound !== null) return bound;
    }
    const defaulted = read(this.getDefaultProfileId(officeKind));
    if (defaulted !== null) return defaulted;
    return read(this.listProfiles(officeKind).find((profile) => profile.builtin)?.id ?? null);
  }

  resolveSlot(officeKind: string, outcomeId: string | null, slotId: string): string | null {
    const baseId = OFFICE_SLOT_TO_BASE_PROMPT[slotId];
    const tryProfile = (profileId: string | null): string | null => {
      if (!profileId) return null;
      const profile = this.getProfile(profileId);
      if (!profile || profile.officeKind !== officeKind) return null;
      return profile.slots[slotId] ?? null;
    };
    if (outcomeId) {
      const bound = tryProfile(this.getOutcomeBinding(outcomeId));
      if (bound !== null) return bound;
    }
    const defaultId = tryProfile(this.getDefaultProfileId(officeKind));
    if (defaultId !== null) return defaultId;
    const builtin = this.listProfiles(officeKind).find((profile) => profile.builtin);
    if (builtin) {
      const content = builtin.slots[slotId];
      if (content !== undefined && content.trim()) return content;
    }
    if (baseId) {
      const baseDefinition = getArtifactPromptDefinition(baseId);
      if (baseDefinition) return null;
    }
    return null;
  }

  /**
   * 以通用 Registry promptId(outcome.assistant / presentation.generation 等)解析
   * Office Profile 覆盖;officeKind 已知时直接定位,未知则按 slot 映射反查全部 kind。
   */
  resolveForBasePrompt(basePromptId: string, outcomeId: string | null, officeKind?: string): string | null {
    const kindCandidates: string[] = [];
    if (officeKind) {
      kindCandidates.push(officeKind);
    } else {
      for (const [slotId, base] of Object.entries(OFFICE_SLOT_TO_BASE_PROMPT)) {
        if (base !== basePromptId) continue;
        for (const definition of OFFICE_CAPABILITY_DEFINITIONS) {
          if (definition.aiActions.some((action) => action.slotId === slotId)) kindCandidates.push(definition.kind);
        }
      }
    }
    for (const kind of kindCandidates) {
      const capability = getOfficeCapability(kind);
      if (!capability) continue;
      for (const action of capability.aiActions) {
        if (OFFICE_SLOT_TO_BASE_PROMPT[action.slotId] !== basePromptId) continue;
        const content = this.resolveSlot(kind, outcomeId, action.slotId);
        if (content !== null && content.trim()) return content;
      }
    }
    return null;
  }

  listCapabilitySummaries(): Array<{ kind: string; label: string; profileCount: number; defaultProfileId: string | null; aiEnabled: boolean }> {
    return OFFICE_CAPABILITY_DEFINITIONS.map((definition) => ({
      kind: definition.kind,
      label: definition.label,
      profileCount: this.listProfiles(definition.kind).length,
      defaultProfileId: this.getDefaultProfileId(definition.kind),
      aiEnabled: definition.aiEnabled,
    }));
  }
}

// office_prompt_profile_defaults 表在 schema v17 追加(与 profiles 同批)。
declare module 'better-sqlite3' {}
export const OFFICE_PROMPT_DEFAULTS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS office_prompt_profile_defaults (office_kind TEXT PRIMARY KEY, profile_id TEXT NOT NULL);';
export const OFFICE_PROMPT_OUTCOME_BINDINGS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS office_prompt_outcome_bindings (outcome_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL);';
export const OFFICE_CAPABILITY_COUNT = OFFICE_CAPABILITY_DEFINITIONS.length;
