import { createHash } from 'node:crypto';
import {
  PersonalizationDigestSchema,
  ResolvedRunManifestSchema,
  type AgentDefinition,
  type McpDefinition,
  type MetisRulesDefinition,
  type PersonalizationDefinition,
  type ResolvedPromptLayer,
  type ResolvedRunManifest,
  type ScenarioDefinition,
  type SkillDefinitionV2,
} from '../runtime/PersonalizationRuntimeContract.js';
import { renderScenarioMetisMarkdown } from './ScenarioHarness.js';

export interface PersonalizationDefinitionReader {
  get(id: string, includeArchived?: boolean): PersonalizationDefinition | undefined;
  list(kind?: PersonalizationDefinition['kind'], includeDisabled?: boolean): PersonalizationDefinition[];
}

export interface ResolvePersonalizationRequest {
  sessionId: string;
  projectId: string;
  scenarioId: string;
  projectRulesId?: string;
  createdAt?: number;
}

export type ResolvePersonalizationResult =
  | {
      ok: true;
      manifest: ResolvedRunManifest;
      scenario: ScenarioDefinition;
      agents: AgentDefinition[];
      skills: SkillDefinitionV2[];
      mcps: McpDefinition[];
      rules: MetisRulesDefinition[];
      systemPrompt: string;
    }
  | {
      ok: false;
      code: 'scenario_not_found' | 'scenario_disabled' | 'dependency_invalid' | 'definition_corrupt';
      issues: string[];
    };

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  // undefined 值键与 JSON 语义保持一致：不参与序列化（2026-08-29 刘总要求）。
  // 此前 `agentId:undefined` 会以字面量进入摘要，而传输后该键消失，
  // 导致 manifest digest 必然不匹配、场景执行被整体拒绝。
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function resolveKind<TKind extends PersonalizationDefinition['kind']>(
  reader: PersonalizationDefinitionReader,
  ids: readonly string[],
  kind: TKind,
): { values: Extract<PersonalizationDefinition, { kind: TKind }>[]; issues: string[] } {
  const values: Extract<PersonalizationDefinition, { kind: TKind }>[] = [];
  const issues: string[] = [];
  for (const id of unique(ids)) {
    const definition = reader.get(id);
    if (!definition) {
      issues.push(`Missing ${kind} definition: ${id}`);
      continue;
    }
    if (definition.kind !== kind) {
      issues.push(`Definition ${id} is ${definition.kind}, expected ${kind}`);
      continue;
    }
    if (!definition.enabled) {
      issues.push(`Definition is disabled: ${id}`);
      continue;
    }
    values.push(definition as Extract<PersonalizationDefinition, { kind: TKind }>);
  }
  return { values, issues };
}

function promptLayer(
  sourceId: string,
  sourceKind: ResolvedPromptLayer['sourceKind'],
  precedence: number,
  content: string,
): ResolvedPromptLayer {
  return {
    sourceId,
    sourceKind,
    precedence,
    contentDigest: PersonalizationDigestSchema.parse(sha256(content)),
    content,
  };
}

function composeSystemPrompt(layers: readonly ResolvedPromptLayer[]): string {
  return [...layers]
    .sort((left, right) => left.precedence - right.precedence || left.sourceId.localeCompare(right.sourceId))
    .map((layer) => `<!-- metis-source:${layer.sourceId} digest:${layer.contentDigest} -->\n${layer.content}`)
    .join('\n\n');
}

function formatOutputContract(
  output: ResolvedRunManifest['output'],
  heading: string,
): string {
  const lines = [
    `# ${heading}`,
    `Required format: ${output.format}.`,
  ];
  if (output.plan) {
    lines.push(`Primary deliverable: ${output.plan.primaryDeliverable}.`);
    if (output.plan.supportingArtifacts.length > 0) {
      lines.push('Supporting artifacts:');
      lines.push(...output.plan.supportingArtifacts.map((artifact) => `- ${artifact}`));
    }
    if (output.plan.qualityCriteria.length > 0) {
      lines.push('Quality criteria:');
      lines.push(...output.plan.qualityCriteria.map((criterion) => `- ${criterion}`));
    }
  }
  if (output.schema) {
    lines.push(`Output schema: ${canonicalJson(output.schema)}`);
  }
  if (output.requireEvidenceEnvelope) {
    lines.push('Keep evidence and source references attached to the claims they support.');
  }
  if (output.includeIntegrityReport) {
    lines.push('Include an integrity report covering unresolved gaps and incomplete deliverables.');
  }
  return lines.join('\n');
}

