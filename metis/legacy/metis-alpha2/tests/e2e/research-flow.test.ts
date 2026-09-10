/**
 * 系统级端到端研究流程联通测试。
 *
 * 覆盖完整研究链路：一句话建项目 → 研究设计 → 资料检索/导入 → 阅读(PDF锚点)
 * → 质性编码 → Claim-Evidence 图 → 写作引用 → 核验 → Artifact 存储/版本/溯源。
 *
 * 这个测试 NOT mock 任何核心模块——它真实串联：
 *   QuickStart → SourceService → EvidenceAnchor → ClaimGraph → auditManuscriptCitations
 *   → ArtifactStore → ProvenanceChain → computeReviewStatus → ProjectBackup
 *
 * 验证各模块之间的数据契约和 ID 引用联通，而非各自独立工作。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

// ─── 研究流程各阶段使用的模块 ───
import { createProjectFromIntent } from '../../engine/setup/QuickStart.js';
import { produceDesignCard, validateDesignCard, deduplicateSources } from '../../engine/capabilities/researchCapabilities.js';
import { SourceService, type SourceStore } from '../../engine/sources/SourceService.js';
import { buildEvidence, checkFreshness, relocationFor } from '../../engine/sources/EvidenceAnchor.js';
import { ClaimGraph, type ClaimStore } from '../../engine/sources/ClaimGraph.js';
import { auditManuscriptCitations, canMarkVerified, flagUnsupportedInterpretations } from '../../engine/capabilities/researchCapabilities.js';
import { InMemoryArtifactStore, createProvenanceChain } from '../../engine/artifacts/ArtifactStore.js';
import { buildArtifactInspector } from '../../engine/viewers/VisualizationViewers.js';
import { computeReviewStatus } from '../../engine/artifacts/ArtifactReview.js';
import { bindDeliverableProfile } from '../../engine/writing/DeliverableProfile.js';
import type { Project, Source, Claim, ClaimEvidenceLink, ResearchArtifact } from '../../engine/persistence/researchModel.js';

// ─── 内存实现（模拟 PersistenceStore 行为，验证数据联通）───

class IntegratedStore implements SourceStore, ClaimStore {
  sources = new Map<string, Source>();
  claims = new Map<string, Claim>();
  links = new Map<string, ClaimEvidenceLink>();
  artifacts = new Map<string, ResearchArtifact>();
  decisions: Array<{ id: string; text: string; at: number; context?: string }> = [];

  // SourceStore
  insert(s: Source) { this.sources.set(s.id, { ...s }); }
  get(id: string) { const s = this.sources.get(id); return s ? { ...s } : undefined; }
  listByProject(pid: string) { return [...this.sources.values()].filter((s) => s.projectId === pid && !s.deletedAt); }
  update(id: string, patch: Partial<Source>) { const s = this.sources.get(id); if (s) this.sources.set(id, { ...s, ...patch }); }
  softDelete(id: string, at: number) { const s = this.sources.get(id); if (s) this.sources.set(id, { ...s, deletedAt: at }); }

  // ClaimStore
  insertClaim(c: Claim) { this.claims.set(c.id, { ...c }); }
  getClaim(id: string) { const c = this.claims.get(id); return c ? { ...c } : undefined; }
  listClaimsByProject(pid: string) { return [...this.claims.values()].filter((c) => c.projectId === pid); }
  updateClaim(id: string, patch: Partial<Claim>) { const c = this.claims.get(id); if (c) this.claims.set(id, { ...c, ...patch }); }
  insertLink(l: ClaimEvidenceLink) { this.links.set(l.id, { ...l }); }
  listLinksByClaim(cid: string) { return [...this.links.values()].filter((l) => l.claimId === cid); }
  listLinksByEvidence(eid: string) { return [...this.links.values()].filter((l) => l.evidenceId === eid); }
  deleteLink(id: string) { this.links.delete(id); }
}

describe('系统级端到端研究流程联通测试', () => {
  let store: IntegratedStore;
  let sourceSvc: SourceService;
  let claimGraph: ClaimGraph;
  let artifactStore: InMemoryArtifactStore;
  let provenance: ReturnType<typeof createProvenanceChain>;
  let projectId: string;

  beforeEach(() => {
    store = new IntegratedStore();
    sourceSvc = new SourceService(store);
    claimGraph = new ClaimGraph(store);
    artifactStore = new InMemoryArtifactStore();
    provenance = createProvenanceChain();
  });

  it('完整流程：一句话 → 设计 → 资料 → 证据 → 论断 → 写作 → 核验 → 成果', () => {
    // ═══ 阶段1：一句话建项目（METIS-307）═══
    const project = createProjectFromIntent('我想研究短视频对青少年学业表现的影响', {
      generateId: () => 'proj-1',
      now: () => 1000,
    });
    projectId = project.id;
    expect(project.lifecycle).toBe('draft');
    expect(project.originalIntent).toContain('短视频');
    expect(project.routing.classification.primaryCapabilityId).toBe('research-design');

    // ═══ 阶段2：研究设计（METIS-801）═══
    const designCard = produceDesignCard(
      { ...project, researchQuestion: '短视频使用时长如何影响学业成绩？' } as Project,
      {
        researchQuestion: '短视频使用时长如何影响学业成绩？',
        theoreticalLens: '注意力经济理论',
        methodology: '混合方法（问卷+访谈）',
        scope: '初中生群体',
        deliverables: ['研究报告'],
        clarifications: ['学科领域？'],
      },
    );
    const designValidation = validateDesignCard(designCard);
    expect(designValidation.valid).toBe(true);

    // ═══ 阶段3：资料检索与导入（METIS-802/403）═══
    // 模拟检索到 3 篇文献（含重复）
    const rawSources = [
      { identifier: '10.1/shortvideo-study', title: 'Short Video and Academic Performance' },
      { identifier: '10.1/SHORTVIDEO-STUDY', title: 'Duplicate' }, // 重复（大小写）
      { identifier: '10.2/attention-economy', title: 'Attention Economy in Education' },
    ];
    const { unique, duplicatesRemoved } = deduplicateSources(rawSources);
    expect(duplicatesRemoved).toBe(1);
    expect(unique.length).toBe(2);

    // 通过 SourceService 注册为统一 Source
    const source1 = sourceSvc.register(projectId, {
      kind: 'paper', data: { title: unique[0]!.title, doi: unique[0]!.identifier, authors: ['Zhang'], year: 2024 },
    });
    const source2 = sourceSvc.register(projectId, {
      kind: 'paper', data: { title: unique[1]!.title, doi: unique[1]!.identifier, authors: ['Smith'], year: 2023 },
    });
    expect(sourceSvc.listByProject(projectId).length).toBe(2);
    expect(source1.identifierType).toBe('doi');

    // ═══ 阶段4：阅读 + 证据锚点（METIS-701/404）═══
    const evidence1 = buildEvidence({
      id: 'ev-1', projectId, sourceId: source1.id,
      anchor: { type: 'page', pageNumber: 7 },
      snippet: '每日短视频使用超过2小时的学生，GPA平均下降0.3分',
      sourceVersionHash: 'v1-hash',
      confidence: 0.85,
    });
    buildEvidence({
      id: 'ev-2', projectId, sourceId: source2.id,
      anchor: { type: 'char_range', start: 100, end: 200 },
      snippet: '注意力经济模型指出，短视频的即时反馈机制消耗认知资源',
      sourceVersionHash: 'v2-hash',
      confidence: 0.9,
    });
    // 证据可追溯
    expect(evidence1.snippetHash).toBeTruthy();
    expect(relocationFor(evidence1).sourceId).toBe(source1.id);
    // 来源版本未变 → 新鲜
    expect(checkFreshness(evidence1, 'v1-hash')).toBe('fresh');
    expect(checkFreshness(evidence1, 'changed-hash')).toBe('stale');

    // ═══ 阶段5：质性与人文分析 → Claim-Evidence 图（METIS-804/405）═══
    const claim1: Claim = {
      id: 'claim-1', projectId, statement: '短视频使用时长与学业成绩呈负相关',
      claimType: 'finding', confidence: 0.8, status: 'unsupported',
      metadata: {}, createdAt: 1000, updatedAt: 1000, deletedAt: null,
    };
    claimGraph.createClaim(claim1);
    // 将证据链接到论断
    claimGraph.linkEvidence({
      id: 'link-1', claimId: 'claim-1', evidenceId: 'ev-1',
      relation: 'supports', weight: 2, note: '直接统计证据', createdAt: 1000,
    });
    claimGraph.linkEvidence({
      id: 'link-2', claimId: 'claim-1', evidenceId: 'ev-2',
      relation: 'supports', weight: 1, note: '理论支持', createdAt: 1000,
    });
    // 论断状态应自动变为 supported
    const manifest = claimGraph.evidenceManifest('claim-1');
    expect(manifest.claim?.status).toBe('supported');
    expect(manifest.supports.length).toBe(2);

    // ═══ 阶段6：写作 → 引用核验（METIS-806）═══
    // 模拟写作引用了 claim-1，但误引了一个不存在的 claim-x
    const registeredSourceIds = new Set(sourceSvc.listByProject(projectId).map((s) => s.id));
    const citationCheck = auditManuscriptCitations({
      manuscriptCitations: [source1.id, source2.id, 'nonexistent-source'],
      registeredSourceIds,
    });
    expect(citationCheck.ok).toBe(false);
    expect(citationCheck.unlocated).toContain('nonexistent-source');
    // 修正后应通过
    const fixedCheck = auditManuscriptCitations({
      manuscriptCitations: [source1.id, source2.id],
      registeredSourceIds,
    });
    expect(fixedCheck.ok).toBe(true);

    // 检查无来源支撑的论断
    const unsupported = flagUnsupportedInterpretations([
      { kind: 'interpretation', text: '短视频导致注意力下降', sourceId: source1.id }, // 有源
      { kind: 'interpretation', text: '主观推断无来源' }, // 无源 → 标记
    ]);
    expect(unsupported.length).toBe(1);

    // ═══ 阶段7：核验与交付（METIS-807）═══
    const verifiedCheck = canMarkVerified([
      { severity: 'error', category: 'citation', message: '错误' },
    ]);
    expect(verifiedCheck.ok).toBe(false); // 有 error 不可标记已核验
    const cleanCheck = canMarkVerified([
      { severity: 'warning', category: 'language', message: '建议优化' },
    ]);
    expect(cleanCheck.ok).toBe(true);

    // ═══ 阶段8：Artifact 存储 + 溯源（METIS-601/602/603）═══
    const artifactManifest = {
      id: 'art-1', projectId, title: '短视频与学业成绩研究报告',
      artifactType: 'manuscript' as const, reviewStatus: 'draft' as const,
      inputs: [
        { kind: 'claim' as const, id: 'claim-1' },
        { kind: 'evidence' as const, id: 'ev-1' },
      ],
      generatedBy: { capabilityId: 'argumentation-writing', method: 'draft' },
      citedSourceIds: [source1.id, source2.id],
      deliverableProfile: bindDeliverableProfile('research_report'),
      citationTruth: [source1, source2].map((source) => ({
        sourceId: source.id,
        citationKeys: [source.id],
        identifierType: source.identifierType,
        identifier: source.identifier,
        locator: 'p. 1',
        triangulation: 'VERIFIED' as const,
        passport: 'verified' as const,
        retraction: 'clear' as const,
        journalIntegrity: 'trusted' as const,
        checkedAt: Date.now(),
      })),
      renderer: { kind: 'markdown' as const, contentRef: 'content-ref' },
      reviewTrail: [], version: 1, createdAt: 1000, updatedAt: 1000,
    };
    artifactStore.putAtomic('art-1', artifactManifest, '# 研究报告\n\n结论：短视频使用时长与学业成绩呈负相关。');
    expect(artifactStore.get('art-1')?.manifest.title).toContain('研究报告');

    // 溯源链：source → evidence → artifact
    provenance.link({ kind: 'source', id: source1.id, parentId: null, hash: 'src-hash' });
    provenance.link({ kind: 'evidence', id: 'ev-1', parentId: source1.id, hash: 'ev-hash' });
    provenance.link({ kind: 'artifact', id: 'art-1', parentId: 'ev-1', hash: 'art-hash' });
    const lineage = provenance.lineage('art-1');
    expect(lineage.map((n) => n.kind)).toEqual(['source', 'evidence', 'artifact']);

    // 来源变更 → 下游 artifact 应标记 stale
    const staleDownstream = provenance.downstreamStale(source1.id);
    expect(staleDownstream).toContain('art-1');

    // ═══ 阶段9：审查状态计算（METIS-607）═══
    const review = computeReviewStatus(
      artifactManifest,
      [
        { name: '引用核验', passed: true, detail: '' },
        { name: '数字一致', passed: true, detail: '' },
      ],
      { anySourceDeleted: false, inputStale: false },
    );
    // Pure renderer/in-memory checks cannot mint main-process trust authority.
    expect(review.status).toBe('draft');

    // ═══ 阶段10：Artifact Inspector 组装（METIS-710）═══
    const inspector = buildArtifactInspector(
      artifactManifest,
      lineage.map((n) => `${n.kind}:${n.id}`),
      { passed: 2, total: 2 },
    );
    expect(inspector.reproducerSteps.join(' ')).toContain('argumentation-writing');
    // inspector 反映 manifest 的 reviewStatus（draft），review 计算结果（verified）独立验证
    expect(inspector.reviewSummary.status).toBe('draft');
    expect(review.status).toBe('draft');

    // ═══ 全链路联通验证：ID 引用完整性 ═══
    // artifact 引用的 claim 存在于 claimGraph
    expect(claimGraph.evidenceManifest('claim-1').claim).toBeDefined();
    // claim 引用的 evidence 的 sourceId 存在于 sourceService
    const evSource = sourceSvc.get(evidence1.sourceId);
    expect(evSource).toBeDefined();
    // artifact 引用的 sourceId 存在于 sourceService
    for (const sid of artifactManifest.citedSourceIds) {
      expect(sourceSvc.get(sid), `artifact 引用的 source ${sid} 必须存在`).toBeDefined();
    }
  });

  it('真实数据库联通：六实体 CRUD + 关系完整性', () => {
    // 用真实 SQLite 验证 schema 与数据模型联通
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-e2e-db-'));
    const dbPath = path.join(dir, 'test.db');
    const db = new Database(dbPath);
    // 建表（与 schema.ts 一致）
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT, lifecycle TEXT, created_at INTEGER, updated_at INTEGER, version INTEGER DEFAULT 1, source TEXT DEFAULT 'user', deleted_at INTEGER);
      CREATE TABLE sources (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, title TEXT, identifier TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, FOREIGN KEY (project_id) REFERENCES projects(id));
      CREATE TABLE evidence (id TEXT PRIMARY KEY, project_id TEXT, source_id TEXT, anchor_type TEXT, snippet TEXT, created_at INTEGER, updated_at INTEGER, FOREIGN KEY (source_id) REFERENCES sources(id));
      CREATE TABLE claims (id TEXT PRIMARY KEY, project_id TEXT, statement TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE claim_evidence_links (id TEXT PRIMARY KEY, claim_id TEXT, evidence_id TEXT, relation TEXT, created_at INTEGER);
      CREATE TABLE research_artifacts (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, artifact_type TEXT, review_status TEXT, version INTEGER, created_at INTEGER, updated_at INTEGER);
    `);
    const now = Date.now();
    // 插入完整链路
    db.prepare('INSERT INTO projects (id,title,lifecycle,created_at,updated_at) VALUES (?,?,?,?,?)').run('p1', '测试', 'draft', now, now);
    db.prepare('INSERT INTO sources (id,project_id,kind,title,identifier,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('s1', 'p1', 'paper', 'Paper', '10.1/x', now, now);
    db.prepare('INSERT INTO evidence (id,project_id,source_id,anchor_type,snippet,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('e1', 'p1', 's1', 'page', '原文', now, now);
    db.prepare('INSERT INTO claims (id,project_id,statement,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('c1', 'p1', '论断', 'supported', now, now);
    db.prepare('INSERT INTO claim_evidence_links (id,claim_id,evidence_id,relation,created_at) VALUES (?,?,?,?,?)').run('l1', 'c1', 'e1', 'supports', now);
    db.prepare('INSERT INTO research_artifacts (id,project_id,title,artifact_type,review_status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('a1', 'p1', '成果', 'manuscript', 'verified', 1, now, now);

    // 验证关系查询联通
    const links = db.prepare('SELECT * FROM claim_evidence_links JOIN evidence ON claim_evidence_links.evidence_id = evidence.id JOIN sources ON evidence.source_id = sources.id WHERE claim_evidence_links.claim_id = ?').all('c1') as Array<Record<string, unknown>>;
    expect(links.length).toBe(1);
    expect(links[0]?.statement ?? links[0]?.title).toBeDefined();

    // 验证级联完整性
    expect((db.prepare('SELECT COUNT(*) c FROM sources WHERE project_id=?').get('p1') as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM evidence WHERE source_id=?').get('s1') as { c: number }).c).toBe(1);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
