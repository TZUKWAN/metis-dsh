/** Bounded, source-attributed project context for one Outcome assistant turn. */
import type { OutcomeAssistantDiagnostic, OutcomeSource } from '../engine/runtime/OutcomeRuntimeContract.js';
import type { WorkspaceAgentsView } from '../engine/runtime/WorkspaceAgentsContract.js';
import type { OutcomeAssistantProjectRecord, OutcomeRepository } from './OutcomeRepository.js';
import { projectMetisRulesFromWorkspace } from './ProjectMetisRulesBridge.js';

const MAX_CONTEXT_RECORDS = 6;
const MAX_PER_RECORD_CHARS = 3_200;
const MAX_TOTAL_CHARS = 12_000;
const MAX_CANDIDATES_PER_KIND = 8;

export interface OutcomeProjectContext {
  sources: OutcomeSource[];
  prompt: string;
  diagnostics: OutcomeAssistantDiagnostic[];
}

/**
 * A deliberately narrow projection of the authoritative project Metis.md
 * reader.  The renderer never supplies its content: Electron main obtains it
 * from the project's CAS-protected workspace manager and validates it before
 * exposing this immutable snapshot to one assistant turn.
 */
export type OutcomeProjectMetisReadResult =
  | { status: 'available'; markdown: string; revision: number }
  | { status: 'absent' }
  | { status: 'unavailable' };

export interface OutcomeProjectMetisReader {
  read(projectId: string): OutcomeProjectMetisReadResult;
}

/**
 * Converts the current project workspace's CAS-protected public Metis.md
 * surface into the only shape the assistant may consume.  Both Electron main
 * and the Electron-ABI smoke use this exact function so a raw workspace view,
 * conflict, bad digest, or cross-project view is never silently accepted.
 */