function skillPromptContent(skill: SkillDefinitionV2): string {
  const sections = [
    skill.markdown,
    skill.systemPrompt,
  ];
  if (skill.inputSchema) sections.push(`# Skill input schema\n${canonicalJson(skill.inputSchema)}`);
  if (skill.outputSchema) sections.push(`# Skill output schema\n${canonicalJson(skill.outputSchema)}`);
  return sections.filter(Boolean).join('\n\n');
}

function agentPromptContent(agent: AgentDefinition): string {
  return [
    agent.systemPrompt,
    formatOutputContract(agent.output, `Agent output contract: ${agent.name}`),
  ].filter(Boolean).join('\n\n');
}

function scenarioHarnessPromptContent(scenario: ScenarioDefinition): string {
  const sections: string[] = [];
  if (scenario.scenarioMetis) sections.push(renderScenarioMetisMarkdown(scenario.scenarioMetis));
  if (scenario.deliverable) sections.push(`# Deliverable blueprint\n${canonicalJson(scenario.deliverable)}`);
  // 刘总 2026-09：adaptiveTitles 开启时，蓝图标题仅作默认——同一场景适配
  // 不同论文时，小节标题应按本次实际研究内容重命名。
  if (scenario.deliverable?.adaptiveTitles) {
    sections.push('# Adaptive section titles\nThe chapter/section titles in the blueprint above are DEFAULTS, not fixed strings. Adapt and rename sub-section titles to fit the actual research content of this run; keep the structure (count, order, and hierarchy) unchanged.');
  }
  if (scenario.workflowPrompt?.trim()) sections.push(`# Workflow operating rules\n${scenario.workflowPrompt.trim()}`);
  return sections.join('\n\n');
}

/**
 * Compose the frozen prompt for either the complete scenario or one workflow step.
 * A step receives only its executing Agent and effective Skills, while every scoped
 * Metis.md rule and the scenario output contract continue to apply.
 */
export function composeManifestSystemPrompt(
  manifest: ResolvedRunManifest,
  step?: ResolvedRunManifest['workflow'][number],
): string {
  const layers = step
    ? manifest.promptStack.filter((layer) => (
        layer.sourceKind === 'rules'
        || layer.sourceKind === 'scenario_metis'
        || (layer.sourceKind === 'agent' && step.agentId !== undefined && layer.sourceId === step.agentId)
        || (layer.sourceKind === 'skill' && step.skillIds.includes(layer.sourceId))
      ))
    : manifest.promptStack;
  return [
    composeSystemPrompt(layers),
    formatOutputContract(manifest.output, 'Scenario output contract'),
  ].filter(Boolean).join('\n\n');
}

/**
 * 引用类型自愈：把绑进错误数组的定义 id 迁移到与其真实 kind 一致的数组。
 * 迁移规则：skillIds 中的 agent id → 顶层 agentIds；agentIds/mcpIds 反向同理。
 * 仅在定义真实存在且 kind 不一致时迁移；缺失/损坏的引用保持原样，
 * 交由后续依赖校验如实报告。
 */
