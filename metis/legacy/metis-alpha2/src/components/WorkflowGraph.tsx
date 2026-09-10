/**
 * WorkflowGraph — O17 工作流可视化节点图（只读）。
 *
 * 把某个 goal 的 WorkflowDefinition（steps + dependencies DAG）渲染为分层
 * 节点图：每个步骤一个节点（名称 / id / 状态色块），依赖关系用 SVG 贝塞尔
 * 曲线连接。布局按「最长路径深度」分层（拓扑分层），不依赖 reactflow 等
 * 外部库。点击节点可在下方详情面板查看该步的 prompt / tools / maxTurns /
 * acceptanceCriteria / 运行结果。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from '../i18n';

// ─── 视图类型（与 GoalRuntimeContract 的 GoalWorkflow 契约对齐） ──

export type WorkflowGraphStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowGraphStep {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  maxTurns: number;
  acceptanceCriteria?: string[];
}

export interface WorkflowGraphStepResult {
  status: WorkflowGraphStepStatus;
  output: string;
  retryCount: number;
  failureReasons?: string[];
  decisionRequired?: boolean;
}

export interface WorkflowGraphData {
  id: string;
  name: string;
  description: string;
  version: string;
  steps: WorkflowGraphStep[];
  /** DAG：stepId → 它依赖的 stepId 列表。 */
  dependencies: Record<string, string[]>;
}

export interface WorkflowGraphProps {
  workflow: WorkflowGraphData;
  /** 最新 run 的步骤结果（可选；缺省时所有节点按 pending 展示）。 */
  stepResults?: Record<string, WorkflowGraphStepResult>;
  /** O7: goal id, needed to dispatch step decisions. */
  goalId?: string;
  /** O7: called when the user picks retry / skip / stop on an escalated step. */
  onResolveDecision?: (goalId: string, action: 'retry' | 'skip' | 'stop') => void;
  /**
   * O17: drag-to-reorder — called when a node is dropped onto another node.
   * The parent decides what reordering means (e.g. swap execution order).
   */
  onReorder?: (fromStepId: string, toStepId: string) => void;
}

// ─── 布局常量 ─────────────────────────────────────────────────

const NODE_WIDTH = 190;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 250;
const ROW_GAP = 96;
const GRAPH_PADDING = 16;

interface NodePosition {
  x: number;
  y: number;
}

/**
 * 拓扑分层：节点深度 = 0（无依赖）或 1 + max(依赖深度)。循环依赖时沿环
 * 退回深度 0，保证畸形定义也不会让渲染崩溃。
 */
function computeLayers(steps: WorkflowGraphStep[], dependencies: Record<string, string[]>): string[][] {
  const idSet = new Set(steps.map((step) => step.id));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (dependencies[id] ?? []).filter((dep) => idSet.has(dep) && dep !== id);
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep)));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };

  for (const step of steps) depthOf(step.id);

  const layers: string[][] = [];
  for (const step of steps) {
    const level = depth.get(step.id) ?? 0;
    while (layers.length <= level) layers.push([]);
    layers[level]!.push(step.id);
  }
  return layers;
}

const STATUS_COLORS: Record<WorkflowGraphStepStatus, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--status-running)',
  completed: 'var(--status-completed)',
  failed: 'var(--status-failed)',
  skipped: 'var(--text-muted)',
};

