/**
 * Metis Workbench state store — frontend state management via Zustand.
 * Holds paper library, notes, experiments, and shared navigation state.
 * In Electron, syncs with the main process via IPC.
 */

import { create } from 'zustand';
import type { ExperimentMetadata } from '../engine/runtime/ExperimentMetadataContract';
import type { PaperItem, ReadStatus } from '../engine/research/PaperItem';
import { RagEngine } from '../engine/research/RagEngine';
import {
  ExperimentRuntimeStatusSchema,
  ExperimentScriptAttachmentSchema,
  ExperimentScriptFailureCodeSchema,
  type ExperimentRuntimeStatus,
  type ExperimentScriptAttachment,
  type ExperimentScriptFailureCode,
} from '../engine/runtime/ExperimentRuntimeContract';

// ─── Types ────────────────────────────────────────────────────

export type { PaperItem, ReadStatus } from '../engine/research/PaperItem';
export type LocaleKey = 'en' | 'zh';
export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentTheme = 'gold' | 'blue' | 'green' | 'gray';
/** Preset id or a custom #RRGGBB hex picked from the settings palette. */
export type AccentSetting = AccentTheme | `#${string}`;

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }
  return theme;
}

// ─── Custom accent (free-form palette) ───────────────────────

const CUSTOM_ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export function isCustomAccent(value: string): boolean {
  return CUSTOM_ACCENT_RE.test(value);
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
/** Blend a channel toward `target` by `amt` (0–1). */
const mixChannel = (c: number, target: number, amt: number) => clamp255(c + (target - c) * amt);

/**
 * Derive the full accent token set from a user-picked hex color and inline it
 * on <html> (inline style beats the [data-accent] preset selectors, so the
 * --primary aliases keep resolving through --accent automatically).
 * Dark mode lightens the picked color so it stays visible on dark surfaces;
 * light mode uses the exact picked color and darkens 12% for hover.
 */
export function applyCustomAccent(hex: string, resolvedTheme: 'light' | 'dark'): void {
  if (typeof document === 'undefined' || !isCustomAccent(hex)) return;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const dark = resolvedTheme === 'dark';
  const ar = dark ? mixChannel(r, 255, 0.35) : r;
  const ag = dark ? mixChannel(g, 255, 0.35) : g;
  const ab = dark ? mixChannel(b, 255, 0.35) : b;
  const hr = dark ? mixChannel(r, 255, 0.55) : mixChannel(r, 0, 0.12);
  const hg = dark ? mixChannel(g, 255, 0.55) : mixChannel(g, 0, 0.12);
  const hb = dark ? mixChannel(b, 255, 0.55) : mixChannel(b, 0, 0.12);
  const soft = dark ? `rgba(${r}, ${g}, ${b}, 0.16)` : `rgba(${r}, ${g}, ${b}, 0.10)`;
  const ringColor = dark ? `rgba(${ar}, ${ag}, ${ab}, 0.82)` : `rgba(${r}, ${g}, ${b}, 0.78)`;
  const ringShadow = `0 0 0 2px ${dark ? `rgba(${ar}, ${ag}, ${ab}, 0.35)` : `rgba(${r}, ${g}, ${b}, 0.28)`}`;
  const ring = `0 0 0 2px ${dark ? `rgba(${ar}, ${ag}, ${ab}, 0.5)` : `rgba(${r}, ${g}, ${b}, 0.4)`}`;
  // Pick readable text on the final accent from its relative luminance.
  const luminance = (0.2126 * ar + 0.7152 * ag + 0.0722 * ab) / 255;
  const style = document.documentElement.style;
  style.setProperty('--accent', `rgb(${ar}, ${ag}, ${ab})`);
  style.setProperty('--accent-hover', `rgb(${hr}, ${hg}, ${hb})`);
  style.setProperty('--accent-soft', soft);
  style.setProperty('--text-on-accent', luminance > 0.6 ? '#000000' : '#FFFFFF');
  style.setProperty('--focus-ring-color', ringColor);
  style.setProperty('--focus-ring-shadow', ringShadow);
  style.setProperty('--focus-ring', ring);
}

/** Restore preset-driven accent tokens by dropping the inline overrides. */
function clearCustomAccent(): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  for (const prop of ['--accent', '--accent-hover', '--accent-soft', '--text-on-accent', '--focus-ring-color', '--focus-ring-shadow', '--focus-ring']) {
    style.removeProperty(prop);
  }
}
export type TopLevelEntry = 'projects' | 'settings';
/**
 * Page —— 持久化导航/深链契约（任务4 Page Reachability 收敛后）。
 *
 * - ACTIVE：topics / outcomes / submissions（一级目的地）+ dashboard / goal /
 *   timeline / latex / experiments（GlobalSearch 与页内跳转可达）+ evals（诊断模式）。
 * - COMPAT 别名：chat / pdf / kanban（旧入口，经 LEGACY_PAGE_ALIASES 迁移到
 *   科研项目工作台对应模式页签）；autonomous 深链在别名表内迁移为 outcomes。
 * - 已删除的 dead id：graph / artifacts（从未有路由实现，点击会静默落空）。
 * 导航一律通过 src/shell/navigation.ts 的 typed NavigationIntent，不要再散落 event string。
 */
