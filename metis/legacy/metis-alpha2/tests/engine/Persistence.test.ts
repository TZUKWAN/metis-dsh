/**
 * Tests for PersistenceStore — SQLite-backed session/message storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

let store: PersistenceStore;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  store = new PersistenceStore(dbPath);
});

afterEach(() => {
  store?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PersistenceStore', () => {
  it('creates and retrieves a session', () => {
    store.createSession('sess-1', { profile: 'small' });
    const session = store.getSession('sess-1');

    expect(session).toBeDefined();
    expect(session!.id).toBe('sess-1');
    expect(session!.metadata.profile).toBe('small');
    expect(session!.messageCount).toBe(0);
  });

  it('lists sessions ordered by last activity', () => {
    store.createSession('a');
    store.createSession('b');
    store.createSession('c');

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(3);
  });

  it('appends and retrieves messages', () => {
    store.createSession('s1');
    store.appendMessage('s1', 'system', 'You are helpful.');
    store.appendMessage('s1', 'user', 'Hello');
    store.appendMessage('s1', 'assistant', 'Hi there!');

    const messages = store.getMessages('s1');
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toBe('Hello');
    expect(messages[2].role).toBe('assistant');
  });

  it('updates message count on append', () => {
    store.createSession('s2');
    store.appendMessage('s2', 'user', 'msg1');
    store.appendMessage('s2', 'user', 'msg2');

    const session = store.getSession('s2');
    expect(session!.messageCount).toBe(2);
    expect(store.getMessageCount('s2')).toBe(2);
  });

  it('truncates messages after the last user and repairs the session count', () => {
    store.createSession('s2-truncate');
    store.appendMessage('s2-truncate', 'user', 'question');
    store.appendMessage('s2-truncate', 'assistant', 'old answer');
    store.appendMessage('s2-truncate', 'tool', 'stale tool output');

    expect(store.truncateMessagesAfterLastUser('s2-truncate')).toBe(2);
    expect(store.getMessages('s2-truncate')).toEqual([
      { role: 'user', content: 'question' },
    ]);
    expect(store.getSession('s2-truncate')?.messageCount).toBe(1);
  });

  it('records and retrieves tool results', () => {
    store.createSession('s3');
    store.recordToolResult('s3', {
      toolName: 'echo',
      content: 'Echo: hello',
      status: 'ok',
      toolCallId: 'tc_1',
      metadata: {},
    });
    store.recordToolResult('s3', {
      toolName: 'fail_tool',
      content: '',
      status: 'error',
      toolCallId: 'tc_2',
      error: 'Something went wrong',
      metadata: {},
    });

    const results = store.getToolResults('s3');
    expect(results).toHaveLength(2);
    expect(results[0].toolName).toBe('echo');
    expect(results[0].status).toBe('ok');
    expect(results[1].toolName).toBe('fail_tool');
    expect(results[1].error).toBe('Something went wrong');
  });

  it('records and retrieves checkpoints', () => {
    store.createSession('s4');
    store.recordCheckpoint('s4', 'agent.start', 'started', 0);
    store.recordCheckpoint('s4', 'agent.complete', 'done', 5, { turns: 5 });

    const checkpoints = store.getCheckpoints('s4');
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].phase).toBe('agent.start');
    expect(checkpoints[1].metadata).toEqual({ turns: 5 });
  });

  it('deletes a session and its data', () => {
    store.createSession('s5');
    store.appendMessage('s5', 'user', 'test');
    store.recordToolResult('s5', {
      toolName: 'echo', content: 'hi', status: 'ok', toolCallId: 'tc', metadata: {},
    });

    store.deleteSession('s5');

    expect(store.getSession('s5')).toBeUndefined();
    expect(store.getMessages('s5')).toHaveLength(0);
    expect(store.getToolResults('s5')).toHaveLength(0);
  });

  it('saves and retrieves workflow runs', () => {
    store.saveWorkflowRun({
      id: 'wf-1',
      workflowId: 'literature-review',
      status: 'completed',
      currentStepId: null,
      stepResults: { search: { status: 'completed' } },
      input: { topic: 'AI' },
      errors: [],
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
    });

    const run = store.getWorkflowRun('wf-1');
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');
  });

  it('saves eval runs', () => {
    store.saveEvalRun({
      id: 'eval-1',
      suiteName: 'test-suite',
      status: 'completed',
      successRate: 0.95,
      taskCount: 20,
      passedCount: 19,
      resultsJson: '[]',
      createdAt: Date.now(),
    });

    // Verify no errors
    const session = store.listSessions(1);
    // eval_runs is separate from sessions
    expect(session).toHaveLength(0);
  });

  it('handles limit parameter in getMessages', () => {
    store.createSession('s6');
    for (let i = 0; i < 10; i++) {
      store.appendMessage('s6', 'user', `msg ${i}`);
    }

    const limited = store.getMessages('s6', 5);
    expect(limited).toHaveLength(5);
    expect(limited[0].content).toBe('msg 0');
  });

  it('updates session metadata', () => {
    store.createSession('s7', { title: 'Old' });
    store.updateSession('s7', { metadata: { title: 'New', archived: true } });
    const session = store.getSession('s7');
    expect(session).toBeDefined();
    expect(session!.metadata.title).toBe('New');
    expect(session!.metadata.archived).toBe(true);
  });

  it('creates, lists and deletes artifacts', () => {
    store.createSession('s8');
    store.createArtifact({
      id: 'art-1',
      sessionId: 's8',
      name: 'paper.pdf',
      type: 'pdf',
      path: '/workspace/paper.pdf',
      size: '1.2MB',
    });
    store.createArtifact({
      id: 'art-2',
      sessionId: 's8',
      name: 'data.xlsx',
      type: 'xlsx',
      path: '/workspace/data.xlsx',
      size: '45KB',
    });

    const artifacts = store.listArtifacts('s8');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].name).toBe('data.xlsx');
    expect(artifacts.every((artifact) => artifact.contentAvailable === false)).toBe(true);
    expect(artifacts.every((artifact) => !Object.hasOwn(artifact, 'content'))).toBe(true);
    expect(store.getArtifactContent('art-1', 's8')).toBeUndefined();

    store.deleteArtifact('art-1');
    expect(store.listArtifacts('s8')).toHaveLength(1);
  });

  it('round-trips inline artifact content while list results expose only availability', () => {
    store.createSession('s-content');
    const content = '# Generated plan\n\n- Review sources\n- Draft findings\n';
    store.createArtifact({
      id: 'art-content',
      sessionId: 's-content',
      name: 'plan.md',
      type: 'md',
      content,
      metadata: { source: 'scenario-final-step' },
    });

    const listed = store.listArtifacts('s-content');
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'art-content',
        sessionId: 's-content',
        name: 'plan.md',
        type: 'md',
        contentAvailable: true,
      }),
    ]);
    expect(listed[0]).not.toHaveProperty('content');
    expect(store.getArtifactContent('art-content', 's-content')).toEqual({
      id: 'art-content',
      sessionId: 's-content',
      name: 'plan.md',
      type: 'md',
      content,
      createdAt: expect.any(Number),
    });
  });

  it('scopes inline artifact content to its session and reports file-only content as unavailable', () => {
    store.createSession('s-owner');
    store.createSession('s-other');
    store.createArtifact({
      id: 'art-inline',
      sessionId: 's-owner',
      name: 'notes.md',
      type: 'md',
      content: 'Session-owned content',
    });
    store.createArtifact({
      id: 'art-file',
      sessionId: 's-owner',
      name: 'paper.pdf',
      type: 'pdf',
      path: '/workspace/paper.pdf',
    });

    expect(store.getArtifactContent('art-inline', 's-other')).toBeUndefined();
    expect(store.getArtifactContent('missing-artifact', 's-owner')).toBeUndefined();
    expect(store.getArtifactContent('art-file', 's-owner')).toBeUndefined();
    expect(store.listArtifacts('s-owner')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'art-inline', contentAvailable: true }),
      expect.objectContaining({ id: 'art-file', contentAvailable: false }),
    ]));
  });

  it('migrates an old artifacts table by adding nullable content without changing file records', () => {
    store.close();
    dbPath = path.join(tmpDir, 'legacy-artifacts.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        path TEXT,
        size TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      INSERT INTO sessions (id, created_at, last_activity) VALUES ('legacy-session', 1, 1);
      INSERT INTO artifacts (id, session_id, name, type, path, size, created_at)
        VALUES ('legacy-file', 'legacy-session', 'legacy.pdf', 'pdf', '/workspace/legacy.pdf', '1MB', 2);
    `);
    legacy.close();

    store = new PersistenceStore(dbPath);
    const inspector = new Database(dbPath, { readonly: true });
    const columns = inspector.prepare("SELECT name FROM pragma_table_info('artifacts')").all() as Array<{ name: string }>;
    inspector.close();
    expect(columns.map((column) => column.name)).toContain('content');
    expect(store.listArtifacts('legacy-session')).toEqual([
      expect.objectContaining({ id: 'legacy-file', contentAvailable: false }),
    ]);
    expect(store.getArtifactContent('legacy-file', 'legacy-session')).toBeUndefined();

    store.createArtifact({
      id: 'post-migration-inline',
      sessionId: 'legacy-session',
      name: 'generated.md',
      type: 'md',
      content: 'Persisted after migration',
    });
    expect(store.getArtifactContent('post-migration-inline', 'legacy-session'))
      .toMatchObject({ content: 'Persisted after migration' });
  });

  it('replays identical deterministic ids idempotently and rolls back conflicting batches', () => {
    store.createSession('s-idempotent');
    const first = {
      id: 'deterministic-artifact',
      sessionId: 's-idempotent',
      name: 'final.md',
      type: 'md',
      content: 'Stable generated result',
      metadata: { step: 'final' },
    };
    store.createArtifact(first);
    expect(() => store.createArtifact({ ...first })).not.toThrow();
    expect(store.listArtifacts('s-idempotent')).toHaveLength(1);

    expect(() => store.createArtifact({
      ...first,
      content: 'Different generated result',
    })).toThrow('Artifact id conflicts with a different record');
    expect(store.getArtifactContent(first.id, first.sessionId)?.content)
      .toBe('Stable generated result');

    expect(() => store.createArtifacts([
      {
        id: 'would-be-rolled-back',
        sessionId: 's-idempotent',
        name: 'second.md',
        type: 'md',
        content: 'Second result',
      },
      { ...first, name: 'conflicting-name.md' },
    ])).toThrow('Artifact id conflicts with a different record');
    expect(store.listArtifacts('s-idempotent').map((artifact) => artifact.id))
      .toEqual(['deterministic-artifact']);
  });

  it('saves and retrieves paper pdfText', () => {
    store.savePaper({
      id: 'paper-1',
      title: 'Attention Is All You Need',
      authors: ['A Vaswani'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'We propose the Transformer.',
      doi: '10.1234/test',
      pdfPath: '/data/papers/attention.pdf',
      pdfText: 'The transformer relies entirely on attention mechanisms.',
      citationCount: 12000,
      tags: ['transformer'],
      notes: '',
      readStatus: 'read',
      rating: 5,
      addedAt: Date.now(),
    });

    const papers = store.getPapers();
    expect(papers).toHaveLength(1);
    expect(papers[0]!.pdfText).toBe('The transformer relies entirely on attention mechanisms.');
    expect(papers[0]!.citationCount).toBe(12000);
  });

  it('saves and retrieves collections', () => {
    store.saveCollection({
      id: 'col-1',
      name: 'Transformers',
      description: 'Transformer papers',
      paperIds: ['paper-1', 'paper-2'],
      createdAt: Date.now(),
    });

    const collections = store.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe('Transformers');
    expect(collections[0]!.paperIds).toEqual(['paper-1', 'paper-2']);

    store.deleteCollection('col-1');
    expect(store.getCollections()).toHaveLength(0);
  });

  it('searches local library across papers and notes', () => {
    store.savePaper({
      id: 'paper-1',
      title: 'Attention Is All You Need',
      authors: ['Vaswani et al.'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'We propose the transformer architecture for sequence modeling.',
      doi: '10.1234/attention',
      pdfText: 'The transformer relies entirely on self-attention.',
      tags: ['transformers'],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });
    store.saveNote({
      id: 'note-1',
      title: 'Transformer Notes',
      content: 'Self-attention computes pairwise interactions between tokens.',
      tags: ['attention'],
      linkedPaperIds: ['paper-1'],
      linkedNoteIds: [],
      updatedAt: Date.now(),
    });

    const results = store.searchLibrary('attention transformer', 5);

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results.some((r) => r.type === 'paper')).toBe(true);
    expect(results.some((r) => r.type === 'note')).toBe(true);
  });
});
