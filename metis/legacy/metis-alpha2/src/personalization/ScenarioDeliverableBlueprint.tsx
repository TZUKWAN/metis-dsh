import React from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { DeliverableSection, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  collectDeliverableCompletenessGaps,
  requiredDeliverableFieldsForKind,
  type DeliverableRequiredField,
} from '../../engine/personalization/ScenarioHarness.js';

interface Props {
  zh: boolean;
  draft: ScenarioDefinition;
  mutateDraft(mutator: (scenario: ScenarioDefinition) => void): void;
  ensureDeliverable(scenario: ScenarioDefinition): void;
  busy: boolean;
}

const KIND_LABELS_ZH: Record<string, string> = {
  title: '标题', abstract: '摘要', keywords: '关键词', chapter: '章节', section: '小节',
  grant_column: '申报栏目', attachment: '附件', references: '参考文献', other: '其他',
};

const STATUS_LABELS_ZH: Record<string, string> = {
  locked: '锁定', required: '必选', optional: '可选', conditional: '条件出现',
};

const TOP_KINDS = ['title', 'abstract', 'keywords', 'chapter', 'grant_column', 'attachment', 'references', 'other'] as const;
const CHILD_KINDS = ['section', 'attachment', 'other'] as const;

// 「添加部分」下拉与段落编辑器「类型」下拉共用同一份清单和中文标签
// （刘总 2026-09：两处类型选择项必须一致，不允许一个少三项）。
const ADD_KINDS: Array<{ kind: string; zh: string; en: string }> = TOP_KINDS.map((kind) => ({
  kind,
  zh: KIND_LABELS_ZH[kind] ?? kind,
  en: kind,
}));

const FIELD_LABELS: Record<DeliverableRequiredField | 'optionalContent' | 'forbidden' | 'method' | 'evidence', { zh: string; en: string }> = {
  purpose: { zh: '这一部分的作用', en: 'Purpose' },
  instructions: { zh: '具体写作要求（完整的自然语言规范）', en: 'Writing instructions' },
  requirements: { zh: '必须包含（每行一条）', en: 'Requirements (one per line)' },
  optionalContent: { zh: '可选内容（每行一条）', en: 'Optional content (one per line)' },
  forbidden: { zh: '禁止事项（每行一条）', en: 'Forbidden (one per line)' },
  lengthTarget: { zh: '目标篇幅', en: 'Length target' },
  method: { zh: '方法要求', en: 'Method requirements' },
  evidence: { zh: '证据要求', en: 'Evidence requirements' },
};

function updateSectionTree(sections: DeliverableSection[], id: string, patch: Partial<DeliverableSection>): DeliverableSection[] {
  return sections.map((section) => {
    if (section.id === id) return { ...section, ...patch };
    if (section.children && section.children.length > 0) {
      return { ...section, children: updateSectionTree(section.children, id, patch) };
    }
    return section;
  });
}

function removeSectionTree(sections: DeliverableSection[], id: string): DeliverableSection[] {
  return sections
    .filter((section) => section.id !== id)
    .map((section) => (section.children && section.children.length > 0
      ? { ...section, children: removeSectionTree(section.children, id) }
      : section));
}

function findSection(sections: readonly DeliverableSection[], id: string): DeliverableSection | undefined {
  for (const section of sections) {
    if (section.id === id) return section;
    const found = section.children ? findSection(section.children, id) : undefined;
    if (found) return found;
  }
  return undefined;
}