export function readOutcomeProjectMetisFromWorkspace(
  manager: Pick<{ read(): WorkspaceAgentsView }, 'read'> | null,
  projectId: string,
): OutcomeProjectMetisReadResult {
  try {
    if (!manager) return { status: 'unavailable' };
    const projected = projectMetisRulesFromWorkspace({ ...manager.read(), projectId }, projectId);
    if (!projected.ok) return { status: 'unavailable' };
    if (!projected.definition || projected.definition.markdown.length === 0) return { status: 'absent' };
    return {
      status: 'available',
      markdown: projected.definition.markdown,
      revision: projected.definition.revision,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

interface RequestedContextKinds {
  otherOutcomes: boolean;
  history: boolean;
  artifacts: boolean;
  metis: boolean;
}

function requestedKinds(instruction: string): RequestedContextKinds {
  const text = instruction.toLocaleLowerCase();
  const otherOutcomes = /(?:其他成果|其它成果|相关成果|项目成果|other\s+outcomes?|cross[- ]?outcome)/u.test(text);
  const history = /(?:历史版本|历史|旧版|先前版本|之前版本|过往版本|previous\s+versions?|version\s+history|earlier\s+versions?)/u.test(text);
  const artifacts = /(?:项目资料|项目文档|项目素材|研究资料|研究产物|研究成果|artifact|project\s+(?:materials?|documents?|artifacts?|context))/u.test(text);
  const metis = /(?:metis(?:\.md)?|项目规则|project\s+rules?)/u.test(text);
  return { otherOutcomes, history, artifacts, metis };
}

function truncate(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, Math.max(0, max - 48))}\n[该来源已按本轮上下文上限截断；未展示部分未被模型读取。]`, truncated: true };
}

function termsForRelevance(instruction: string): string[] {
  const ignored = new Set(['项目', '资料', '成果', '历史', '版本', '参考', '其他', 'project', 'materials', 'artifact', 'context', 'other', 'outcome', 'history', 'version']);
  return (instruction.toLocaleLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,8}/gu) ?? [])
    .filter((term, index, all) => !ignored.has(term) && all.indexOf(term) === index)
    .slice(0, 12);
}

function relevance(record: OutcomeAssistantProjectRecord, terms: string[]): number {
  const haystack = record.type === 'artifact'
    ? `${record.title}\n${record.content.slice(0, 8_000)}`.toLocaleLowerCase()
    : `${record.title}\n${JSON.stringify(record.document).slice(0, 8_000)}`.toLocaleLowerCase();
  const title = record.title.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (title.includes(term) ? 5 : 0) + (haystack.includes(term) ? 1 : 0), 0);
}

function recordPrompt(record: OutcomeAssistantProjectRecord): { source: OutcomeSource; text: string } {
  if (record.type === 'artifact') {
    return {
      source: { kind: 'artifact', id: record.id, version: record.version, label: `项目资料：${record.title.slice(0, 420)} v${record.version}` },
      text: `项目资料（Artifact ${record.id}，${record.artifactType}，v${record.version}，标题：${record.title}）：\n${record.content}`,
    };
  }
  const type = record.type === 'other_outcome' ? '同项目其他成果' : '当前成果历史版本';
  return {
    source: { kind: 'outcome_version', id: record.id, version: record.version, label: `${type}：${record.title.slice(0, 420)} v${record.version}` },
    text: `${type}（Outcome ${record.id}，${record.kind}，v${record.version}，标题：${record.title}，版本说明：${record.note}）：\n${JSON.stringify(record.document)}`,
  };
}

function diagnostic(code: OutcomeAssistantDiagnostic['code'], message: string): OutcomeAssistantDiagnostic {
  return { code, message };
}

/**
 * Reads only DB-backed, project-owned text snapshots plus an optional,
 * authoritative Project Metis.md projection. It purposefully does not claim
 * to read arbitrary workspace files, uploads, sources or evidence.
 */
export class OutcomeProjectContextService {
  constructor(
    private readonly repository: OutcomeRepository,
    private readonly projectMetisReader?: OutcomeProjectMetisReader,
  ) {}

  collect(input: { projectId: string; outcomeId: string; instruction: string; /** 任务2：会话显式选中的 artifact（activeArtifactIds）。undefined=调用方未提供（兼容旧路径）；空数组=明确无选中成果，禁止按最近更新抓取。 */ activeArtifactIds?: string[] }): OutcomeProjectContext {
    const requested = requestedKinds(input.instruction);
    if (!requested.otherOutcomes && !requested.history && !requested.artifacts && !requested.metis) {
      return { sources: [], prompt: '', diagnostics: [] };
    }
    const diagnostics: OutcomeAssistantDiagnostic[] = [];
    const needsDatabaseRecords = requested.otherOutcomes || requested.history || requested.artifacts;
    let records: OutcomeAssistantProjectRecord[] = [];
    if (needsDatabaseRecords) {
      try {
        records = this.repository.listAssistantProjectRecords({
          projectId: input.projectId,
          outcomeId: input.outcomeId,
          includeOtherOutcomes: requested.otherOutcomes || requested.artifacts,
          includeHistory: requested.history,
          includeArtifacts: requested.artifacts,
          candidateLimit: MAX_CANDIDATES_PER_KIND,
          ...(input.activeArtifactIds !== undefined ? { artifactIds: input.activeArtifactIds } : {}),
        });
      } catch {
        diagnostics.push(diagnostic('project_context_unavailable', '当前项目上下文读取失败；本轮未参考其他成果、历史版本或项目资料。'));
      }
    }
    // 任务2（Artifact Context）：请求项目资料但没有显式选中的 artifact 时，
    // 必须明确「无选中成果」，不得暗中用「最近更新的 artifact」替代用户选择。
    if (requested.artifacts && input.activeArtifactIds?.length === 0) {
      diagnostics.push(diagnostic('project_context_unavailable', '当前会话没有选中的项目资料（active artifact 为空）；本轮未自动抓取最近项目资料。'));
    }

    // “项目资料” may use the durable Artifact store and peer Outcomes, but a
    // request for only “其他成果” must not pull Artifacts, and vice versa.
    records = records.filter((record) => (
      (record.type === 'other_outcome' && (requested.otherOutcomes || requested.artifacts))
      || (record.type === 'outcome_history' && requested.history)
      || (record.type === 'artifact' && requested.artifacts)
    ));
    const terms = termsForRelevance(input.instruction);
    records.sort((left, right) => relevance(right, terms) - relevance(left, terms) || right.updatedAt - left.updatedAt);

    const sources: OutcomeSource[] = [];
    const fragments: string[] = [];
    let usedChars = 0;
    let omitted = false;

    // Explicit Project Metis.md requests always get a bounded slot before
    // optional peer records. Otherwise a long peer list could make the user
    // ask for project rules yet silently omit the only requested rule source.
    if (requested.metis) {
      let metis: OutcomeProjectMetisReadResult = { status: 'unavailable' };
      try {
        metis = this.projectMetisReader?.read(input.projectId) ?? metis;
      } catch {
        metis = { status: 'unavailable' };
      }
      if (metis.status === 'available') {
        const rendered = `项目规则（Project Metis.md，v${metis.revision}）：\n${metis.markdown}`;
        const perRecord = truncate(rendered, MAX_PER_RECORD_CHARS);
        const bounded = truncate(perRecord.value, MAX_TOTAL_CHARS);
        if (bounded.value.length > 0) {
          sources.push({ kind: 'project_metis', id: input.projectId, version: metis.revision, label: `Project Metis.md v${metis.revision}` });
          fragments.push(bounded.value);
          usedChars += bounded.value.length;
          omitted ||= perRecord.truncated || bounded.truncated;
        }
      } else {
        const message = metis.status === 'absent'
          ? '当前项目没有可读取的 Project Metis.md；本轮未参考项目规则。'
          : '本轮未参考 Project Metis.md：项目规则读取或校验不可用。';
        diagnostics.push(diagnostic('project_context_unavailable', message));
      }
    }
    for (const record of records) {
      if (sources.length >= MAX_CONTEXT_RECORDS) { omitted = true; break; }
      const rendered = recordPrompt(record);
      const perRecord = truncate(rendered.text, MAX_PER_RECORD_CHARS);
      const remaining = MAX_TOTAL_CHARS - usedChars;
      if (remaining <= 0) { omitted = true; break; }
      const bounded = truncate(perRecord.value, remaining);
      if (bounded.value.length === 0) { omitted = true; break; }
      sources.push(rendered.source);
      fragments.push(bounded.value);
      usedChars += bounded.value.length;
      omitted ||= perRecord.truncated || bounded.truncated;
    }
    const hasDatabaseSource = sources.some((source) => source.kind === 'outcome_version' || source.kind === 'artifact');
    if (needsDatabaseRecords && !hasDatabaseSource) {
      diagnostics.push(diagnostic('project_context_unavailable', '未找到本轮可读取且属于当前项目的其他成果、历史版本或项目资料；模型未参考任何此类来源。'));
    }
    if (omitted) diagnostics.push(diagnostic('project_context_truncated', `项目上下文按每条 ${MAX_PER_RECORD_CHARS} 字符、总计 ${MAX_TOTAL_CHARS} 字符和最多 ${MAX_CONTEXT_RECORDS} 项限制截断；未列出的记录未被模型读取。`));
    return {
      sources,
      prompt: fragments.length ? `项目上下文（仅以下实际读取的同项目持久化记录可被引用）：\n${fragments.join('\n\n')}` : '',
      diagnostics,
    };
  }
}
