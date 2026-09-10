import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OutcomeExternalEditorService } from '../../electron/OutcomeExternalEditorService.js';

describe('OutcomeExternalEditorService', () => {
  it('creates a scoped GenOffice session and rejects sync after an outcome version conflict', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    try {
      const service = new OutcomeExternalEditorService(root, async () => ({ pid: 1234 }));
      const session = await service.create({
        projectId: 'project-1',
        outcomeId: 'out-1',
        baseVersion: 3,
        kind: 'word',
        fileName: 'draft.docx',
        bytes: Buffer.from('original'),
      });

      expect(session.token).toMatch(/^oe-/u);
      expect(session.filePath).toContain(`${path.sep}project-1${path.sep}out-1${path.sep}`);
      expect(await readFile(session.filePath, 'utf8')).toBe('original');
      expect((await service.state(session.token)).changed).toBe(false);

      await expect(service.read({ token: session.token, projectId: 'project-1', outcomeId: 'out-1', currentVersion: 4 }))
        .rejects.toThrow('external_editor_version_conflict');
      await expect(service.read({ token: session.token, projectId: 'project-other', outcomeId: 'out-1', currentVersion: 3 }))
        .rejects.toThrow('external_editor_scope_denied');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a changed file only after GenOffice has saved it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    try {
      const service = new OutcomeExternalEditorService(root);
      const session = await service.create({
        projectId: 'project-1',
        outcomeId: 'out-1',
        baseVersion: 1,
        kind: 'pdf',
        fileName: 'paper.pdf',
        bytes: Buffer.from('pdf'),
      });
      await expect(service.read({ token: session.token, projectId: 'project-1', outcomeId: 'out-1', currentVersion: 1 }))
        .rejects.toThrow('external_editor_not_changed');
      await import('node:fs/promises').then(({ writeFile }) => writeFile(session.filePath, Buffer.from('saved-pdf')));
      const result = await service.read({ token: session.token, projectId: 'project-1', outcomeId: 'out-1', currentVersion: 1 });
      expect(result.bytes.toString()).toBe('saved-pdf');
      expect((await service.state(session.token)).changed).toBe(true);
      await service.close(session.token);
      expect((await service.state(session.token)).exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a failed external close session available instead of reporting a false cleanup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    let closeAttempts = 0;
    try {
      const service = new OutcomeExternalEditorService(root, async () => ({ close: async () => { closeAttempts += 1; throw new Error('close_failed'); } }));
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') });
      await expect(service.close(session.token)).rejects.toThrow('close_failed');
      expect(closeAttempts).toBe(1);
      expect(service.has(session.token)).toBe(true);
      expect((await service.state(session.token)).exists).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds an external session to the exact version that was opened', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    try {
      const service = new OutcomeExternalEditorService(root);
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'word', fileName: 'history.docx', bytes: Buffer.from('history') });
      await import('node:fs/promises').then(({ writeFile }) => writeFile(session.filePath, Buffer.from('saved-history')));
      await expect(service.read({ token: session.token, projectId: 'project-1', outcomeId: 'out-1', currentVersion: 2 }))
        .rejects.toThrow('external_editor_version_conflict');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked session directories before writing an external file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-outside-'));
    try {
      const project = path.join(root, 'project-1');
      await import('node:fs/promises').then(({ mkdir, symlink }) => Promise.all([
        mkdir(root, { recursive: true }),
        symlink(outside, project, process.platform === 'win32' ? 'junction' : 'dir'),
      ]));
      const service = new OutcomeExternalEditorService(root);
      await expect(service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') }))
        .rejects.toThrow('external_editor_path_invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes a session manifest and removes only old dead sessions during recovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    try {
      const service = new OutcomeExternalEditorService(root);
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') });
      const manifestPath = path.join(path.dirname(session.filePath), 'session.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { createdAt: number };
      expect(manifest.createdAt).toBeGreaterThan(0);
      await writeFile(manifestPath, JSON.stringify({ ...manifest, createdAt: 0 }));
      await service.recoverStale();
      expect((await service.state(session.token)).exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rehydrates a changed session after a process restart so the saved file remains syncable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-recovery-'));
    try {
      const first = new OutcomeExternalEditorService(root, async () => ({ pid: process.pid }));
      const session = await first.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-original') });
      await writeFile(session.filePath, Buffer.from('%PDF-saved'));

      const restarted = new OutcomeExternalEditorService(root, async () => undefined, { terminatePid: async () => undefined });
      await restarted.recoverStale(Date.now());

      expect(restarted.session(session.token)).toMatchObject({ token: session.token, projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1 });
      await expect(restarted.read({ token: session.token, projectId: 'project-1', outcomeId: 'out-1', currentVersion: 1 })).resolves.toMatchObject({ bytes: Buffer.from('%PDF-saved') });
      await restarted.close(session.token);
      expect((await restarted.state(session.token)).exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a dirty outcome session without silently discarding it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-outcome-state-'));
    try {
      const service = new OutcomeExternalEditorService(root);
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-original') });
      await writeFile(session.filePath, Buffer.from('%PDF-saved'));
      expect(service.sessionFor('project-1', 'out-1')?.token).toBe(session.token);
      await expect(service.closeIfClean('project-1', 'out-1')).resolves.toBe('dirty');
      expect(service.has(session.token)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('closes every clean session for an outcome but refuses to discard a dirty session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-outcome-state-'));
    try {
      const service = new OutcomeExternalEditorService(root);
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-original') });
      expect(service.sessionFor('project-1', 'out-1')?.token).toBe(session.token);
      await writeFile(session.filePath, Buffer.from('%PDF-saved'));
      await expect(service.closeFor('project-1', 'out-1')).resolves.toBe('dirty');
      expect(service.has(session.token)).toBe(true);

      await writeFile(session.filePath, Buffer.from('%PDF-original'));
      await expect(service.closeFor('project-1', 'out-1')).resolves.toBe('closed');
      expect(service.has(session.token)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates dirty sessions on shutdown but preserves their files for restart recovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-shutdown-'));
    let terminated = 0;
    try {
      const service = new OutcomeExternalEditorService(root, async () => ({ pid: 4567 }), { terminatePid: async () => { terminated += 1; }, readPidStartTime: async () => 1_000_000 });
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-original') });
      await writeFile(session.filePath, Buffer.from('%PDF-saved'));
      await service.shutdownAll();
      expect(terminated).toBe(1);
      expect(service.has(session.token)).toBe(false);
      expect((await readFile(session.filePath)).toString()).toBe('%PDF-saved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records PID start-time ownership evidence in the session manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-pid-owner-'));
    try {
      const service = new OutcomeExternalEditorService(root, async () => ({ pid: 2468 }), { readPidStartTime: async () => 5_000_000 });
      const session = await service.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') });
      const manifest = JSON.parse(await readFile(path.join(path.dirname(session.filePath), 'session.json'), 'utf8')) as { pid?: number; pidStartedAt?: number };
      expect(manifest.pid).toBe(2468);
      expect(manifest.pidStartedAt).toBe(5_000_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never kills a recovered session whose PID start time no longer matches (PID reuse)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-pid-reuse-'));
    let terminated = 0;
    try {
      const creator = new OutcomeExternalEditorService(root, async () => ({ pid: 1357 }), { readPidStartTime: async () => 7_000_000 });
      const session = await creator.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') });
      // Simulate app restart: the recovered manifest has no live close callback,
      // and the OS now reports a different start time for the recycled PID.
      const restarted = new OutcomeExternalEditorService(root, async () => undefined, {
        terminatePid: async () => { terminated += 1; },
        readPidStartTime: async () => 9_999_999,
      });
      await restarted.recoverStale(Date.now());
      expect(restarted.session(session.token)).toBeTruthy();
      await restarted.close(session.token);
      expect(terminated).toBe(0);
      expect((await restarted.state(session.token)).exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never kills a legacy session manifest that lacks PID ownership evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-pid-legacy-'));
    let terminated = 0;
    try {
      const creator = new OutcomeExternalEditorService(root, async () => ({ pid: 8642 }), { readPidStartTime: async () => undefined });
      const session = await creator.create({ projectId: 'project-1', outcomeId: 'out-1', baseVersion: 1, kind: 'pdf', fileName: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') });
      const restarted = new OutcomeExternalEditorService(root, async () => undefined, {
        terminatePid: async () => { terminated += 1; },
        readPidStartTime: async () => 7_000_000,
      });
      await restarted.recoverStale(Date.now());
      expect(restarted.session(session.token)).toBeTruthy();
      await restarted.close(session.token);
      expect(terminated).toBe(0);
      expect((await restarted.state(session.token)).exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('auto-syncs on editor close: pid death triggers onEditorClosed with changed state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    const events: Array<{ outcomeId: string; changed: boolean }> = [];
    try {
      // 活性判定依赖启动时间比对：活着返回记录的启动时间，"关闭"后返回错配值。
      let pidAlive = true;
      const service = new OutcomeExternalEditorService(root, async () => ({ pid: 4321 }), {
        readPidStartTime: async () => (pidAlive ? 1_000_000 : 9_999_999),
        monitorIntervalMs: 20,
        onEditorClosed: (session, changed) => { events.push({ outcomeId: session.outcomeId, changed }); },
      });
      const session = await service.create({
        projectId: 'project-1',
        outcomeId: 'out-auto',
        baseVersion: 1,
        kind: 'word',
        fileName: 'draft.docx',
        bytes: Buffer.from('v1'),
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(events).toEqual([]); // 进程活着：不触发
      // 模拟用户关闭编辑器：pid 消失 + 已保存改动落盘
      pidAlive = false;
      await writeFile(session.filePath, Buffer.from('v2-saved'));
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(events).toEqual([{ outcomeId: 'out-auto', changed: true }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('read() retries once before declaring not-changed (save flush lag)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'metis-genoffice-test-'));
    try {
      const service = new OutcomeExternalEditorService(root, async () => undefined);
      const session = await service.create({
        projectId: 'project-1',
        outcomeId: 'out-retry',
        baseVersion: 1,
        kind: 'word',
        fileName: 'draft.docx',
        bytes: Buffer.from('base'),
      });
      // 300ms 后才落盘——比一次 read 的等待窗口晚启动但落在 900ms 重试窗口内
      setTimeout(() => { void writeFile(session.filePath, Buffer.from('flushed-late')); }, 300);
      const result = await service.read({ token: session.token, projectId: 'project-1', outcomeId: 'out-retry', currentVersion: 1 });
      expect(result.bytes.toString()).toBe('flushed-late');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