function healScenarioReferenceKinds(
  scenario: ScenarioDefinition,
  reader: PersonalizationDefinitionReader,
): ScenarioDefinition {
  const kindOf = (id: string): PersonalizationDefinition['kind'] | null => {
    try {
      const definition = reader.get(id);
      return definition?.kind ?? null;
    } catch {
      return null;
    }
  };
  let agentIds = [...scenario.agentIds];
  let skillIds = [...scenario.skillIds];
  let mcpIds = [...scenario.mcpIds];
  let changed = false;

  const moveTopLevel = (id: string, from: 'agent' | 'skill' | 'mcp'): void => {
    const actual = kindOf(id);
    if (!actual || actual === from) return;
    if (from === 'skill') skillIds = skillIds.filter((item) => item !== id);
    if (from === 'agent') agentIds = agentIds.filter((item) => item !== id);
    if (from === 'mcp') mcpIds = mcpIds.filter((item) => item !== id);
    if (actual === 'agent' && !agentIds.includes(id)) agentIds.push(id);
    if (actual === 'skill' && !skillIds.includes(id)) skillIds.push(id);
    if (actual === 'mcp' && !mcpIds.includes(id)) mcpIds.push(id);
    changed = true;
  };
  for (const id of [...scenario.skillIds]) moveTopLevel(id, 'skill');
  for (const id of [...scenario.mcpIds]) moveTopLevel(id, 'mcp');
  for (const id of [...scenario.agentIds]) moveTopLevel(id, 'agent');

  const workflow = scenario.workflow.map((step) => {
    const next = step;
    let stepAgentId = next.agentId;
    let stepSkillIds = [...next.skillIds];
    let stepMcpIds = [...next.mcpIds];
    for (const id of [...step.skillIds]) {
      const actual = kindOf(id);
      if (!actual || actual === 'skill') continue;
      stepSkillIds = stepSkillIds.filter((item) => item !== id);
      if (actual === 'mcp') {
        if (!stepMcpIds.includes(id)) stepMcpIds.push(id);
      } else if (actual === 'agent' && !stepAgentId) {
        stepAgentId = id;
      } else if (actual === 'agent' && !agentIds.includes(id)) {
        agentIds.push(id);
      }
      changed = true;
    }
    for (const id of [...step.mcpIds]) {
      const actual = kindOf(id);
      if (!actual || actual === 'mcp') continue;
      stepMcpIds = stepMcpIds.filter((item) => item !== id);
      if (actual === 'skill' && !stepSkillIds.includes(id)) stepSkillIds.push(id);
      else if (actual === 'agent' && !agentIds.includes(id)) agentIds.push(id);
      changed = true;
    }
    if (!changed) return next;
    changed = true;
    return { ...next, agentId: stepAgentId, skillIds: stepSkillIds, mcpIds: stepMcpIds };
  });

  if (!changed) return scenario;
  return {
    ...scenario,
    agentIds,
    skillIds,
    mcpIds,
    workflow,
  };
}

export class PersonalizationResolver {
  readonly #reader: PersonalizationDefinitionReader;

  constructor(reader: PersonalizationDefinitionReader) {
    this.#reader = reader;
  }

