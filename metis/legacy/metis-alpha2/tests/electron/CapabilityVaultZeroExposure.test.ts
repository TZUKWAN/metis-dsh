/**
 * Capability Vault 零暴露契约（任务7 7B/7D，2026-09-08 刘总澄清）：
 * 1. 入库≠注入：vault 检索接口绝不带出技能正文；未安装时个人化解析器
 *    根本无法解析该技能（依赖缺失，resolve 如实失败）。
 * 2. 安装≠注入：安装后技能成为可绑定定义，但 Workflow 步骤的运行期
 *    提示词（composeManifestSystemPrompt(manifest, step)）只在
 *    step.skillIds 显式绑定时才包含其内容。
 * 3. 卸载清链：vault 卸载清除安装关联；重复卸载如实返回 false。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CapabilityVaultService } from '../../electron/CapabilityVaultService.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver, composeManifestSystemPrompt } from '../../engine/personalization/PersonalizationResolver.js';
import { expandSourceSkills, type CapabilitySourceSpec, type RepoSkillFile } from '../../engine/capabilities/CapabilityImporter.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type {
  AgentDefinition,
  PersonalizationDefinition,
  ResolvedRunManifest,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_786_000_000_000;
const MARKER = 'VAULT-ZERO-EXPOSURE-MARKER-9f3a: 只有绑定步骤后才允许出现在提示词中的独有句子。';
const VAULT_SKILL_ID = 'user:vault-auto-empirical-research-skills/demo/SKILL.md';

// importLocalFiles 只接受注册表中真实存在的 sourceId（保证来源元数据可信），
// 这里复用预置清单的第一个来源承载夹具文件。
const source: CapabilitySourceSpec = {
  id: 'auto-empirical-research',
  repo: 'example/fixture-repo',
  name: 'Fixture Repo',
  expansion: 'per_skill',
  domains: ['测试域'],
  researchStages: ['analysis'],
  licenseStatus: 'unverified',
};

const files: RepoSkillFile[] = [
  {
    path: 'skills/demo/SKILL.md',
    // 注意：目录元数据（description）本就允许展示；标记只放正文，验证正文不泄漏。
    content: ['---', 'name: Demo Vault Skill', 'description: 演示技能（目录可见的普通描述）', '---', '', '# Demo', MARKER.repeat(3)].join('\n'),
  },
  {
    path: 'skills/empty/SKILL.md',
    content: ['---', 'name: Empty', 'description: too short', '---', '', 'short'].join('\n'),
  },
];

function buildVault(): CapabilityVaultService {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const vault = new CapabilityVaultService(db);
  const manifests = expandSourceSkills(source, files);
  // 与 importLocalFiles 同一写入路径（直接复用服务，保持契约一致）。
  const result = vault.importLocalFiles(source.id, files);
  expect(result.ok).toBe(true);
  expect(result.imported).toBe(1);
  expect(result.excluded).toBe(1);
  expect(manifests.filter((manifest) => manifest.included)).toHaveLength(1);
  return vault;
}

function header(id: string, kind: PersonalizationDefinition['kind']) {
  return {
    contractVersion: 1 as const,
    id,
    kind,
    name: id,
    description: id,
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'user' as const,
      author: 'Capability Vault',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function vaultSkillDefinition(): SkillDefinitionV2 {
  return {
    ...header(VAULT_SKILL_ID, 'skill'),
    kind: 'skill',
    sourceMode: 'markdown',
    markdown: '',
    systemPrompt: MARKER,
    toolIds: [],
    mcpIds: [],
    maxTurns: 30,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
}

const agent: AgentDefinition = {
  ...header('user:agents/runner', 'agent'),
  kind: 'agent',
  role: 'Runner',
  systemPrompt: 'Act as the runner.',
  modelPreference: null,
  // agent 不常驻技能：resolver 会把 agent 级技能提升进该 agent 的每个 step，
  // 因此"绑定"必须由 step.skillIds 表达，才能验证按步骤加载的契约。
  skillIds: [],
  toolIds: [],
  mcpIds: [],
  memory: { scope: 'scenario', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
  output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
  maxTurns: 10,
  retryLimit: 2,
};

function scenarioWithStep(skillIds: string[]): ScenarioDefinition {
  return {
    ...header('user:scenarios/vault-flow', 'scenario'),
    kind: 'scenario',
    agentIds: [agent.id],
    skillIds: [VAULT_SKILL_ID],
    mcpIds: [],
    rulesIds: [],
    workflow: [{
      id: 'step-one',
      name: 'Step One',
      description: 'First step.',
      agentId: agent.id,
      skillIds,
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 20,
    }],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory: { scope: 'scenario', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
    output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
    triggerPhrases: [],
    capability: 'research',
  };
}

class Reader {
  readonly definitions = new Map<string, PersonalizationDefinition>();
  get(id: string): PersonalizationDefinition | undefined { return this.definitions.get(id); }
  list(kind?: PersonalizationDefinition['kind'], includeDisabled = false): PersonalizationDefinition[] {
    return [...this.definitions.values()].filter((definition) => (
      (!kind || definition.kind === kind) && (includeDisabled || definition.enabled)
    ));
  }
}

describe('Capability Vault 零暴露契约', () => {
  it('目录检索绝不带出技能正文，详情才可见', () => {
    const vault = buildVault();
    const listed = vault.search({ sourceId: source.id });
    // excluded 条目同样入库（带排除原因如实展示），但 included 仅 1 条。
    expect(listed).toHaveLength(2);
    const demo = listed.find((entry) => entry.included)!;
    expect(demo.installedDefinitionId).toBeNull();
    expect(demo.systemPrompt).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain('VAULT-ZERO-EXPOSURE-MARKER');
    const detail = vault.getDetail(demo.id);
    expect(detail?.systemPrompt).toContain('VAULT-ZERO-EXPOSURE-MARKER');
  });

  it('未安装时解析器无法解析该技能（依赖缺失，如实失败）', () => {
    const reader = new Reader();
    reader.definitions.set(agent.id, agent);
    reader.definitions.set(scenarioWithStep([VAULT_SKILL_ID]).id, scenarioWithStep([VAULT_SKILL_ID]));
    const result = new PersonalizationResolver(reader).resolve({
      sessionId: 'session-vault',
      projectId: 'project-vault',
      scenarioId: 'user:scenarios/vault-flow',
      createdAt: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('安装后：未绑定步骤不含技能内容，绑定步骤才加载（入库不注入→绑定才加载）', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const vault = new CapabilityVaultService(db);
    vault.importLocalFiles(source.id, files);
    const repository = new PersonalizationRepository(db);

    // 安装 = 经回调写入个人化定义（与 main.ts IPC 相同的构造方式）。
    const installResult = vault.install(`${source.id}:skills/demo/SKILL.md`, (input) => {
      const definition = vaultSkillDefinition();
      expect(definition.id.startsWith('user:')).toBe(true);
      expect(input.systemPrompt).toContain('VAULT-ZERO-EXPOSURE-MARKER');
      const saved = repository.save({ contractVersion: 1, definition, expectedRevision: 0 });
      if (!saved.ok || saved.code !== 'saved') return { ok: false, error: saved.code };
      return { ok: true, definitionId: saved.definition.id };
    });
    expect(installResult.ok).toBe(true);
    const afterInstall = vault.search({ sourceId: source.id }).find((entry) => entry.included)!;
    expect(afterInstall.installedDefinitionId).toBe(installResult.definitionId ?? null);

    // 已安装定义进入可绑定清单（enabled），但步骤不绑定 → 提示词无标记。
    const reader = new Reader();
    reader.definitions.set(agent.id, agent);
    const scenario = scenarioWithStep([]);
    reader.definitions.set(scenario.id, scenario);
    reader.definitions.set(VAULT_SKILL_ID, vaultSkillDefinition());
    const resolved = new PersonalizationResolver(reader).resolve({
      sessionId: 'session-vault',
      projectId: 'project-vault',
      scenarioId: scenario.id,
      createdAt: NOW,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const manifest: ResolvedRunManifest = resolved.manifest;
    const step = manifest.workflow[0]!;
    const unboundPrompt = composeManifestSystemPrompt(manifest, step);
    expect(unboundPrompt).not.toContain('VAULT-ZERO-EXPOSURE-MARKER');

    const boundStep = { ...step, skillIds: [VAULT_SKILL_ID] };
    const boundPrompt = composeManifestSystemPrompt(manifest, boundStep);
    expect(boundPrompt).toContain('VAULT-ZERO-EXPOSURE-MARKER');
  });

  it('重复安装如实返回 already_installed；卸载清链后可重装', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const vault = new CapabilityVaultService(db);
    vault.importLocalFiles(source.id, files);
    const repository = new PersonalizationRepository(db);
    const vaultId = `${source.id}:skills/demo/SKILL.md`;
    const installOnce = (): string => {
      const result = vault.install(vaultId, (input) => {
        // 与 main.ts vaultDefinitionIdFor 相同的顺序：先剥离前缀，净化后再拼接，
        // 否则净化会把 user: 的冒号一并替换导致 id 非法。
        const definitionId = `user:vault-${input.id.replace(/^skill:vault:/, '').replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 120)}`;
        expect(definitionId).toBe(VAULT_SKILL_ID);
        const existing = repository.get(definitionId);
        const definition = { ...vaultSkillDefinition(), id: definitionId, revision: existing ? existing.revision + 1 : 1 };
        const saved = repository.save({ contractVersion: 1, definition, expectedRevision: existing ? existing.revision : 0 });
        if (!saved.ok || saved.code !== 'saved') return { ok: false, error: saved.code };
        return { ok: true, definitionId: saved.definition.id };
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result.definitionId!;
    };
    const first = installOnce();
    expect(vault.install(vaultId, () => ({ ok: false, error: 'unused' })).code).toBe('already_installed');
    expect(vault.uninstall(vaultId)).toBe(true);
    expect(vault.uninstall(vaultId)).toBe(false);
    expect(vault.search({ sourceId: source.id }).find((entry) => entry.included)!.installedDefinitionId).toBeNull();
    const second = installOnce();
    expect(second).toBe(first);
  });
});
