/**
 * Artifact Store + Provenance Chain (METIS-602 / METIS-603).
 *
 * METIS-602: atomic write, versioning, thumbnail, soft-delete, restore. Never produces a
 * "DB has a record but the file is missing" half-result (crash-interrupt / same-name / big-file).
 * METIS-603: connects source -> evidence -> run -> artifact -> revision, so any artifact's
 * full lineage is queryable, and editing an input marks downstream artifacts STALE.
 */

import type { ArtifactManifest } from './ArtifactManifest.js';

// ─── Store interface ──────────────────────────────────────────

export interface StoredArtifact {
  manifest: ArtifactManifest;
  /** Raw content bytes/spec (the actual artifact payload). */
  content: string;
  thumbnailRef: string | null;
  deletedAt: number | null;
}

export interface ArtifactStore {
  /** Atomic: writes content + manifest together or not at all. */
  putAtomic(id: string, manifest: ArtifactManifest, content: string): void;
  get(id: string): StoredArtifact | undefined;
  listByProject(projectId: string): StoredArtifact[];
  /** Save a new VERSION (does not overwrite the old; returns the new version number). */
  saveVersion(id: string, manifest: ArtifactManifest, content: string): number;
  listVersions(id: string): number[];
  setThumbnail(id: string, ref: string): void;
  softDelete(id: string, at: number): void;
  restore(id: string): void;
}

// ─── In-memory reference implementation (also used by PersistenceStore backing) ──

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly byId = new Map<string, { current: StoredArtifact; versions: Map<number, { manifest: ArtifactManifest; content: string }> }>();

  putAtomic(id: string, manifest: ArtifactManifest, content: string): void {
    const versions = new Map([[manifest.version, { manifest, content }]]);
    this.byId.set(id, { current: { manifest, content, thumbnailRef: null, deletedAt: null }, versions });
  }

  get(id: string): StoredArtifact | undefined {
    const rec = this.byId.get(id);
    return rec ? { ...rec.current, manifest: { ...rec.current.manifest } } : undefined;
  }

  listByProject(projectId: string): StoredArtifact[] {
    return [...this.byId.values()].filter((r) => r.current.manifest.projectId === projectId && !r.current.deletedAt).map((r) => ({ ...r.current, manifest: { ...r.current.manifest } }));
  }

  saveVersion(id: string, manifest: ArtifactManifest, content: string): number {
    const rec = this.byId.get(id);
    if (!rec) throw new Error(`artifact ${id} not found`);
    const newVersion = Math.max(...rec.versions.keys()) + 1;
    const versioned = { manifest: { ...manifest, version: newVersion }, content };
    rec.versions.set(newVersion, versioned);
    rec.current = { manifest: versioned.manifest, content, thumbnailRef: rec.current.thumbnailRef, deletedAt: null };
    return newVersion;
  }

  listVersions(id: string): number[] {
    const rec = this.byId.get(id);
    return rec ? [...rec.versions.keys()].sort((a, b) => a - b) : [];
  }

  setThumbnail(id: string, ref: string): void {
    const rec = this.byId.get(id);
    if (rec) rec.current.thumbnailRef = ref;
  }

  softDelete(id: string, at: number): void {
    const rec = this.byId.get(id);
    if (rec) rec.current.deletedAt = at;
  }

  restore(id: string): void {
    const rec = this.byId.get(id);
    if (rec) rec.current.deletedAt = null;
  }
}

// ─── Provenance chain (METIS-603) ─────────────────────────────

export interface ProvenanceNode {
  kind: 'source' | 'evidence' | 'run' | 'artifact' | 'revision';
  id: string;
  parentId: string | null;
  /** Content hash for staleness propagation. */
  hash: string;
}

export interface ProvenanceChain {
  /** All nodes, indexed by id. */
  nodes: Map<string, ProvenanceNode>;
  /** Child links: parentId -> child ids. */
  children: Map<string, string[]>;
  /** Record a node + its parent link. */
  link(node: ProvenanceNode): void;
  /** Full lineage from an artifact back to its root sources. */
  lineage(artifactId: string): ProvenanceNode[];
  /** When an input's hash changes, return all downstream artifact ids now STALE. */
  downstreamStale(changedNodeId: string): string[];
}

export function createProvenanceChain(): ProvenanceChain {
  const nodes = new Map<string, ProvenanceNode>();
  const children = new Map<string, string[]>();
  return {
    nodes,
    children,
    link(node) {
      nodes.set(node.id, node);
      if (node.parentId) {
        const arr = children.get(node.parentId) ?? [];
        arr.push(node.id);
        children.set(node.parentId, arr);
      }
    },
    lineage(artifactId) {
      const out: ProvenanceNode[] = [];
      let cur = nodes.get(artifactId);
      while (cur) {
        out.push(cur);
        cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
      }
      return out.reverse(); // root-first
    },
    downstreamStale(changedNodeId) {
      // BFS descendants; collect artifact/revision nodes.
      const stale: string[] = [];
      const queue = [changedNodeId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const childId of children.get(cur) ?? []) {
          const child = nodes.get(childId);
          if (child && (child.kind === 'artifact' || child.kind === 'revision')) stale.push(childId);
          queue.push(childId);
        }
      }
      return stale;
    },
  };
}