export default function WorkflowGraph({ workflow, stepResults, goalId, onResolveDecision, onReorder }: WorkflowGraphProps) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const layers = useMemo(
    () => computeLayers(workflow.steps, workflow.dependencies),
    [workflow.steps, workflow.dependencies],
  );

  const positions = useMemo(() => {
    const map = new Map<string, NodePosition>();
    layers.forEach((layer, column) => {
      layer.forEach((stepId, row) => {
        map.set(stepId, {
          x: GRAPH_PADDING + column * COLUMN_GAP,
          y: GRAPH_PADDING + row * ROW_GAP,
        });
      });
    });
    return map;
  }, [layers]);

  const edges = useMemo(() => {
    const idSet = new Set(workflow.steps.map((step) => step.id));
    const list: Array<{ from: string; to: string }> = [];
    for (const [stepId, deps] of Object.entries(workflow.dependencies)) {
      if (!idSet.has(stepId)) continue;
      for (const dep of deps) {
        if (idSet.has(dep) && dep !== stepId) list.push({ from: dep, to: stepId });
      }
    }
    return list;
  }, [workflow.steps, workflow.dependencies]);

  const stepById = useMemo(
    () => new Map(workflow.steps.map((step) => [step.id, step])),
    [workflow.steps],
  );

  const statusOf = (stepId: string): WorkflowGraphStepStatus =>
    stepResults?.[stepId]?.status ?? 'pending';

  const statusLabel = (status: WorkflowGraphStepStatus): string => {
    if (!zh) return status;
    switch (status) {
      case 'running': return '运行中';
      case 'completed': return '已完成';
      case 'failed': return '失败';
      case 'skipped': return '已跳过';
      default: return '待执行';
    }
  };

  const selectedStep = selectedStepId ? stepById.get(selectedStepId) ?? null : null;
  const selectedResult = selectedStepId ? stepResults?.[selectedStepId] : undefined;

  const graphWidth = Math.max(1, layers.length) * COLUMN_GAP + GRAPH_PADDING * 2 - (COLUMN_GAP - NODE_WIDTH);
  const graphHeight = Math.max(1, Math.max(...layers.map((layer) => layer.length), 1)) * ROW_GAP + GRAPH_PADDING * 2 - (ROW_GAP - NODE_HEIGHT);

  if (workflow.steps.length === 0) {
    return (
      <div data-testid="workflow-graph-empty" style={{ padding: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        {zh ? '该目标还没有可视化的工作流步骤。' : 'This goal has no workflow steps to visualize yet.'}
      </div>
    );
  }

  return (
    <div className="workflow-graph" data-testid="workflow-graph">
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
        {zh
          ? `工作流「${workflow.name}」：${workflow.steps.length} 个步骤，${edges.length} 条依赖。点击节点查看详情。`
          : `Workflow "${workflow.name}": ${workflow.steps.length} steps, ${edges.length} dependencies. Click a node for details.`}
      </div>
      <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius, 4px)', background: 'var(--bg-secondary)' }}>
        <div style={{ position: 'relative', width: graphWidth, height: graphHeight }}>
          <svg
            width={graphWidth}
            height={graphHeight}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            aria-hidden="true"
          >
            {edges.map((edge) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_HEIGHT / 2;
              const bend = Math.max(32, (x2 - x1) / 2);
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  data-testid="workflow-edge"
                  data-from={edge.from}
                  data-to={edge.to}
                  d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--text-muted)"
                  strokeWidth={1.5}
                  markerEnd="url(#workflow-graph-arrow)"
                />
              );
            })}
            <defs>
              <marker
                id="workflow-graph-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
              </marker>
            </defs>
          </svg>
          {workflow.steps.map((step) => {
            const position = positions.get(step.id);
            if (!position) return null;
            const status = statusOf(step.id);
            const selected = step.id === selectedStepId;
            return (
              <button
                key={step.id}
                type="button"
                data-testid={`workflow-node-${step.id}`}
                onClick={() => setSelectedStepId(selected ? null : step.id)}
                aria-pressed={selected}
                draggable={Boolean(onReorder)}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', step.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!onReorder) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  if (!onReorder) return;
                  e.preventDefault();
                  const fromId = e.dataTransfer.getData('text/plain');
                  if (fromId && fromId !== step.id) onReorder(fromId, step.id);
                }}
                style={{
                  position: 'absolute',
                  left: position.x,
                  top: position.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                  textAlign: 'left',
                  padding: '6px 8px',
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius, 4px)',
                  background: 'var(--bg-card, var(--bg-primary))',
                  color: 'var(--text-primary)',
                  cursor: onReorder ? 'grab' : 'pointer',
                  overflow: 'hidden',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    data-testid={`workflow-node-status-${step.id}`}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: STATUS_COLORS[status],
                    }}
                    title={statusLabel(status)}
                  />
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {step.name || step.id}
                  </span>
                </span>
                <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {step.id} · {statusLabel(status)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedStep && (
        <div
          data-testid="workflow-step-detail"
          style={{
            marginTop: 8,
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius, 4px)',
            background: 'var(--bg-card, var(--bg-primary))',
            fontSize: 13,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong>{selectedStep.name || selectedStep.id}</strong>
            <span style={{ fontSize: 11, color: STATUS_COLORS[statusOf(selectedStep.id)] }}>
              {statusLabel(statusOf(selectedStep.id))}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selectedStep.id}</span>
          </div>
          {selectedStep.description && (
            <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>{selectedStep.description}</p>
          )}
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
            <dt style={{ color: 'var(--text-muted)' }}>{zh ? '工具' : 'Tools'}</dt>
            <dd style={{ margin: 0 }} data-testid="workflow-detail-tools">
              {selectedStep.tools.length > 0 ? selectedStep.tools.join(', ') : (zh ? '（未限定）' : '(unrestricted)')}
            </dd>
            <dt style={{ color: 'var(--text-muted)' }}>maxTurns</dt>
            <dd style={{ margin: 0 }} data-testid="workflow-detail-maxturns">{selectedStep.maxTurns}</dd>
            {selectedStep.acceptanceCriteria && selectedStep.acceptanceCriteria.length > 0 && (
              <>
                <dt style={{ color: 'var(--text-muted)' }}>{zh ? '验收标准' : 'Acceptance'}</dt>
                <dd style={{ margin: 0 }} data-testid="workflow-detail-acceptance">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {selectedStep.acceptanceCriteria.map((criterion, index) => (
                      <li key={index}>{criterion}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          <div style={{ marginTop: 8 }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{zh ? '提示词' : 'Prompt'}</div>
            <pre
              data-testid="workflow-detail-prompt"
              style={{
                margin: 0,
                padding: 8,
                maxHeight: 160,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius, 4px)',
                fontSize: 12,
              }}
            >
              {selectedStep.prompt || (zh ? '（空）' : '(empty)')}
            </pre>
          </div>
          {selectedResult && (
            <div style={{ marginTop: 8 }} data-testid="workflow-detail-result">
              <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
                {zh ? '运行结果' : 'Step result'}
                {selectedResult.retryCount > 0 && (zh ? `（重试 ${selectedResult.retryCount} 次）` : ` (retried ${selectedResult.retryCount}x)`)}
                {selectedResult.decisionRequired && (zh ? ' · 等待人工决策' : ' · decision required')}
              </div>
              {selectedResult.failureReasons && selectedResult.failureReasons.length > 0 && (
                <ul style={{ margin: '0 0 6px', paddingLeft: 18, color: 'var(--status-failed)' }} data-testid="workflow-detail-failures">
                  {selectedResult.failureReasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              )}
              <pre
                data-testid="workflow-detail-output"
                style={{
                  margin: 0,
                  padding: 8,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius, 4px)',
                  fontSize: 12,
                }}
              >
                {selectedResult.output || (zh ? '（无输出）' : '(no output)')}
              </pre>
              {/* O7: human decision buttons on an escalated step. */}
              {selectedResult.decisionRequired && goalId && onResolveDecision && (
                <div
                  style={{ display: 'flex', gap: 8, marginTop: 8 }}
                  data-testid="workflow-decision-actions"
                >
                  <button
                    type="button"
                    className="btn-sm btn-primary"
                    onClick={() => onResolveDecision(goalId, 'retry')}
                    data-testid="workflow-decision-retry"
                  >
                    {zh ? '重试' : 'Retry'}
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    onClick={() => onResolveDecision(goalId, 'skip')}
                    data-testid="workflow-decision-skip"
                  >
                    {zh ? '跳过此步' : 'Skip step'}
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    onClick={() => onResolveDecision(goalId, 'stop')}
                    data-testid="workflow-decision-stop"
                  >
                    {zh ? '停止目标' : 'Stop goal'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