  resolve(request: ResolvePersonalizationRequest): ResolvePersonalizationResult {
    let candidate: PersonalizationDefinition | undefined;
    try {
      candidate = this.#reader.get(request.scenarioId);
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Scenario definition could not be decoded'] };
    }
    if (!candidate || candidate.kind !== 'scenario') {
      return { ok: false, code: 'scenario_not_found', issues: [`Scenario not found: ${request.scenarioId}`] };
    }
    if (!candidate.enabled) {
      return { ok: false, code: 'scenario_disabled', issues: [`Scenario is disabled: ${request.scenarioId}`] };
    }
    // 引用类型自愈（2026-08-29 刘总要求：校验用来纠正，不用来拒绝执行）。
    // 模型常把 agent 定义绑进 skillIds（或反向）——类型标签写错不改变绑定
    // 意图，这里按库中真实类型迁移到正确数组后再走依赖校验。
    const scenario = healScenarioReferenceKinds(candidate, this.#reader);

    try {
      const workflowAgentIds = scenario.workflow
        .map((step) => step.agentId)
        .filter((id): id is string => typeof id === 'string');
      const workflowSkillIds = scenario.workflow.flatMap((step) => step.skillIds);
      const workflowMcpIds = scenario.workflow.flatMap((step) => step.mcpIds);
      const agentResult = resolveKind(this.#reader, [...scenario.agentIds, ...workflowAgentIds], 'agent');
      const directSkillResult = resolveKind(this.#reader, [...scenario.skillIds, ...workflowSkillIds], 'skill');
      const agentSkillIds = agentResult.values.flatMap((agent) => agent.skillIds);
      const skillResult = resolveKind(this.#reader, [...directSkillResult.values.map((skill) => skill.id), ...agentSkillIds], 'skill');
      const skillMcpIds = skillResult.values.flatMap((skill) => skill.mcpIds);
      const agentMcpIds = agentResult.values.flatMap((agent) => agent.mcpIds);
      const mcpResult = resolveKind(
        this.#reader,
        [...scenario.mcpIds, ...workflowMcpIds, ...agentMcpIds, ...skillMcpIds],
        'mcp',
      );
      const globalRuleIds = this.#reader.list('rules', false)
        .filter((definition): definition is MetisRulesDefinition => definition.kind === 'rules' && definition.scope === 'global')
        .map((definition) => definition.id);
      const ruleResult = resolveKind(
        this.#reader,
        [
          ...globalRuleIds,
          ...scenario.rulesIds,
          ...(request.projectRulesId ? [request.projectRulesId] : []),
        ],
        'rules',
      );

      const selectedAgentIds = new Set(scenario.agentIds);
      const selectedSkillIds = new Set(scenario.skillIds);
      const selectedMcpIds = new Set(scenario.mcpIds);
      const workflowBindingIssues = scenario.workflow.flatMap((step) => [
        ...(step.agentId && !selectedAgentIds.has(step.agentId)
          ? [`Workflow Agent ${step.agentId} is not declared by scenario ${scenario.id}`]
          : []),
        ...step.skillIds
          .filter((skillId) => !selectedSkillIds.has(skillId))
          .map((skillId) => `Workflow Skill ${skillId} is not declared by scenario ${scenario.id}`),
        ...step.mcpIds
          .filter((mcpId) => !selectedMcpIds.has(mcpId))
          .map((mcpId) => `Workflow MCP ${mcpId} is not declared by scenario ${scenario.id}`),
      ]);
      const expectedProjectScopeId = `user:projects/${request.projectId}`;
      const scopeIssues = ruleResult.values.flatMap((rule) => {
        if (rule.scope === 'global') return [];
        if (rule.scope === 'scenario') {
          return rule.scopeId === scenario.id && scenario.rulesIds.includes(rule.id)
            ? []
            : [`Scenario rule ${rule.id} is not bound to ${scenario.id}`];
        }
        return rule.scopeId === expectedProjectScopeId && request.projectRulesId === rule.id
          ? []
          : [`Project rule ${rule.id} is not bound to ${expectedProjectScopeId}`];
      });

      const issues = unique([
        ...agentResult.issues,
        ...directSkillResult.issues,
        ...skillResult.issues,
        ...mcpResult.issues,
        ...ruleResult.issues,
        ...workflowBindingIssues,
        ...scopeIssues,
      ]);
      if (issues.length > 0) return { ok: false, code: 'dependency_invalid', issues };

      const agents = agentResult.values;
      const skills = skillResult.values;
      const mcps = mcpResult.values;
      const rules = ruleResult.values;
      const agentById = new Map(agents.map((agent) => [agent.id, agent]));
      const skillById = new Map(skills.map((skill) => [skill.id, skill]));
      const mcpById = new Map(mcps.map((mcp) => [mcp.id, mcp]));
      const resolveEffectiveStep = (step: ScenarioDefinition['workflow'][number]) => {
        const agent = step.agentId ? agentById.get(step.agentId) : undefined;
        const skillIds = unique([
          ...step.skillIds,
          ...(agent?.skillIds ?? []),
        ]);
        const stepSkills = skillIds
          .map((skillId) => skillById.get(skillId))
          .filter((skill): skill is SkillDefinitionV2 => skill !== undefined);
        const mcpIds = unique([
          ...step.mcpIds,
          ...(agent?.mcpIds ?? []),
          ...stepSkills.flatMap((skill) => skill.mcpIds),
        ]);
        const stepMcps = mcpIds
          .map((mcpId) => mcpById.get(mcpId))
          .filter((mcp): mcp is McpDefinition => mcp !== undefined);
        return {
          ...step,
          agentModelPreference: agent?.modelPreference ?? null,
          retryLimit: agent?.retryLimit ?? 0,
          memory: agent?.memory ?? scenario.memory,
          output: agent?.output ?? scenario.output,
          skillIds,
          mcpIds,
          toolIds: unique([
            ...step.toolIds,
            ...(agent?.toolIds ?? []),
            ...stepSkills.flatMap((skill) => skill.toolIds),
            ...stepMcps.flatMap((mcp) => mcp.exposedTools),
          ]).sort(),
          maxTurns: Math.max(1, Math.min(
            step.maxTurns,
            agent?.maxTurns ?? step.maxTurns,
            ...stepSkills.map((skill) => skill.maxTurns),
          )),
        };
      };
      const effectiveWorkflow = scenario.workflow.map(resolveEffectiveStep);
      const implicitOutputStep = scenario.workflow.length === 0
        && scenario.output.plan
        && agents.length === 1
        ? resolveEffectiveStep({
            id: 'runtime-output-plan',
            name: 'Generate configured deliverables',
            description: 'Generate the user-configured output plan with the selected Agent and bound capabilities.',
            agentId: agents[0]!.id,
            skillIds: [...scenario.skillIds],
            toolIds: [],
            mcpIds: [...scenario.mcpIds],
            dependsOn: [],
            maxTurns: agents[0]!.maxTurns,
          })
        : undefined;
      const promptStack: ResolvedPromptLayer[] = [
        ...skills.map((skill) => promptLayer(skill.id, 'skill', 100, skillPromptContent(skill))),
        ...agents.map((agent) => promptLayer(agent.id, 'agent', 200, agentPromptContent(agent))),
        ...rules.filter((rule) => rule.scope === 'global')
          .map((rule) => promptLayer(rule.id, 'rules', 300, rule.markdown)),
        ...rules.filter((rule) => rule.scope === 'scenario')
          .map((rule) => promptLayer(rule.id, 'rules', 400, rule.markdown)),
        ...(scenarioHarnessPromptContent(scenario)
          ? [promptLayer(scenario.id, 'scenario_metis', 450, scenarioHarnessPromptContent(scenario))]
          : []),
        ...rules.filter((rule) => rule.scope === 'project')
          .map((rule) => promptLayer(rule.id, 'rules', 500, rule.markdown)),
      ];
      const definitions: PersonalizationDefinition[] = [scenario, ...agents, ...skills, ...mcps, ...rules];
      const definitionRevisions = Object.fromEntries(
        definitions.map((definition) => [definition.id, definition.revision]),
      );
      const allowedTools = unique(effectiveWorkflow.length > 0
        ? effectiveWorkflow.flatMap((step) => step.toolIds)
        : [
            ...agents.flatMap((agent) => agent.toolIds),
            ...skills.flatMap((skill) => skill.toolIds),
            ...mcps.flatMap((mcp) => mcp.exposedTools),
          ]).sort();
      const maxTurns = Math.max(
        1,
        ...effectiveWorkflow.map((step) => step.maxTurns),
        ...agents.map((agent) => agent.maxTurns),
        ...skills.map((skill) => skill.maxTurns),
      );
      const manifestWithoutDigest = {
        contractVersion: 1 as const,
        sessionId: request.sessionId,
        projectId: request.projectId,
        scenarioId: scenario.id,
        scenarioRevision: scenario.revision,
        definitionRevisions,
        agentIds: agents.map((agent) => agent.id),
        skillIds: skills.map((skill) => skill.id),
        mcpIds: mcps.map((mcp) => mcp.id),
        allowedTools,
        workflow: effectiveWorkflow,
        ...(scenario.workflowPrompt?.trim() ? { workflowPrompt: scenario.workflowPrompt.trim() } : {}),
        ...(implicitOutputStep ? { implicitOutputStep } : {}),
        maxTurns,
        promptStack,
        ...(scenario.hooks && scenario.hooks.length > 0 ? { hooks: scenario.hooks } : {}),
        harnessVersion: scenario.revision,
        ...(scenario.deliverable ? { deliverable: scenario.deliverable } : {}),
        ...(scenario.writingStyle ? { writingStyle: scenario.writingStyle } : {}),
        ...(scenario.adaptivity ? { adaptivity: scenario.adaptivity } : {}),
        ...(scenario.scenarioMetis ? { scenarioMetis: scenario.scenarioMetis } : {}),
        ...(scenario.workflowGovernance ? { workflowGovernance: scenario.workflowGovernance } : {}),
        ...(scenario.workflowLoop ? { workflowLoop: scenario.workflowLoop } : {}),
        ...(scenario.checkpointPolicy ? { checkpointPolicy: scenario.checkpointPolicy } : {}),
        ...(scenario.qualityGates ? { qualityGates: scenario.qualityGates } : {}),
        fullAccess: scenario.fullAccess,
        memory: scenario.memory,
        output: scenario.output,
        truthPolicy: 'automatic_required' as const,
        createdAt: request.createdAt ?? Date.now(),
      };
      // createdAt 是每次 resolve 的当前时间戳（非确定性字段），必须剔除出
      // digest 输入——否则同一场景定义每次 resolve 的 digest 都不同，恢复
      // 判定永远失败，任务每次都从头重跑（2026-08-30 刘总报告根因）。
      // 与 coordinator 端 digestResolvedManifestSnapshot 的剔除清单保持同规。
      const { createdAt: _createdAt, ...digestInput } = manifestWithoutDigest;
      void _createdAt;
      const manifest = ResolvedRunManifestSchema.parse({
        ...manifestWithoutDigest,
        manifestDigest: sha256(canonicalJson(digestInput)),
      });
      return {
        ok: true,
        manifest,
        scenario,
        agents,
        skills,
        mcps,
        rules,
        systemPrompt: composeManifestSystemPrompt(manifest),
      };
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Personalization graph could not be resolved'] };
    }
  }
}