export type Page = TopLevelEntry | 'dashboard' | 'chat' | 'goal' | 'timeline' | 'latex' | 'pdf' | 'notes' | 'experiments' | 'evals' | 'kanban' | 'outcomes' | 'submissions' | 'topics';

export interface NoteItem {
  id: string;
  /** Global scratch note or project-scoped research memo. */
  scope?: 'global' | 'research';
  projectId?: string;
  title: string;
  content: string;
  tags: string[];
  linkedPaperIds: string[];
  linkedNoteIds: string[];
  starred?: boolean;
  updatedAt: number;
}

export interface ExperimentItem {
  id: string;
  name: string;
  description: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';
  parameters: Record<string, string>;
  metrics: Record<string, number>;
  tags: string[];
  notes: string;
  linkedPaperIds: string[];
  scriptAttachment?: ExperimentScriptAttachment;
  scriptRuntimeStatus?: ExperimentRuntimeStatus;
  scriptRuntimeIssue?: ExperimentScriptFailureCode;
  starred?: boolean;
  createdAt: number;
}

function presentExperimentMetadata(experiment: ExperimentItem): ExperimentMetadata {
  return {
    id: experiment.id,
    name: experiment.name,
    description: experiment.description,
    status: experiment.status,
    parameters: { ...experiment.parameters },
    metrics: { ...experiment.metrics },
    tags: [...experiment.tags],
    notes: experiment.notes,
    linkedPaperIds: [...experiment.linkedPaperIds],
    ...(typeof experiment.starred === 'boolean' ? { starred: experiment.starred } : {}),
    createdAt: experiment.createdAt,
  };
}

export type PersistedExperimentInput = Omit<
  ExperimentItem,
  'status' | 'scriptAttachment' | 'scriptRuntimeStatus' | 'scriptRuntimeIssue'
> & {
  status: string;
  scriptAttachment?: unknown;
  scriptRuntimeStatus?: unknown;
  scriptRuntimeIssue?: unknown;
};

function isExperimentStatus(value: string): value is ExperimentItem['status'] {
  return value === 'planned'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function hydrateExperiment(input: PersistedExperimentInput): ExperimentItem {
  const attachment = ExperimentScriptAttachmentSchema.safeParse(input.scriptAttachment);
  const runtimeStatus = ExperimentRuntimeStatusSchema.safeParse(input.scriptRuntimeStatus);
  const runtimeIssue = ExperimentScriptFailureCodeSchema.safeParse(input.scriptRuntimeIssue);
  const storedStatus = runtimeStatus.success ? runtimeStatus.data : undefined;
  let restoredRuntimeStatus: ExperimentRuntimeStatus;
  if (attachment.success) {
    restoredRuntimeStatus = storedStatus === undefined
      || storedStatus === 'attaching'
      || storedStatus === 'requesting_grant'
      || storedStatus === 'running'
      ? 'ready'
      : storedStatus;
  } else if (
    runtimeIssue.success
    && (storedStatus === 'failed'
      || storedStatus === 'rejected'
      || storedStatus === 'runtime_unavailable')
  ) {
    restoredRuntimeStatus = storedStatus;
  } else {
    restoredRuntimeStatus = 'not_attached';
  }
  const retainsRuntimeIssue = restoredRuntimeStatus === 'failed'
    || restoredRuntimeStatus === 'timed_out'
    || restoredRuntimeStatus === 'rejected'
    || restoredRuntimeStatus === 'runtime_unavailable';

  return {
    id: input.id,
    name: input.name,
    description: input.description,
    status: isExperimentStatus(input.status) ? input.status : 'planned',
    parameters: input.parameters,
    metrics: input.metrics,
    tags: input.tags,
    notes: input.notes,
    linkedPaperIds: input.linkedPaperIds,
    ...(attachment.success ? { scriptAttachment: attachment.data } : {}),
    scriptRuntimeStatus: restoredRuntimeStatus,
    ...(retainsRuntimeIssue && runtimeIssue.success
      ? { scriptRuntimeIssue: runtimeIssue.data }
      : {}),
    ...(typeof input.starred === 'boolean' ? { starred: input.starred } : {}),
    createdAt: input.createdAt,
  };
}

export interface WorkflowRunItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  progress: number;
  startedAt: number;
}

export interface CollectionItem {
  id: string;
  name: string;
  description: string;
  paperIds: string[];
  createdAt: number;
}

// ─── Persistence Helpers ──────────────────────────────────────

function getMetis(): MetisAPI | undefined {
  return typeof window !== 'undefined' ? window.metis : undefined;
}