function SectionRow(props: {
  section: DeliverableSection;
  depth: number;
  expanded: ReadonlySet<string>;
  toggleExpand(id: string): void;
  update(id: string, patch: Partial<DeliverableSection>): void;
  remove(id: string): void;
  addChild(parentId: string): void;
  zh: boolean;
  busy: boolean;
  missing: ReadonlySet<string>;
}) {
  const { section, depth, expanded, toggleExpand, update, remove, addChild, zh, busy, missing } = props;
  const isOpen = expanded.has(section.id);
  const hasChildren = (section.children?.length ?? 0) > 0;
  const isTopLevel = depth === 0;
  const requiredFields = requiredDeliverableFieldsForKind(section.kind);
  const showCondition = section.status === 'conditional';
  const kindOptions = isTopLevel ? TOP_KINDS : CHILD_KINDS;
  const childDepthClass = depth > 0 ? ' scenario-blueprint__item--nested' : '';

  return (
    <li className={`scenario-blueprint__item${childDepthClass}`} data-testid={`blueprint-section-${section.id}`}>
      <div className="scenario-blueprint__row">
        <button
          type="button"
          className="scenario-blueprint__toggle"
          aria-expanded={isOpen}
          aria-label={zh ? `展开或折叠「${section.title}」` : `Toggle ${section.title}`}
          disabled={busy}
          onClick={() => toggleExpand(section.id)}
        >
          <ChevronRight size={14} className={isOpen ? 'is-open' : undefined} />
        </button>
        <input
          className="scenario-blueprint__title"
          value={section.title}
          aria-label={zh ? `${section.title} 标题` : `${section.title} title`}
          onChange={(event) => update(section.id, { title: event.target.value })}
          disabled={busy}
        />
        <span className="scenario-blueprint__badge" data-kind={section.kind}>{KIND_LABELS_ZH[section.kind] ?? section.kind}</span>
        <span className="scenario-blueprint__badge scenario-blueprint__badge--status" data-status={section.status}>{STATUS_LABELS_ZH[section.status] ?? section.status}</span>
        {missing.has(section.id) && <span className="scenario-blueprint__badge scenario-blueprint__badge--missing" title={zh ? '该部分缺少必填的内容规范' : 'Missing required fields'}>{zh ? '待完善' : 'incomplete'}</span>}
        <input
          className="scenario-blueprint__length"
          value={section.lengthTarget ?? ''}
          placeholder={zh ? '篇幅' : 'length'}
          aria-label={zh ? `${section.title} 目标篇幅` : `${section.title} length target`}
          onChange={(event) => update(section.id, { lengthTarget: event.target.value || undefined })}
          disabled={busy}
        />
        <button
          type="button"
          className="scenario-blueprint__remove"
          aria-label={zh ? `删除「${section.title}」` : `Remove ${section.title}`}
          disabled={busy}
          onClick={() => remove(section.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {isOpen && (
        <div className="scenario-blueprint__detail">
          <div className="scenario-blueprint__detail-grid">
            <label>
              <span>{zh ? '类型' : 'Kind'}</span>
              <select
                value={section.kind}
                onChange={(event) => update(section.id, { kind: event.target.value as DeliverableSection['kind'] })}
                disabled={busy}
              >
                {kindOptions.map((kind) => <option key={kind} value={kind}>{KIND_LABELS_ZH[kind] ?? kind}</option>)}
              </select>
            </label>
            <label>
              <span>{zh ? '状态' : 'Status'}</span>
              <select
                value={section.status}
                onChange={(event) => update(section.id, { status: event.target.value as DeliverableSection['status'] })}
                disabled={busy}
              >
                {(['locked', 'required', 'optional', 'conditional'] as const).map((status) => (
                  <option key={status} value={status}>{STATUS_LABELS_ZH[status]}</option>
                ))}
              </select>
            </label>
          </div>
          {showCondition && (
            <label>
              <span>{zh ? '出现条件' : 'Condition'}</span>
              <textarea rows={2} value={section.condition ?? ''} onChange={(event) => update(section.id, { condition: event.target.value || undefined })} disabled={busy} />
            </label>
          )}
          {/* 刘总 2026-09：交付物部分只保留「具体写作要求」一个提示词字段，
              作用/必须包含/禁止事项/方法/证据字段不再对用户暴露。 */}
          <label>
            <span>{FIELD_LABELS.instructions[zh ? 'zh' : 'en']}{requiredFields.includes('instructions') ? ' *' : ''}</span>
            <textarea
              rows={5}
              value={section.instructions ?? ''}
              placeholder={zh ? '写出这一部分如何组织、论证如何展开的具体规范；避免「保持学术性」这类泛化表述。' : 'Concrete, section-specific writing requirements.'}
              onChange={(event) => update(section.id, { instructions: event.target.value || undefined })}
              disabled={busy}
              data-testid={`blueprint-instructions-${section.id}`}
            />
          </label>
          <div className="scenario-blueprint__detail-actions">
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => addChild(section.id)}>
              <Plus size={12} /> {zh ? '添加子部分' : 'Add child'}
            </button>
          </div>
          {hasChildren && (
            <ol className="scenario-blueprint__children">
              {(section.children ?? []).map((child) => (
                <SectionRow
                  key={child.id}
                  section={child}
                  depth={depth + 1}
                  expanded={expanded}
                  toggleExpand={toggleExpand}
                  update={update}
                  remove={remove}
                  addChild={addChild}
                  zh={zh}
                  busy={busy}
                  missing={missing}
                />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

export default function ScenarioDeliverableBlueprint(props: Props) {
  const { zh, draft, mutateDraft, ensureDeliverable, busy } = props;
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const sections = draft.deliverable?.sections ?? [];

  const gaps = collectDeliverableCompletenessGaps(draft);
  const missingSectionIds = new Set(gaps.filter((gap) => gap.field !== 'globalInstructions').map((gap) => gap.sectionId));
  const configuredTotal = (() => {
    const count = (list: readonly DeliverableSection[]): number => list.reduce(
      (total, section) => total + 1 + (section.children ? count(section.children) : 0),
      0,
    );
    return count(sections);
  })();
  const incompleteCount = missingSectionIds.size + (gaps.some((gap) => gap.field === 'globalInstructions') ? 1 : 0);
  const configuredCount = Math.max(0, configuredTotal + 1 - incompleteCount);

  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const update = (id: string, patch: Partial<DeliverableSection>) => mutateDraft((scenario) => {
    ensureDeliverable(scenario);
    scenario.deliverable!.sections = updateSectionTree(scenario.deliverable!.sections ?? [], id, patch);
  });

  const remove = (id: string) => mutateDraft((scenario) => {
    ensureDeliverable(scenario);
    scenario.deliverable!.sections = removeSectionTree(scenario.deliverable!.sections ?? [], id);
  });

  const addChild = (parentId: string) => mutateDraft((scenario) => {
    ensureDeliverable(scenario);
    const parent = findSection(scenario.deliverable!.sections ?? [], parentId);
    if (!parent) return;
    const ordinal = (parent.children?.length ?? 0) + 1;
    const child: DeliverableSection = {
      id: `${parentId}-s${Date.now().toString(36)}`,
      title: zh ? `新小节 ${ordinal}` : `New section ${ordinal}`,
      kind: 'section',
      status: 'required',
      children: [],
    };
    scenario.deliverable!.sections = updateSectionTree(scenario.deliverable!.sections ?? [], parentId, { children: [...(parent.children ?? []), child] });
    setExpanded((current) => new Set([...current, child.id]));
  });

  const addTopLevel = (kind: string) => mutateDraft((scenario) => {
    ensureDeliverable(scenario);
    const label = ADD_KINDS.find((item) => item.kind === kind);
    const section: DeliverableSection = {
      id: `${kind}-${Date.now().toString(36)}`,
      title: label ? (zh ? label.zh : label.en) : kind,
      kind: kind as DeliverableSection['kind'],
      status: 'required',
      children: [],
    };
    scenario.deliverable!.sections = [...(scenario.deliverable!.sections ?? []), section];
    setExpanded((current) => new Set([...current, section.id]));
  });

  return (
    <div className="scenario-blueprint" data-testid="sw-deliverable-blueprint">
      <div className="scenario-blueprint__head">
        <strong>{zh ? '成果蓝图（全部部分；点击展开编辑内容规范）' : 'Deliverable blueprint (all parts; expand to edit content requirements)'}</strong>
        {incompleteCount === 0 ? (
          <span className="scenario-blueprint__completeness scenario-blueprint__completeness--ok" data-testid="sw-deliverable-completeness">
            {zh ? `交付物完整 ${configuredCount} / ${configuredCount} 部分已配置` : `Complete ${configuredCount}/${configuredCount}`}
          </span>
        ) : (
          <span className="scenario-blueprint__completeness scenario-blueprint__completeness--todo" data-testid="sw-deliverable-completeness">
            {zh ? `还需完善 ${incompleteCount} 项（${configuredCount} / ${configuredCount + incompleteCount}）` : `${incompleteCount} part(s) incomplete`}
          </span>
        )}
        <select
          className="scenario-blueprint__add"
          value=""
          aria-label={zh ? '添加交付物部分' : 'Add deliverable part'}
          disabled={busy}
          onChange={(event) => { if (event.target.value) addTopLevel(event.target.value); }}
        >
          <option value="">{zh ? '＋ 添加部分…' : '＋ Add part…'}</option>
          {ADD_KINDS.map((item) => <option key={item.kind} value={item.kind}>{zh ? item.zh : item.en}</option>)}
        </select>
      </div>
      {gaps.length > 0 && (
        <ul className="scenario-blueprint__gaps" aria-label={zh ? '缺失清单' : 'Missing items'}>
          {gaps.slice(0, 8).map((gap) => (
            <li key={`${gap.sectionId}-${gap.field}`}>
              {gap.field === 'globalInstructions'
                ? (zh ? '总体成文要求（globalInstructions）' : 'globalInstructions')
                : `${gap.sectionTitle} · ${FIELD_LABELS[gap.field as DeliverableRequiredField]?.[zh ? 'zh' : 'en'] ?? gap.field}`}
            </li>
          ))}
          {gaps.length > 8 && <li>{zh ? `等 ${gaps.length} 项` : `+${gaps.length - 8} more`}</li>}
        </ul>
      )}
      {sections.length === 0 && <p className="scenario-blueprint__empty">{zh ? '暂未生成成果结构。' : 'No deliverable structure yet.'}</p>}
      <ol className="scenario-blueprint__list">
        {sections.map((section) => (
          <SectionRow
            key={section.id}
            section={section}
            depth={0}
            expanded={expanded}
            toggleExpand={toggleExpand}
            update={update}
            remove={remove}
            addChild={addChild}
            zh={zh}
            busy={busy}
            missing={missingSectionIds}
          />
        ))}
      </ol>
    </div>
  );
}
