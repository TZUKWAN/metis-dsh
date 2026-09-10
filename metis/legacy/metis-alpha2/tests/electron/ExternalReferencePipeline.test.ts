/**
 * ExternalModelReference 契约 + ExternalReferenceService 存储（2026-09-05 刘总规格书）。
 * 【零越界护栏】外部模型内容永不是证据：契约层强制「非证据」语义标记；
 * 存储层与 papers/sources 证据链物理隔离（独立表）。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ExternalReferenceService } from '../../electron/ExternalReferenceService.js';
import { buildTopicContextPackage } from '../../src/topic/contextPackage.js';
import {
  buildContextPackage,
  externalReferenceDigest,
  normalizeExternalModelReference,
} from '../../engine/runtime/ExternalReferenceContract.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';

const VALID = {
  v: 1,
  model: 'ChatGPT',
  url: 'https://chatgpt.com/c/abc',
  quotedText: '建议把研究问题收窄到知识劳动者的时间分配。',
  capturedAt: 1_786_000_000_000,
  projectId: 'project-1',
  sessionId: 'topic-1',
};

describe('ExternalModelReference 契约', () => {
  it('accepts a valid reference and derives a stable digest + id', () => {
    const result = normalizeExternalModelReference(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reference.id).toMatch(/^extref-/);
    expect(result.reference.contextDigest).toBe(externalReferenceDigest(VALID.quotedText));
    expect(result.reference.contextDigest).toHaveLength(16);
    // 确定性：同文本同摘要。
    expect(normalizeExternalModelReference(VALID).ok
      && normalizeExternalModelReference(VALID)).toBeTruthy();
  });

  it('rejects empty quotes, bad urls, and missing models with field-level issues', () => {
    const missingQuote = normalizeExternalModelReference({ ...VALID, quotedText: '   ' });
    expect(missingQuote.ok).toBe(false);
    if (!missingQuote.ok) expect(missingQuote.issues.join(';')).toContain('quotedText');

    const badUrl = normalizeExternalModelReference({ ...VALID, url: 'javascript:alert(1)' });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.issues.join(';')).toContain('url');

    const noModel = normalizeExternalModelReference({ ...VALID, model: '' });
    expect(noModel.ok).toBe(false);
    if (!noModel.ok) expect(noModel.issues.join(';')).toContain('model');
  });
});

describe('Context Package（METIS → Chatbot）', () => {
  it('is deterministic, lists candidates, and marks external quotes as non-evidence', () => {
    const input = {
      topicQuestion: '生成式 AI 对知识劳动者的影响',
      sessionStatus: '候选比较中',
      candidates: [
        { title: '候选 A：时间分配视角', status: '已收藏' },
        { title: '候选 B：技能替代视角', status: '候选' },
      ],
      recentTurns: [{ role: 'user', content: '帮我校验候选 A 的可行性' }],
      externalReferences: [{ model: 'DeepSeek', quotedText: '建议补充访谈提纲' }],
    };
    const first = buildContextPackage(input);
    const second = buildContextPackage(input);
    expect(first).toBe(second);
    expect(first).toContain('METIS 研究上下文包');
    expect(first).toContain('候选 A：时间分配视角');
    expect(first).toContain('外部参考·非证据');
    expect(first).toContain('[DeepSeek]');
    expect(first).toContain('仅供你参考');
  });

  it('truncates at maxChars and returns null without a session', () => {
    // engine 版通过 input.maxChars 裁剪。
    const text = buildContextPackage({
      topicQuestion: 'X'.repeat(200),
      sessionStatus: null,
      candidates: [],
      recentTurns: [],
      maxChars: 120,
    });
    expect(text).toContain('已截断');
    expect(text.length).toBeLessThanOrEqual(140);
    // 渲染层包装器：无会话上下文时如实返回 null（宿主据此禁用发送）。
    expect(buildTopicContextPackage({
      hasSession: false,
      sessionTitle: null,
      sessionStatus: null,
      candidates: [],
      messages: [],
      externalReferences: [],
    })).toBeNull();
  });
});

describe('ExternalReferenceService 存储与零越界', () => {
  it('adds, dedupes by digest+project, lists and removes', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const service = new ExternalReferenceService(db);

    const first = service.add(VALID);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.duplicate).toBe(false);

    // 同文本同项目 → 幂等去重。
    const second = service.add({ ...VALID, capturedAt: 1_786_000_999_999 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.reference.id).toBe(first.reference.id);

    // 同文本不同项目 → 独立条目。
    const other = service.add({ ...VALID, projectId: 'project-2' });
    expect(other.ok && other.duplicate === false).toBe(true);

    const rows = service.listForProject('project-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('ChatGPT');
    expect(service.remove(rows[0]!.id)).toBe(true);
    expect(service.listForProject('project-1')).toHaveLength(0);
  });

  it('keeps external references physically isolated from the evidence chain', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const service = new ExternalReferenceService(db);
    service.add(VALID);

    // 证据链表（papers/sources）零行；外部参考在独立表。
    const papers = db.prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number };
    const sources = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    expect(papers.n).toBe(0);
    expect(sources.n).toBe(0);
    const refs = db.prepare('SELECT COUNT(*) AS n FROM external_references').get() as { n: number };
    expect(refs.n).toBe(1);
  });
});