function normalizeDoi(doi?: string): string {
  return (doi ?? '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '').replace(/^doi:\s*/, '').trim();
}

function normalizeArxivId(arxivId?: string): string {
  return (arxivId ?? '').toLowerCase().replace(/^arxiv:\s*/, '').replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function findDuplicatePaper(papers: PaperItem[], candidate: PaperItem): PaperItem | undefined {
  const candidateDoi = normalizeDoi(candidate.doi);
  const candidateArxiv = normalizeArxivId(candidate.arxivId);
  const candidateTitle = normalizeTitle(candidate.title);

  for (const paper of papers) {
    if (candidateDoi && normalizeDoi(paper.doi) === candidateDoi) return paper;
    if (candidateArxiv && normalizeArxivId(paper.arxivId) === candidateArxiv) return paper;
    if (candidateTitle && normalizeTitle(paper.title) === candidateTitle) return paper;
  }
  return undefined;
}

export function mergePaper(existing: PaperItem, incoming: PaperItem): PaperItem {
  const projectIds = [...new Set([
    ...(existing.projectIds ?? (existing.projectId ? [existing.projectId] : [])),
    ...(incoming.projectIds ?? (incoming.projectId ? [incoming.projectId] : [])),
  ])];
  return {
    ...existing,
    title: existing.title || incoming.title,
    authors: existing.authors.length > 0 ? existing.authors : incoming.authors,
    year: existing.year || incoming.year,
    venue: existing.venue || incoming.venue,
    abstract: existing.abstract || incoming.abstract,
    doi: existing.doi || incoming.doi,
    arxivId: existing.arxivId || incoming.arxivId,
    pdfCapability: existing.pdfCapability || incoming.pdfCapability,
    tags: [...new Set([...existing.tags, ...incoming.tags])],
    notes: existing.notes || incoming.notes,
    referenceIds: [...new Set([...existing.referenceIds, ...incoming.referenceIds])],
    projectId: projectIds[0],
    projectIds,
  };
}

// ─── Store ────────────────────────────────────────────────────

export interface MetisState {
  // Loading
  isHydrated: boolean;

  // Locale
  locale: LocaleKey;
  setLocale: (locale: LocaleKey) => void;

  // Theme
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;

  // Accent theme (preset id or custom #RRGGBB hex)
  accent: AccentSetting;
  setAccent: (accent: AccentSetting) => void;

  // Papers
  papers: PaperItem[];
  paperFilter: { query: string; semantic?: boolean; yearFrom?: number; yearTo?: number; readStatus?: ReadStatus; readWithinDays?: number; minRating?: number; minCitations?: number; venue?: string; collectionId?: string; starred?: boolean; tag?: string; archived?: boolean; priority?: 'high' | 'medium' | 'low'; deadlineStatus?: 'overdue' | 'today' | 'upcoming' };
  addPaper: (paper: PaperItem) => Promise<{ paper: PaperItem; merged: boolean }>;
  removePaper: (id: string) => Promise<void>;
  updatePaper: (id: string, updates: Partial<Omit<PaperItem, 'id'>>) => Promise<void>;
  togglePaperStar: (id: string) => Promise<void>;
  mergePapers: (keepId: string, dropId: string) => Promise<void>;
  addPaperReference: (sourceId: string, targetId: string) => Promise<void>;
  removePaperReference: (sourceId: string, targetId: string) => Promise<void>;
  archivePaper: (id: string) => Promise<void>;
  unarchivePaper: (id: string) => Promise<void>;
  setPaperFilter: (filter: Partial<MetisState['paperFilter']>) => void;

  // Saved filters
  savedFilters: Array<{ id: string; name: string; filter: MetisState['paperFilter'] }>;
  addSavedFilter: (name: string, filter: MetisState['paperFilter']) => void;
  removeSavedFilter: (id: string) => void;

  // Notes
  notes: NoteItem[];
  selectedNote: string | null;
  addNote: (note: NoteItem) => Promise<void>;
  updateNote: (id: string, updates: Partial<Omit<NoteItem, 'id' | 'updatedAt'>>) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  toggleNoteStar: (id: string) => Promise<void>;
  selectNote: (id: string | null) => void;

  // Experiments
  experiments: ExperimentItem[];
  addExperiment: (exp: ExperimentItem) => Promise<void>;
  removeExperiment: (id: string) => Promise<void>;
  updateExperiment: (id: string, updates: Partial<Omit<ExperimentItem, 'id' | 'createdAt'>>) => Promise<void>;
  setExperimentRuntimeState: (
    id: string,
    updates: Partial<Pick<
      ExperimentItem,
      | 'status'
      | 'metrics'
      | 'scriptAttachment'
      | 'scriptRuntimeStatus'
      | 'scriptRuntimeIssue'
    >>,
  ) => void;
  updateExperimentStatus: (id: string, status: ExperimentItem['status'], metrics?: Record<string, number>) => Promise<void>;
  toggleExperimentStar: (id: string) => Promise<void>;
  setExperiments: (experiments: ExperimentItem[]) => void;

  // Tags
  renameTag: (oldTag: string, newTag: string) => Promise<void>;
  mergeTags: (sourceTag: string, targetTag: string) => Promise<void>;
  deleteTag: (tag: string) => Promise<void>;

  // Collections
  collections: CollectionItem[];
  selectedCollection: string | null;
  addCollection: (collection: CollectionItem) => Promise<void>;
  updateCollection: (id: string, updates: Partial<Omit<CollectionItem, 'id' | 'createdAt'>>) => Promise<void>;
  removeCollection: (id: string) => Promise<void>;
  selectCollection: (id: string | null) => void;
  addPaperToCollection: (collectionId: string, paperId: string) => Promise<void>;
  removePaperFromCollection: (collectionId: string, paperId: string) => Promise<void>;

  // Workflow runs
  workflowRuns: WorkflowRunItem[];

  // Global search / navigation selections
  selectedPaperId: string | null;
  setSelectedPaperId: (id: string | null) => void;
  /** O8: page number to jump to when the PDF reader opens a paper (citation backlink). */
  pendingPaperPage: number | null;
  setPendingPaperPage: (page: number | null) => void;
  experimentSearchQuery: string;
  setExperimentSearchQuery: (query: string) => void;

  // Hydration
  hydrateFromPersistence: (data: {
    papers: Array<Omit<PaperItem, 'readStatus' | 'referenceIds'> & { readStatus: string; referenceIds?: string[] }>;
    notes: NoteItem[];
    experiments: PersistedExperimentInput[];
    collections?: CollectionItem[];
  }) => void;
}

// Monotonic counter for setTheme race prevention.
// Stale IPC failures must not roll back a newer successful write.
let themeOperationSeq = 0;
let accentOperationSeq = 0;

export const useMetisStore = create<MetisState>((set, get) => ({
  isHydrated: false,

  locale: 'zh',
  setLocale: (locale) => set({ locale }),

  theme: 'light',
  setTheme: (theme) => {
    const prevTheme = get().theme;
    // Monotonic operation generation: each call gets a unique id.
    // Stale failures MUST NOT rollback a newer successful write.
    const operationId = ++themeOperationSeq;
    // Optimistic update: Zustand + DOM + localStorage
    set({ theme });
    const resolved = resolveTheme(theme);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = resolved;
      try {
        localStorage.setItem('metis-theme', theme);
      } catch { /* ignore */ }
      // A custom accent must be re-derived for the new resolved mode.
      const accent = get().accent;
      if (isCustomAccent(accent)) applyCustomAccent(accent, resolved);
    }
    // Transactional IPC: rollback on failure ONLY if still the latest operation
    const metis = getMetis();
    if (metis?.setSettings) {
      void metis.setSettings({ theme }).then((result) => {
        if (!result?.success) {
          // IPC failure — rollback to previous theme.
          if (operationId !== themeOperationSeq) return;
          set({ theme: prevTheme });
          const prevResolved = resolveTheme(prevTheme);
          if (typeof document !== 'undefined') {
            document.documentElement.dataset.theme = prevResolved;
            try {
              localStorage.setItem('metis-theme', prevTheme);
            } catch {
              // setItem(prev) failed → remove stale override so next
              // hydrate uses the canonical value from the main process.
              try { localStorage.removeItem('metis-theme'); } catch { /* best-effort */ }
            }
          }
        } else {
          // IPC success — main already persisted the new theme.
          // Keep current state/DOM (optimistic update was correct).
          // Only re-sync localStorage.
          if (operationId !== themeOperationSeq) return;
          if (typeof document !== 'undefined') {
            try {
              localStorage.setItem('metis-theme', theme);
            } catch {
              // localStorage write failed → remove stale override so
              // next hydrate falls back to the main-persisted value.
              // Do NOT rollback state/DOM — main already committed.
              try { localStorage.removeItem('metis-theme'); } catch { /* best-effort */ }
            }
          }
        }
      }).catch(() => {
        // IPC threw — rollback to previous theme.
        if (operationId !== themeOperationSeq) return;
        set({ theme: prevTheme });
        const prevResolved = resolveTheme(prevTheme);
        if (typeof document !== 'undefined') {
          document.documentElement.dataset.theme = prevResolved;
          try {
            localStorage.setItem('metis-theme', prevTheme);
          } catch {
            try { localStorage.removeItem('metis-theme'); } catch { /* best-effort */ }
          }
        }
      });
    }
  },


  accent: 'blue',
  setAccent: (accent) => {
    const prevAccent = get().accent;
    // Monotonic operation generation, mirroring setTheme: stale IPC
    // failures must not roll back a newer successful write.
    const operationId = ++accentOperationSeq;
    // DOM application shared by optimistic update and rollback: presets go
    // through [data-accent] CSS selectors; custom hex colors are derived and
    // inlined (dataset.accent='custom' + inline tokens).
    const applyToDom = (value: AccentSetting) => {
      if (typeof document === 'undefined') return;
      const el = document.documentElement;
      if (isCustomAccent(value)) {
        el.dataset.accent = 'custom';
        applyCustomAccent(value, (el.dataset.theme as 'light' | 'dark') ?? 'light');
      } else {
        clearCustomAccent();
        el.dataset.accent = value;
      }
      try {
        localStorage.setItem('metis-accent', value);
      } catch { /* ignore */ }
    };
    // Optimistic update: Zustand + DOM + localStorage
    set({ accent });
    applyToDom(accent);
    // Transactional IPC: rollback on failure ONLY if still the latest operation
    const metis = getMetis();
    if (metis?.setSettings) {
      void metis.setSettings({ accent }).then((result) => {
        if (operationId !== accentOperationSeq) return;
        if (!result?.success) {
          // IPC failure — rollback to previous accent.
          set({ accent: prevAccent });
          applyToDom(prevAccent);
        } else {
          // IPC success — main already persisted; only re-sync localStorage.
          if (typeof document !== 'undefined') {
            try {
              localStorage.setItem('metis-accent', accent);
            } catch {
              try { localStorage.removeItem('metis-accent'); } catch { /* best-effort */ }
            }
          }
        }
      }).catch(() => {
        // IPC threw — rollback to previous accent.
        if (operationId !== accentOperationSeq) return;
        set({ accent: prevAccent });
        applyToDom(prevAccent);
      });
    }
  },


  papers: [],
  paperFilter: { query: '', archived: false },
  addPaper: async (paper) => {
    const existing = findDuplicatePaper(get().papers, paper);
    if (existing) {
      const merged: PaperItem = mergePaper(existing, paper);
      const metis = getMetis();
      if (metis) {
        await metis.savePaper(merged);
      }
      set((s) => ({ papers: s.papers.map((p) => (p.id === merged.id ? merged : p)) }));
      return { paper: merged, merged: true };
    }

    const metis = getMetis();
    if (metis) {
      await metis.savePaper(paper);
    }
    set((s) => ({ papers: [...s.papers, paper] }));
    return { paper, merged: false };
  },
  removePaper: async (id) => {
    const metis = getMetis();
    if (metis) {
      await metis.deletePaper(id);
    }
    set((s) => ({ papers: s.papers.filter((p) => p.id !== id) }));
  },
  updatePaper: async (id, updates) => {
    const metis = getMetis();
    const current = get().papers.find((p) => p.id === id);
    if (!current) return;
    const updated = { ...current, ...updates };
    if (metis) {
      await metis.savePaper(updated);
    }
    set((s) => ({
      papers: s.papers.map((p) => (p.id === id ? updated : p)),
    }));
  },
  togglePaperStar: async (id) => {
    const current = get().papers.find((p) => p.id === id);
    if (!current) return;
    await get().updatePaper(id, { starred: !current.starred });
  },
  /** 合并两条重复题录：保留 keepId，字段按 mergePaper 规则归并，丢弃另一条。 */
  mergePapers: async (keepId, dropId) => {
    if (keepId === dropId) return;
    const papers = get().papers;
    const keep = papers.find((p) => p.id === keepId);
    const drop = papers.find((p) => p.id === dropId);
    if (!keep || !drop) return;
    // 后加入的作为 incoming 参与 mergePaper（其补充字段填空）。
    const incoming = drop.addedAt >= keep.addedAt ? drop : keep;
    const existing = incoming.id === keep.id ? drop : keep;
    const merged = mergePaper(existing, incoming);
    const metis = getMetis();
    if (metis) {
      await metis.savePaper(merged);
      await metis.deletePaper(dropId);
    }
    set((s) => ({
      papers: s.papers
        .filter((p) => p.id !== dropId)
        .map((p) => (p.id === keepId ? merged : p)),
    }));
  },
  addPaperReference: async (sourceId, targetId) => {
    if (sourceId === targetId) return;
    const source = get().papers.find((p) => p.id === sourceId);
    const target = get().papers.find((p) => p.id === targetId);
    if (!source || !target) return;
    if (source.referenceIds.includes(targetId)) return;
    const updated = { ...source, referenceIds: [...source.referenceIds, targetId] };
    const metis = getMetis();
    if (metis) {
      await metis.savePaper(updated);
    }
    set((s) => ({ papers: s.papers.map((p) => (p.id === sourceId ? updated : p)) }));
  },
  removePaperReference: async (sourceId, targetId) => {
    const source = get().papers.find((p) => p.id === sourceId);
    if (!source) return;
    const updated = { ...source, referenceIds: source.referenceIds.filter((id) => id !== targetId) };
    const metis = getMetis();
    if (metis) {
      await metis.savePaper(updated);
    }
    set((s) => ({ papers: s.papers.map((p) => (p.id === sourceId ? updated : p)) }));
  },
  archivePaper: async (id) => {
    const current = get().papers.find((p) => p.id === id);
    if (!current || current.archived) return;
    await get().updatePaper(id, { archived: true });
  },
  unarchivePaper: async (id) => {
    const current = get().papers.find((p) => p.id === id);
    if (!current || !current.archived) return;
    await get().updatePaper(id, { archived: false });
  },
  setPaperFilter: (filter) => set((s) => ({ paperFilter: { ...s.paperFilter, ...filter } })),

  savedFilters: (() => {
    try {
      const raw = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
        ? localStorage.getItem('metis-saved-filters')
        : null;
      return raw ? (JSON.parse(raw) as Array<{ id: string; name: string; filter: MetisState['paperFilter'] }>) : [];
    } catch {
      return [];
    }
  })(),
  addSavedFilter: (name, filter) => {
    const item = {
      id: `filter_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      filter,
    };
    set((s) => {
      const next = [...s.savedFilters, item];
      try {
        if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
          localStorage.setItem('metis-saved-filters', JSON.stringify(next));
        }
      } catch { /* ignore */ }
      return { savedFilters: next };
    });
  },
  removeSavedFilter: (id) => {
    set((s) => {
      const next = s.savedFilters.filter((f) => f.id !== id);
      try {
        if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
          localStorage.setItem('metis-saved-filters', JSON.stringify(next));
        }
      } catch { /* ignore */ }
      return { savedFilters: next };
    });
  },

  notes: [],
  selectedNote: null,
  addNote: async (note) => {
    const metis = getMetis();
    if (metis) {
      await metis.saveNote(note);
    }
    set((s) => ({ notes: [...s.notes, note], selectedNote: note.id }));
  },
  updateNote: async (id, updates) => {
    const metis = getMetis();
    const current = get().notes.find((n) => n.id === id);
    if (!current) return;
    const updated = { ...current, ...updates, updatedAt: Date.now() };
    if (metis) {
      await metis.saveNote(updated);
    }
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? updated : n)),
    }));
  },
  toggleNoteStar: async (id) => {
    const current = get().notes.find((n) => n.id === id);
    if (!current) return;
    await get().updateNote(id, { starred: !current.starred });
  },
  removeNote: async (id) => {
    const metis = getMetis();
    if (metis) {
      await metis.deleteNote(id);
    }
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id), selectedNote: s.selectedNote === id ? null : s.selectedNote }));
  },
  selectNote: (id) => set({ selectedNote: id }),

  experiments: [],
  addExperiment: async (exp) => {
    const metis = getMetis();
    if (metis) {
      const result = await metis.saveExperiment(presentExperimentMetadata(exp));
      if (!result.success) return;
    }
    set((s) => ({ experiments: [...s.experiments, exp] }));
  },
  removeExperiment: async (id) => {
    const metis = getMetis();
    if (metis) {
      const result = await metis.deleteExperiment(id);
      if (!result.success) return;
    }
    set((s) => ({ experiments: s.experiments.filter((e) => e.id !== id) }));
  },
  updateExperiment: async (id, updates) => {
    const metis = getMetis();
    const current = get().experiments.find((e) => e.id === id);
    if (!current) return;
    const updated: ExperimentItem = { ...current, ...updates };
    if (metis) {
      const result = await metis.saveExperiment(presentExperimentMetadata(updated));
      if (!result.success) return;
    }
    set((s) => ({
      experiments: s.experiments.map((e) => (e.id === id ? updated : e)),
    }));
  },
  setExperimentRuntimeState: (id, updates) => {
    set((state) => ({
      experiments: state.experiments.map((experiment) => (
        experiment.id === id ? { ...experiment, ...updates } : experiment
      )),
    }));
  },
  updateExperimentStatus: async (id, status, metrics) => {
    const current = get().experiments.find((e) => e.id === id);
    const mergedMetrics = metrics && current ? { ...current.metrics, ...metrics } : metrics;
    await get().updateExperiment(id, { status, ...(mergedMetrics ? { metrics: mergedMetrics } : {}) });
  },
  toggleExperimentStar: async (id) => {
    const current = get().experiments.find((e) => e.id === id);
    if (!current) return;
    await get().updateExperiment(id, { starred: !current.starred });
  },
  setExperiments: (experiments) => set({ experiments }),

  renameTag: async (oldTag, newTag) => {
    const trimmed = newTag.trim();
    if (!trimmed || oldTag === trimmed) return;
    const { papers, notes, experiments, updatePaper, updateNote, updateExperiment } = get();
    for (const paper of papers) {
      if (!paper.tags.includes(oldTag)) continue;
      const tags = paper.tags.map((t) => (t === oldTag ? trimmed : t));
      await updatePaper(paper.id, { tags: [...new Set(tags)] });
    }
    for (const note of notes) {
      if (!note.tags.includes(oldTag)) continue;
      const tags = note.tags.map((t) => (t === oldTag ? trimmed : t));
      await updateNote(note.id, { tags: [...new Set(tags)] });
    }
    for (const exp of experiments) {
      if (!exp.tags.includes(oldTag)) continue;
      const tags = exp.tags.map((t) => (t === oldTag ? trimmed : t));
      await updateExperiment(exp.id, { tags: [...new Set(tags)] });
    }
  },
  mergeTags: async (sourceTag, targetTag) => {
    const trimmed = targetTag.trim();
    if (!trimmed || sourceTag === trimmed) return;
    const { papers, notes, experiments, updatePaper, updateNote, updateExperiment } = get();
    for (const paper of papers) {
      if (!paper.tags.includes(sourceTag)) continue;
      const tags = paper.tags.filter((t) => t !== sourceTag);
      if (!tags.includes(trimmed)) tags.push(trimmed);
      await updatePaper(paper.id, { tags: [...new Set(tags)] });
    }
    for (const note of notes) {
      if (!note.tags.includes(sourceTag)) continue;
      const tags = note.tags.filter((t) => t !== sourceTag);
      if (!tags.includes(trimmed)) tags.push(trimmed);
      await updateNote(note.id, { tags: [...new Set(tags)] });
    }
    for (const exp of experiments) {
      if (!exp.tags.includes(sourceTag)) continue;
      const tags = exp.tags.filter((t) => t !== sourceTag);
      if (!tags.includes(trimmed)) tags.push(trimmed);
      await updateExperiment(exp.id, { tags: [...new Set(tags)] });
    }
  },
  deleteTag: async (tag) => {
    if (!tag) return;
    const { papers, notes, experiments, updatePaper, updateNote, updateExperiment } = get();
    for (const paper of papers) {
      if (!paper.tags.includes(tag)) continue;
      await updatePaper(paper.id, { tags: paper.tags.filter((t) => t !== tag) });
    }
    for (const note of notes) {
      if (!note.tags.includes(tag)) continue;
      await updateNote(note.id, { tags: note.tags.filter((t) => t !== tag) });
    }
    for (const exp of experiments) {
      if (!exp.tags.includes(tag)) continue;
      await updateExperiment(exp.id, { tags: exp.tags.filter((t) => t !== tag) });
    }
  },

  collections: [],
  selectedCollection: null,
  addCollection: async (collection) => {
    const metis = getMetis();
    if (metis) {
      await metis.saveCollection(collection);
    }
    set((s) => ({ collections: [...s.collections, collection], selectedCollection: collection.id }));
  },
  updateCollection: async (id, updates) => {
    const metis = getMetis();
    const current = get().collections.find((c) => c.id === id);
    if (!current) return;
    const updated = { ...current, ...updates };
    if (metis) {
      await metis.saveCollection(updated);
    }
    set((s) => ({
      collections: s.collections.map((c) => (c.id === id ? updated : c)),
    }));
  },
  removeCollection: async (id) => {
    const metis = getMetis();
    if (metis) {
      await metis.deleteCollection(id);
    }
    set((s) => ({
      collections: s.collections.filter((c) => c.id !== id),
      selectedCollection: s.selectedCollection === id ? null : s.selectedCollection,
    }));
  },
  selectCollection: (id) => set({ selectedCollection: id }),
  addPaperToCollection: async (collectionId, paperId) => {
    const collection = get().collections.find((c) => c.id === collectionId);
    if (!collection || collection.paperIds.includes(paperId)) return;
    const updated = { ...collection, paperIds: [...collection.paperIds, paperId] };
    const metis = getMetis();
    if (metis) {
      await metis.saveCollection(updated);
    }
    set((s) => ({
      collections: s.collections.map((c) => (c.id === collectionId ? updated : c)),
    }));
  },
  removePaperFromCollection: async (collectionId, paperId) => {
    const collection = get().collections.find((c) => c.id === collectionId);
    if (!collection) return;
    const updated = { ...collection, paperIds: collection.paperIds.filter((pid) => pid !== paperId) };
    const metis = getMetis();
    if (metis) {
      await metis.saveCollection(updated);
    }
    set((s) => ({
      collections: s.collections.map((c) => (c.id === collectionId ? updated : c)),
    }));
  },

  workflowRuns: [],

  selectedPaperId: null,
  setSelectedPaperId: (id) => set({ selectedPaperId: id }),
  pendingPaperPage: null,
  setPendingPaperPage: (page) => set({ pendingPaperPage: page }),
  experimentSearchQuery: '',
  setExperimentSearchQuery: (query) => set({ experimentSearchQuery: query }),

  hydrateFromPersistence: (data) => {
    set({
      papers: data.papers.map((p) => ({ ...p, referenceIds: p.referenceIds ?? [] })) as PaperItem[],
      notes: data.notes,
      experiments: data.experiments.map(hydrateExperiment),
      collections: (data.collections ?? []) as CollectionItem[],
      isHydrated: true,
    });
  },
}));

// ─── Derived Selectors ────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function paperToTokens(paper: PaperItem): string[] {
  return tokenize([
    paper.title,
    paper.authors.join(' '),
    paper.abstract,
    paper.tags.join(' '),
    paper.notes,
    paper.pdfText ?? '',
  ].join(' '));
}

function computeTfIdf(documents: string[][], query: string[]): Map<number, number> {
  const scores = new Map<number, number>();
  const idf = new Map<string, number>();
  for (const term of query) {
    const docsWithTerm = documents.filter((doc) => doc.includes(term)).length;
    idf.set(term, Math.log((documents.length + 1) / (docsWithTerm + 1)) + 1);
  }
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]!;
    let score = 0;
    for (const term of query) {
      const tf = doc.filter((w) => w === term).length;
      score += tf * (idf.get(term) ?? 0);
    }
    if (score > 0) scores.set(i, score);
  }
  return scores;
}

function buildVocabulary(documents: string[][]): string[] {
  const vocab = new Set<string>();
  for (const doc of documents) {
    for (const term of doc) vocab.add(term);
  }
  return [...vocab];
}

function computeTfIdfVectors(documents: string[][]): number[][] {
  const vocab = buildVocabulary(documents);
  const idf = vocab.map((term) => {
    const docsWithTerm = documents.filter((doc) => doc.includes(term)).length;
    return Math.log((documents.length + 1) / (docsWithTerm + 1)) + 1;
  });
  return documents.map((doc) =>
    vocab.map((term, idx) => {
      const tf = doc.filter((w) => w === term).length;
      return tf * idf[idx]!;
    }),
  );
}

export function suggestTags(paper: PaperItem, allPapers: PaperItem[], limit = 5): string[] {
  const existingTags = [...new Set(allPapers.flatMap((p) => p.tags))];
  if (existingTags.length === 0) return [];
  const paperText = [
    paper.title, paper.authors.join(' '), paper.abstract,
    paper.tags.join(' '), paper.notes, paper.pdfText ?? '',
  ].join(' ').toLowerCase();
  const scored = existingTags
    .filter((tag) => !paper.tags.includes(tag))
    .map((tag) => {
      const normalized = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
      const token = tag.toLowerCase();
      let score = 0;
      if (paperText.includes(token)) score += 3;
      if (normalized.length >= 3 && paperText.includes(normalized)) score += 2;
      const tokenParts = token.split(/\s+/).filter((p) => p.length >= 3);
      for (const part of tokenParts) {
        if (paperText.includes(part)) score += 1;
      }
      return { tag, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.tag);
  return scored;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankPapersByRelevance(papers: PaperItem[], query: string): PaperItem[] {
  const terms = tokenize(query);
  if (terms.length === 0) return papers;
  const docs = papers.map(paperToTokens);
  const scores = computeTfIdf(docs, terms);
  return [...papers].sort((a, b) => {
    const scoreA = scores.get(papers.indexOf(a)) ?? 0;
    const scoreB = scores.get(papers.indexOf(b)) ?? 0;
    return scoreB - scoreA;
  });
}

/**
 * Semantic ranking via the shared RagEngine (TF-IDF with smoothed IDF and full
 * PDF text when available). Built on a per-query transient RagEngine instance
 * so it never needs the main-process singleton and works entirely in the
 * renderer. Papers without a hit are dropped, mirroring keyword-filter intent.
 */
export function rankPapersWithRag(papers: PaperItem[], query: string): PaperItem[] {
  const trimmed = query.trim();
  if (!trimmed) return papers;
  const engine = new RagEngine();
  engine.indexPapersWithFullText(papers);
  const hits = engine.search(trimmed, papers.length);
  const scoreById = new Map(hits.map((h) => [h.document.id, h.score]));
  return papers
    .filter((p) => scoreById.has(p.id))
    .sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0));
}

export interface SimilarPaperResult {
  paper: PaperItem;
  score: number;
}

export function findSimilarPapers(
  papers: PaperItem[],
  targetId: string,
  limit = 5,
): SimilarPaperResult[] {
  if (papers.length < 2) return [];
  const targetIndex = papers.findIndex((p) => p.id === targetId);
  if (targetIndex === -1) return [];
  const docs = papers.map(paperToTokens);
  const vectors = computeTfIdfVectors(docs);
  const targetVector = vectors[targetIndex]!;
  const results: SimilarPaperResult[] = [];
  for (let i = 0; i < papers.length; i++) {
    if (i === targetIndex) continue;
    const score = cosineSimilarity(targetVector, vectors[i]!);
    if (score > 0) results.push({ paper: papers[i]!, score });
  }
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }));
}

export function filterPapers(
  papers: PaperItem[],
  filter: MetisState['paperFilter'],
  collections?: CollectionItem[],
): PaperItem[] {
  const result = papers.filter((p) => {
    if (filter.yearFrom !== undefined && p.year < filter.yearFrom) return false;
    if (filter.yearTo !== undefined && p.year > filter.yearTo) return false;
    if (filter.readStatus && p.readStatus !== filter.readStatus) return false;
    if (filter.readWithinDays !== undefined && filter.readWithinDays > 0) {
      const cutoff = Date.now() - filter.readWithinDays * 24 * 60 * 60 * 1000;
      if (!p.readAt || p.readAt < cutoff) return false;
    }
    if (filter.minRating !== undefined && p.rating < filter.minRating) return false;
    if (filter.minCitations !== undefined && (p.citationCount ?? 0) < filter.minCitations) return false;
    if (filter.venue && !p.venue.toLowerCase().includes(filter.venue.toLowerCase())) return false;
    if (filter.starred !== undefined && !!p.starred !== filter.starred) return false;
    if (filter.tag && !p.tags.some((t) => t.toLowerCase() === filter.tag!.toLowerCase())) return false;
    if (filter.archived === false && p.archived) return false;
    if (filter.archived === true && !p.archived) return false;
    if (filter.priority && p.priority !== filter.priority) return false;
    if (filter.deadlineStatus) {
      const deadline = p.deadline ? new Date(p.deadline).setHours(0, 0, 0, 0) : null;
      const today = new Date().setHours(0, 0, 0, 0);
      if (filter.deadlineStatus === 'overdue' && (!deadline || deadline >= today)) return false;
      if (filter.deadlineStatus === 'today' && deadline !== today) return false;
      if (filter.deadlineStatus === 'upcoming' && (!deadline || deadline <= today)) return false;
    }
    return true;
  });
  if (filter.collectionId) {
    const collection = collections?.find((c) => c.id === filter.collectionId);
    if (collection) {
      return result.filter((p) => collection.paperIds.includes(p.id));
    }
  }
  if (filter.query) {
    if (filter.semantic) {
      return rankPapersWithRag(result, filter.query);
    }
    const q = filter.query.toLowerCase();
    return result.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      p.authors.some((a) => a.toLowerCase().includes(q)) ||
      p.abstract.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
  return result;
}
