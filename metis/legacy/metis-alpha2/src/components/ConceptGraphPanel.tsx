/**
 * ConceptGraphPanel — 概念-理论-文献-论断图谱（T28）。
 *
 * 数据全部来自项目真实研究资产：资料（source）内圈、编码（code）中圈、
 * 论断（claim）外圈；边 = 论断-证据-资料（supports）与 编码-论断（coded）。
 * 同心环静态布局（确定性，无物理引擎），SVG 渲染，节点可悬停看全文。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { useOverlayDialog } from '../hooks/useOverlayDialog';
import './ConceptGraphPanel.css';

interface GraphNode {
  id: string;
  kind: 'source' | 'code' | 'claim';
  label: string;
}
interface GraphEdge {
  from: string;
  to: string;
  kind: 'supports' | 'coded';
}

interface Positioned extends GraphNode {
  x: number;
  y: number;
}

const KIND_COLORS: Record<GraphNode['kind'], string> = {
  source: 'var(--accent, #8b5a2b)',
  code: '#5a7d8b',
  claim: '#7d8b5a',
};

export default function ConceptGraphPanel({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [hover, setHover] = useState<GraphNode | null>(null);
  const { containerRef } = useOverlayDialog({ onClose });

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void window.metis?.getConceptGraph?.(projectId).then((graph) => {
      if (!alive || !graph) return;
      setNodes(graph.nodes);
      setEdges(graph.edges);
    });
    return () => { alive = false; };
  }, [projectId]);

  const positioned = useMemo(() => {
    const width = 760;
    const height = 520;
    const cx = width / 2;
    const cy = height / 2;
    const rings: Array<GraphNode['kind']> = ['source', 'code', 'claim'];
    const result: Positioned[] = [];
    rings.forEach((kind, ringIndex) => {
      const group = nodes.filter((node) => node.kind === kind);
      const radius = 70 + ringIndex * 95;
      group.forEach((node, index) => {
        const angle = (index / Math.max(1, group.length)) * Math.PI * 2 - Math.PI / 2;
        result.push({
          ...node,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      });
    });
    return { result, width, height };
  }, [nodes]);

  const byId = useMemo(() => new Map(positioned.result.map((node) => [node.id, node])), [positioned]);

  return (
    <div className="cgraph-overlay" data-testid="cgraph-overlay" role="dialog" aria-modal="true" aria-label={t('cgraph.title')} style={{ zIndex: 'var(--z-overlay, 89)' }} ref={containerRef}>
      <div className="cgraph-card">
        <header className="cgraph-header">
          <h2>{t('cgraph.title')}</h2>
          <button type="button" className="methods-panel__close" onClick={onClose} aria-label={t('browserOverlay.close')} data-testid="cgraph-close">✕</button>
        </header>
        <p className="cgraph-legend">
          <span style={{ color: KIND_COLORS.source }}>● {t('cgraph.sources', { count: nodes.filter((n) => n.kind === 'source').length })}</span>
          <span style={{ color: KIND_COLORS.code }}>● {t('cgraph.codes', { count: nodes.filter((n) => n.kind === 'code').length })}</span>
          <span style={{ color: KIND_COLORS.claim }}>● {t('cgraph.claims', { count: nodes.filter((n) => n.kind === 'claim').length })}</span>
        </p>
        {nodes.length === 0 ? (
          <p className="cgraph-empty" data-testid="cgraph-empty">{t('cgraph.empty')}</p>
        ) : (
          <svg viewBox={`0 0 ${positioned.width} ${positioned.height}`} className="cgraph-svg" data-testid="cgraph-svg" role="img">
            {edges.map((edge, index) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              return (
                <line
                  key={index}
                  x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  stroke={edge.kind === 'coded' ? '#5a7d8b55' : '#8b5a2b44'}
                  strokeWidth={edge.kind === 'coded' ? 1 : 1.4}
                />
              );
            })}
            {positioned.result.map((node) => (
              <g key={node.id} onMouseEnter={() => setHover(node)} onMouseLeave={() => setHover(null)}>
                <circle cx={node.x} cy={node.y} r={node.kind === 'claim' ? 7 : 5} fill={KIND_COLORS[node.kind]} opacity={0.85} />
                <text x={node.x + 9} y={node.y + 3} fontSize={9} fill="var(--text-secondary, #555)">
                  {node.label.slice(0, 12)}
                </text>
              </g>
            ))}
          </svg>
        )}
        {hover && <div className="cgraph-hover" data-testid="cgraph-hover">{hover.label}</div>}
      </div>
    </div>
  );
}
