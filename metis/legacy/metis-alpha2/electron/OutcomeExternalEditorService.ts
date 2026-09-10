import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ExternalEditorKind = 'word' | 'ppt' | 'spreadsheet' | 'pdf';

export type ExternalEditorSession = Readonly<{
  token: string;
  projectId: string;
  outcomeId: string;
  baseVersion: number;
  kind: ExternalEditorKind;
  filePath: string;
  originalHash: string;
  createdAt: number;
}>;

type LaunchResult = { pid?: number; close?: () => Promise<void> };
type Launcher = (input: { kind: ExternalEditorKind; filePath: string }) => Promise<LaunchResult | void>;

type StoredSession = ExternalEditorSession & { close?: () => Promise<void>; pid?: number; pidStartedAt?: number };
type SessionManifest = Pick<ExternalEditorSession, 'token' | 'projectId' | 'outcomeId' | 'baseVersion' | 'kind' | 'originalHash' | 'createdAt'> & { fileName?: unknown; pid?: unknown; pidStartedAt?: unknown };
type OutcomeExternalEditorServiceOptions = {
  terminatePid?: (pid: number) => Promise<void>;
  /** Resolves the OS start time of a PID (epoch ms) so a reused PID is never killed by mistake. */
  readPidStartTime?: (pid: number) => Promise<number | undefined>;
  /** Fires after a session has been fully closed and its directory removed. */
  onClosed?: (session: ExternalEditorSession) => void;
  /**
   * 编辑器关闭自动同步（2026-09-01 刘总要求）：独立窗口模式下编辑器进程退出时
   * 触发——changed 表示磁盘文件相对打开基线有修改（保存过），由宿主自动同步；
   * 未修改则宿主安静收尾。内嵌模式没有子进程，不触发。
   */
  onEditorClosed?: (session: ExternalEditorSession, changed: boolean) => Promise<void> | void;
  /** 编辑器进程存活轮询间隔。 */
  monitorIntervalMs?: number;
};
export type ExternalEditorSessionState = { exists: boolean; changed: boolean; session: ExternalEditorSession | null };

const EXTENSIONS: Record<ExternalEditorKind, string> = {
  word: '.docx',
  ppt: '.pptx',
  spreadsheet: '.xlsx',
  pdf: '.pdf',
};
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_BYTES = 20 * 1024 * 1024;
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

function assertId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`external_editor_${name}_invalid`);
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeSessionManifest(directory: string, session: StoredSession, fileName: string): Promise<void> {
  await writeFile(path.join(directory, 'session.json'), JSON.stringify({
    token: session.token,
    projectId: session.projectId,
    outcomeId: session.outcomeId,
    baseVersion: session.baseVersion,
    kind: session.kind,
    fileName,
    originalHash: session.originalHash,
    createdAt: session.createdAt,
    pid: session.pid ?? null,
    pidStartedAt: session.pidStartedAt ?? null,
  }), { flag: 'w', mode: 0o600 });
}

const PID_START_TIME_TOLERANCE_MS = 1_500;

