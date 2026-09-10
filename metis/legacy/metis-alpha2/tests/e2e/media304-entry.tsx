/**
 * MEDIA-304 production-build visual fixture.
 *
 * The bridge and research client are installed synchronously before React mounts so
 * screenshots never inherit the default "bridge unavailable" recovery state.
 */
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import ProjectWorkspaceSidebar from '../../src/research/ProjectWorkspaceSidebar';
import ResearchInspectorPanels from '../../src/research/ResearchInspectorPanels';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';
import '../../src/index.css';

declare global {
  interface Window {
    __MEDIA_VISUAL_READY__?: true;
    __MEDIA_VISUAL_ERROR__?: string;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('missing #root');

const search = new URLSearchParams(window.location.search);
const overlay = search.get('overlay') || 'baseline';
document.documentElement.lang = 'zh-CN';
document.documentElement.dir = search.get('dir') === 'rtl' ? 'rtl' : 'ltr';

const now = Date.now();
const project = {
  id: 'p1',
  title: '媒体图片可信链验收项目',
  researchQuestion: '图片来源能否安全接入研究成果？',
  originalIntent: '验证 renderer 不接触本地路径与可信摘要。',
  lifecycle: 'draft' as const,
  methodology: '真实 Electron production bundle 视觉验收',
  discipline: '研究方法',
  createdAt: now - 3 * 86_400_000,
  updatedAt: now,
  deletedAt: null,
  archivedAt: null,
  version: 1,
};

const sources = [
  {
    id: 's1', projectId: 'p1', kind: 'image' as const, title: '图 1：双重差分平行趋势',
    authors: [], year: null, venue: '', identifier: '', identifierType: 'other' as const,
    externalUrl: null, tags: ['事件研究'], sourceVersionHash: null,
    createdAt: now - 86_400_000, updatedAt: now, deletedAt: null,
  },
  {
    id: 's2', projectId: 'p1', kind: 'image' as const, title: '图 2：倾向得分匹配质量',
    authors: [], year: null, venue: '', identifier: '', identifierType: 'other' as const,
    externalUrl: null, tags: ['稳健性'], sourceVersionHash: null,
    createdAt: now - 86_400_000, updatedAt: now, deletedAt: null,
  },
  {
    id: 'deleted', projectId: 'p1', kind: 'image' as const, title: '已删除的安慰剂检验图',
    authors: [], year: null, venue: '', identifier: '', identifierType: 'other' as const,
    externalUrl: null, tags: [], sourceVersionHash: null,
    createdAt: now - 172_800_000, updatedAt: now, deletedAt: now - 1_000,
  },
];

const stableSnapshot = {
  project,
  sources,
  evidence: [],
  noteCodes: [],
  claims: [],
  artifacts: [],
  artifactVersions: [],
  runs: [],
  checkpoints: [],
  decisions: [],
  claimEvidenceLinks: [],
  capturedAt: now,
} as const;

// Install the pathless capability bridge before createRoot.
(window as unknown as { metis: Record<string, unknown> }).metis = {
  selectFileCapability: async (purpose: string) => {
    if (purpose !== 'research-source') {
      return { success: false, code: 'file_capability_unavailable' };
    }
    return {
      success: true,
      capability: {
        capabilityId: 'fc_visual111111111111111111111111111',
        kind: 'file',
        mime: 'image/png',
        displayName: '平行趋势检验图.png',
        operations: ['read'],
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    };
  },
};

const stableClient = {
  listProjects: async () => ({ success: true, projects: [project] }),
  getSnapshot: async () => ({ success: true, snapshot: stableSnapshot }),
  mutateCrud: async () => ({ success: true, code: 'research_mutation_applied' }),
  mutateLink: async () => ({ success: true, code: 'research_mutation_applied' }),
  mutateReview: async () => ({ success: true, code: 'research_mutation_applied' }),
  mutateRestore: async () => ({ success: true, code: 'research_mutation_applied' }),
  mutateVersion: async () => ({ success: true, code: 'research_mutation_applied' }),
  mutateCheckpoint: async () => ({ success: true, code: 'research_mutation_applied' }),
  mutateDecision: async () => ({ success: true, code: 'research_mutation_applied' }),
  attachMedia: overlay === 'conflict'
    ? async () => ({ success: false, code: 'research_media_conflict' as const })
    : async () => ({ success: true, code: 'research_media_attached' as const }),
  purgeMedia: async (request: { sourceId?: string }) => {
    if (overlay === 'referenced' && request.sourceId === 'deleted') {
      return { success: false, code: 'research_media_referenced' as const };
    }
    return { success: true, code: 'research_media_purged' as const };
  },
};

researchWorkspaceStore.getState().setClient(stableClient as never);
researchWorkspaceStore.setState({
  projects: [project],
  activeProjectId: 'p1',
  snapshot: stableSnapshot as never,
  activeSection: 'project',
  selection: { kind: 'project', id: 'p1' },
  selectedIds: [],
  isRecycleBinOpen: false,
  loading: { projects: false, snapshot: false, mutation: false },
  error: null,
});

// eslint-disable-next-line react-refresh/only-export-components -- standalone Electron fixture is not hot reloaded.
function Fixture() {
  useEffect(() => {
    if (overlay === 'selftest_missing_marker') return;
    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (cancelled) return;
      const sidebar = document.querySelector('.research-workspace-sidebar');
      const inspector = document.querySelector('.research-inspector');
      if (!sidebar || !inspector) {
        window.__MEDIA_VISUAL_ERROR__ = 'fixture_mount_incomplete';
        return;
      }
      window.__MEDIA_VISUAL_READY__ = true;
    }));
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="media304-root">
      <style>{`
        html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
        .media304-root {
          display: grid;
          grid-template-columns: minmax(270px, 315px) minmax(0, 1fr);
          width: 100vw;
          height: 100vh;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: var(--bg-body, #f7f8fa);
        }
        .media304-sidebar-pane,
        .media304-inspector-pane {
          min-width: 0;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
        }
        .media304-inspector-pane {
          display: flex;
          flex-direction: column;
          overflow-y: hidden;
        }
        .media304-inspector-pane > .research-inspector {
          height: auto;
          flex: 1;
        }
        .media304-sidebar-pane { border-inline-end: 1px solid var(--border-color, #e2e8f0); }
        .media304-inspector-pane { padding: 16px; }
        .media304-title { margin: 8px 0 24px; font-size: 24px; }
        @media (max-width: 500px) {
          .media304-root {
            grid-template-columns: minmax(0, 1fr);
            grid-template-rows: minmax(240px, 45vh) minmax(0, 1fr);
          }
          .media304-sidebar-pane {
            border-inline-end: 0;
            border-bottom: 1px solid var(--border-color, #e2e8f0);
          }
          .media304-inspector-pane { padding: 10px; }
          .media304-title { margin: 2px 0 10px; font-size: 18px; }
        }
      `}</style>
      <div className="media304-sidebar-pane">
        <ProjectWorkspaceSidebar />
      </div>
      <div className="media304-inspector-pane">
        <h1 className="media304-title">MEDIA-304 · {overlay}</h1>
        <ResearchInspectorPanels />
      </div>
    </main>
  );
}

createRoot(rootElement).render(<Fixture />);