async function defaultReadPidStartTime(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process');
    const output = await new Promise<string>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()-[datetime]'1970-01-01').TotalMilliseconds`],
      { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
    });
    const milliseconds = Number(output.trim());
    return Number.isFinite(milliseconds) ? Math.round(milliseconds) : undefined;
  }
  const { execFile } = await import('node:child_process');
  const output = await new Promise<string>((resolve, reject) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contained(root: string, target: string): boolean {
  const normalizedRoot = normalizedPath(path.resolve(root));
  const normalizedTarget = normalizedPath(path.resolve(target));
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

async function createSafeDirectory(rootInput: string, segments: readonly string[]): Promise<string> {
  const root = path.resolve(rootInput);
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  const rootReal = await realpath(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || normalizedPath(rootReal) !== normalizedPath(root)) {
    throw new Error('external_editor_root_invalid');
  }
  let current = root;
  for (const segment of segments) {
    if (!SAFE_ID.test(segment)) throw new Error('external_editor_path_invalid');
    current = path.join(current, segment);
    await mkdir(current, { recursive: true });
    const directoryStat = await lstat(current);
    const directoryReal = await realpath(current);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !contained(root, directoryReal) || normalizedPath(directoryReal) !== normalizedPath(current)) {
      throw new Error('external_editor_path_invalid');
    }
  }
  return current;
}

async function readSafeFile(filePath: string, root: string): Promise<Buffer> {
  const fileStat = await lstat(filePath).catch(() => undefined);
  if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('external_editor_file_invalid');
  const fileReal = await realpath(filePath).catch(() => '');
  if (!fileReal || !contained(root, fileReal) || normalizedPath(fileReal) !== normalizedPath(filePath)) {
    throw new Error('external_editor_file_invalid');
  }
  return readFile(filePath);
}

export class OutcomeExternalEditorService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly monitors = new Map<string, ReturnType<typeof setInterval>>();
  private readonly terminatePid: (pid: number) => Promise<void>;
  private readonly readPidStartTime: (pid: number) => Promise<number | undefined>;
  private readonly onClosed: ((session: ExternalEditorSession) => void) | undefined;
  private readonly onEditorClosed: ((session: ExternalEditorSession, changed: boolean) => Promise<void> | void) | undefined;
  private readonly monitorIntervalMs: number;

  constructor(
    private readonly root: string,
    private readonly launcher: Launcher = async () => undefined,
    options: OutcomeExternalEditorServiceOptions = {},
  ) {
    this.onClosed = options.onClosed;
    this.onEditorClosed = options.onEditorClosed;
    this.monitorIntervalMs = Math.max(500, options.monitorIntervalMs ?? 2_500);
    this.terminatePid = options.terminatePid ?? (async (pid) => {
      if (process.platform === 'win32') {
        const { execFile } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => error ? reject(error) : resolve());
        });
      } else if (!process.kill(pid, 'SIGTERM')) {
        throw new Error('external_editor_process_termination_failed');
      }
    });
    this.readPidStartTime = options.readPidStartTime ?? defaultReadPidStartTime;
  }

  has(token: string): boolean {
    return this.sessions.has(token);
  }

  async create(input: {
    projectId: string;
    outcomeId: string;
    baseVersion: number;
    kind: ExternalEditorKind;
    fileName: string;
    bytes: Buffer;
    /** Embedded mode: create the session without spawning any editor process. */
    skipLaunch?: boolean;
  }): Promise<ExternalEditorSession> {
    assertId(input.projectId, 'project');
    assertId(input.outcomeId, 'outcome');
    if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) throw new Error('external_editor_version_invalid');
    if (!Number.isInteger(input.bytes.length) || input.bytes.length <= 0 || input.bytes.length > MAX_BYTES) throw new Error('external_editor_bytes_invalid');
    const extension = input.kind === 'spreadsheet' && input.fileName.toLowerCase().endsWith('.xlsm')
      ? '.xlsm'
      : EXTENSIONS[input.kind];
    if (!extension || !input.fileName.toLowerCase().endsWith(extension)) throw new Error('external_editor_extension_invalid');

    const token = `oe-${randomUUID()}`;
    if (path.basename(input.fileName) !== input.fileName) throw new Error('external_editor_file_name_invalid');
    const directory = await createSafeDirectory(this.root, [input.projectId, input.outcomeId, token]);
    const filePath = path.join(directory, input.fileName);
    try {
      await writeFile(filePath, input.bytes, { flag: 'wx', mode: 0o600 });
      await chmod(filePath, 0o600);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const session: StoredSession = {
      token,
      projectId: input.projectId,
      outcomeId: input.outcomeId,
      baseVersion: input.baseVersion,
      kind: input.kind,
      filePath,
      originalHash: hash(input.bytes),
      createdAt: Date.now(),
    };
    let launched: LaunchResult | void = undefined;
    try {
      await writeSessionManifest(directory, session, input.fileName);
      this.sessions.set(token, session);
      if (input.skipLaunch === true) {
        // Embedded presentation supplies its own surface; no child to launch.
        await writeSessionManifest(directory, session, input.fileName);
        return session;
      }
      launched = await this.launcher({ kind: input.kind, filePath });
      if (launched?.close) session.close = launched.close;
      if (launched?.pid) {
        session.pid = launched.pid;
        // Record ownership evidence now so a later PID-kill can never hit a
        // recycled PID that belongs to an unrelated process.
        const startedAt = await this.readPidStartTime(launched.pid).catch(() => undefined);
        if (startedAt !== undefined) session.pidStartedAt = startedAt;
      }
      await writeSessionManifest(directory, session, input.fileName);
      this.startMonitor(session);
    } catch (error) {
      this.sessions.delete(token);
      await launched?.close?.().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return session;
  }

  async state(token: string): Promise<{ exists: boolean; changed: boolean; filePath?: string }> {
    const session = this.sessions.get(token);
    if (!session) return { exists: false, changed: false };
    try {
      const bytes = await readSafeFile(session.filePath, this.root);
      return { exists: true, changed: hash(bytes) !== session.originalHash, filePath: session.filePath };
    } catch {
      return { exists: false, changed: false, filePath: session.filePath };
    }
  }

  // ── 编辑器关闭监视（2026-09-01 刘总要求：关了就自动同步，别再让人手点）──

  private startMonitor(session: StoredSession): void {
    // 内嵌模式没有子进程，不存在"编辑器关闭"信号；独立窗口模式轮询 pid。
    if (session.pid === undefined || this.monitors.has(session.token)) return;
    const timer = setInterval(() => {
      void this.checkEditorClosed(session.token);
    }, this.monitorIntervalMs);
    timer.unref?.();
    this.monitors.set(session.token, timer);
  }

  private stopMonitor(token: string): void {
    const timer = this.monitors.get(token);
    if (timer) {
      clearInterval(timer);
      this.monitors.delete(token);
    }
  }

  private async pidAlive(session: StoredSession): Promise<boolean> {
    if (session.pid === undefined) return false;
    try {
      process.kill(session.pid, 0);
    } catch {
      return false;
    }
    // PID 复用防护：启动时间对不上视为原进程已死。
    const current = await this.readPidStartTime(session.pid).catch(() => undefined);
    if (current === undefined || session.pidStartedAt === undefined) return true;
    return Math.abs(current - session.pidStartedAt) <= PID_START_TIME_TOLERANCE_MS;
  }

  private async checkEditorClosed(token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) {
      this.stopMonitor(token);
      return;
    }
    if (await this.pidAlive(session)) return;
    this.stopMonitor(token);
    let changed = false;
    try {
      changed = (await this.state(token)).changed;
    } catch {
      changed = false;
    }
    await this.onEditorClosed?.(session, changed);
  }

  async stateFor(projectId: string, outcomeId: string): Promise<ExternalEditorSessionState> {
    const session = this.sessionFor(projectId, outcomeId);
    if (!session) return { exists: false, changed: false, session: null };
    const current = await this.state(session.token);
    return { exists: current.exists, changed: current.changed, session };
  }

  async read(input: { token: string; projectId: string; outcomeId: string; currentVersion: number }): Promise<{ bytes: Buffer; session: ExternalEditorSession }> {
    const session = this.sessions.get(input.token);
    if (!session || session.projectId !== input.projectId || session.outcomeId !== input.outcomeId) throw new Error('external_editor_scope_denied');
    if (input.currentVersion !== session.baseVersion) throw new Error('external_editor_version_conflict');
    // 保存落盘重试（2026-09-01 刘总报告"明明保存了却提示未保存"）：编辑器保存
    // 到磁盘是异步落盘，读的瞬间可能还是旧字节。哈希与基线一致时等待一拍再读
    // 一次，仍一致才判定"没有修改"——把时序误报挡掉，同时不放过真正的未保存。
    const READ_SETTLE_MS = 900;
    let bytes: Buffer | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        bytes = await readSafeFile(session.filePath, this.root);
      } catch (error) {
        if ((error as Error).message === 'external_editor_file_invalid') throw error;
        throw new Error('external_editor_file_missing', { cause: error });
      }
      if (hash(bytes) !== session.originalHash) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, READ_SETTLE_MS));
    }
    if (!bytes || hash(bytes) === session.originalHash) throw new Error('external_editor_not_changed');
    const details = await stat(session.filePath).catch(() => undefined);
    if (!details || !details.isFile() || details.size <= 0 || details.size > MAX_BYTES) throw new Error('external_editor_file_invalid');
    return { bytes, session };
  }

  session(token: string): ExternalEditorSession | undefined {
    return this.sessions.get(token);
  }

  sessionFor(projectId: string, outcomeId: string): ExternalEditorSession | undefined {
    return [...this.sessions.values()].find((session) => session.projectId === projectId && session.outcomeId === outcomeId);
  }

  sessionsFor(projectId: string, outcomeId: string): ExternalEditorSession[] {
    return [...this.sessions.values()].filter((session) => session.projectId === projectId && session.outcomeId === outcomeId);
  }

  async closeIfClean(projectId: string, outcomeId: string): Promise<'closed' | 'missing' | 'dirty'> {
    const session = this.sessionFor(projectId, outcomeId);
    if (!session) return 'missing';
    const current = await this.state(session.token);
    if (!current.exists || current.changed) return 'dirty';
    await this.close(session.token);
    return 'closed';
  }

  async closeFor(projectId: string, outcomeId: string): Promise<'closed' | 'missing' | 'dirty'> {
    const sessions = this.sessionsFor(projectId, outcomeId);
    if (sessions.length === 0) return 'missing';
    const states = await Promise.all(sessions.map((session) => this.state(session.token)));
    if (states.some((state) => !state.exists || state.changed)) return 'dirty';
    for (const session of sessions) await this.close(session.token);
    return 'closed';
  }

  /**
   * Kills the session's editor process only when PID ownership is proven:
   * the OS-reported start time must match the one recorded at launch, and
   * legacy manifests without evidence are never killed (file cleanup only).
   */
  private async terminateOwnedPid(session: StoredSession): Promise<void> {
    if (session.pid === undefined) return;
    if (session.pidStartedAt === undefined) return;
    const current = await this.readPidStartTime(session.pid).catch(() => undefined);
    if (current === undefined || Math.abs(current - session.pidStartedAt) > PID_START_TIME_TOLERANCE_MS) return;
    await this.terminatePid(session.pid);
  }

  /** Stop all child editors during app shutdown but retain session files for recovery. */
  async shutdownAll(): Promise<void> {
    for (const timer of this.monitors.values()) clearInterval(timer);
    this.monitors.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => {
      if (session.close) await session.close();
      else await this.terminateOwnedPid(session);
    }));
  }

  async close(token: string): Promise<void> {
    this.stopMonitor(token);
    const session = this.sessions.get(token);
    if (!session) return;
    if (session.close) await session.close();
    else await this.terminateOwnedPid(session);
    await rm(path.dirname(session.filePath), { recursive: true, force: true });
    this.sessions.delete(token);
    this.onClosed?.(session);
  }

  async discardAll(): Promise<void> {
    const tokens = [...this.sessions.keys()];
    await Promise.allSettled(tokens.map((token) => this.close(token)));
  }

  async recoverStale(now = Date.now()): Promise<void> {
    const root = path.resolve(this.root);
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const projectEntry of projects) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink() || !SAFE_ID.test(projectEntry.name)) continue;
      const projectDirectory = path.join(root, projectEntry.name);
      const outcomes = await readdir(projectDirectory, { withFileTypes: true }).catch(() => []);
      for (const outcomeEntry of outcomes) {
        if (!outcomeEntry.isDirectory() || outcomeEntry.isSymbolicLink() || !SAFE_ID.test(outcomeEntry.name)) continue;
        const outcomeDirectory = path.join(projectDirectory, outcomeEntry.name);
        const sessions = await readdir(outcomeDirectory, { withFileTypes: true }).catch(() => []);
        for (const sessionEntry of sessions) {
          if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink() || !SAFE_ID.test(sessionEntry.name)) continue;
          const directory = path.join(outcomeDirectory, sessionEntry.name);
          const manifestPath = path.join(directory, 'session.json');
          try {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SessionManifest;
            if (manifest.token !== sessionEntry.name || !SAFE_ID.test(manifest.projectId) || !SAFE_ID.test(manifest.outcomeId)
              || !Number.isSafeInteger(manifest.baseVersion) || manifest.baseVersion < 1
              || !EXTENSIONS[manifest.kind] || typeof manifest.originalHash !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.originalHash)
              || typeof manifest.createdAt !== 'number' || typeof manifest.fileName !== 'string'
              || path.basename(manifest.fileName) !== manifest.fileName) continue;
            const pid = typeof manifest.pid === 'number' && Number.isSafeInteger(manifest.pid) ? manifest.pid : undefined;
            const pidStartedAt = typeof manifest.pidStartedAt === 'number' && Number.isSafeInteger(manifest.pidStartedAt) ? manifest.pidStartedAt : undefined;
            let processAlive = false;
            if (pid !== undefined) {
              try { process.kill(pid, 0); processAlive = true; } catch { processAlive = false; }
            }
            const filePath = path.join(directory, manifest.fileName);
            const fileStat = await lstat(filePath).catch(() => undefined);
            if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) continue;
            if (processAlive || now - manifest.createdAt <= STALE_SESSION_MS) {
              this.sessions.set(manifest.token, {
                token: manifest.token,
                projectId: manifest.projectId,
                outcomeId: manifest.outcomeId,
                baseVersion: manifest.baseVersion,
                kind: manifest.kind,
                filePath,
                originalHash: manifest.originalHash,
                createdAt: manifest.createdAt,
                ...(pid === undefined ? {} : { pid }),
                ...(pidStartedAt === undefined ? {} : { pidStartedAt }),
              });
              const revived = this.sessions.get(manifest.token);
              if (revived) this.startMonitor(revived);
            } else if (now - manifest.createdAt > STALE_SESSION_MS) {
              await rm(directory, { recursive: true, force: true });
            }
          } catch { /* malformed or live sessions are left for explicit cleanup */ }
        }
      }
    }
  }
}
