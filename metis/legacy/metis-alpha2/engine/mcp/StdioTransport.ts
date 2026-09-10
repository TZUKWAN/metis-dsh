/**
 * StdioTransport — Node.js child_process implementation of MCPTransport.
 *
 * Spawns the MCP server as a child process and communicates via stdin/stdout.
 *
 * Lifecycle contract (METIS-005):
 *   - `start` spawns the child and confirms it remains alive through a short liveness
 *     window. A process that exits cleanly before the initialize handshake is still not
 *     a usable MCP server and is rejected immediately. Protocol validation remains the
 *     responsibility of `connect()`.
 *   - `send` never raises an uncaught 'error' event on stdin: writes to an already
 *     closed pipe are caught and surfaced as a synchronous, catchable error.
 *   - `close` is idempotent, removes only transport-owned listeners, reaps the child,
 *     and always completes within a bounded grace/force-kill deadline.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { MCPTransport } from './MCPClient.js';

// Short window to catch a definitive launch failure before the MCP initialize request.
// Both clean and non-zero early exits are failures: neither can answer the handshake.
const LAUNCH_CHECK_MS = 200;
const SHUTDOWN_GRACE_MS = 2_000;
const FORCE_KILL_WAIT_MS = 1_000;

export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private messageHandler: ((message: string) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closed = false;
  private stdinErrorHandler: ((err: Error) => void) | null = null;
  private processErrorHandler: ((err: Error) => void) | null = null;
  private processExitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;

  async start(command: string[], env?: Record<string, string>): Promise<void> {
    if (this.process) throw new Error('Transport already started');
    if (command.length === 0) throw new Error('Command cannot be empty');

    const [cmd, ...args] = command;
    if (!cmd) throw new Error('Command cannot be empty');

    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    this.closed = false;

    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString('utf-8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        this.messageHandler?.(line);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      // Log stderr for debugging but don't treat as fatal
      console.error(`[MCP stderr] ${data.toString('utf-8').trim()}`);
    });

    // Attach an EPIPE / write-error sink so writes to a dead pipe never become a
    // process-level unhandled 'error' event (the previous source of EPIPE crashes).
    this.stdinErrorHandler = (err: Error) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error('[MCP stdin error]', err.message);
      }
    };
    child.stdin?.on('error', this.stdinErrorHandler);

    this.processErrorHandler = (err: Error) => {
      if (!this.closed) {
        this.errorHandler?.(
          new Error(`MCP server process error: ${err.message}`, { cause: err }),
        );
      }
    };
    this.processExitHandler = (code, signal) => {
      if (!this.closed) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        this.errorHandler?.(new Error(`MCP server exited (${detail})`));
      }
    };
    child.on('error', this.processErrorHandler);
    child.on('exit', this.processExitHandler);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
        fn();
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        finish(() => reject(new Error(`MCP server exited before handshake (${detail})`)));
      };
      const onError = (err: Error) => {
        finish(() => reject(err));
      };
      const timer = setTimeout(() => {
        // No launch-time failure observed — assume the process is up. connect() will
        // validate MCP handshake behaviour with its own timeout.
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode, child.signalCode);
          return;
        }
        finish(() => resolve());
      }, LAUNCH_CHECK_MS);

      child.once('exit', onExit);
      child.once('error', onError);

      // Race guard: a child that fails synchronously (e.g. ENOENT for a missing
      // binary) can emit 'error' before the listener is attached.
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit(child.exitCode, child.signalCode);
      }
    });
  }

  send(message: string): void {
    const stdin = this.process?.stdin;
    if (!this.process || !stdin) throw new Error('Transport not started');
    // A process that has exited still has a non-null `stdin` object, but it is no
    // longer writable. Writing would emit an asynchronous 'error' (EPIPE); instead
    // detect this synchronously so callers can handle it.
    if (stdin.destroyed || !stdin.writable) {
      throw new Error('MCP server stdin is closed (process exited)');
    }
    try {
      stdin.write(message + '\n');
    } catch (err) {
      // Synchronous write failure (e.g. broken pipe on some platforms) — rethrow as
      // a catchable transport error rather than letting it surface as EPIPE.
      throw new Error(`Failed to write to MCP server stdin: ${(err as Error).message}`, { cause: err });
    }
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    // Idempotent: repeated close() calls are a no-op (MCPManager calls close in both
    // the success and error paths of connect/testConnection).
    if (this.closed) return;
    this.closed = true;

    const proc = this.process;
    const stdinErrHandler = this.stdinErrorHandler;
    const processErrHandler = this.processErrorHandler;
    const processExitHandler = this.processExitHandler;
    this.process = null;
    this.messageHandler = null;
    this.errorHandler = null;
    this.stdinErrorHandler = null;
    this.processErrorHandler = null;
    this.processExitHandler = null;

    if (!proc) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      // eslint-disable-next-line prefer-const -- reassigned at L213, ESLint closure analysis false positive
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let finalDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (stdinErrHandler) proc.stdin?.off('error', stdinErrHandler);
        if (processErrHandler) proc.off('error', processErrHandler);
        if (processExitHandler) proc.off('exit', processExitHandler);
        proc.off('exit', done);
        proc.off('close', done);
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
      };
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        clearTimeout(finalDeadlineTimer);
        cleanup();
        resolve();
      };

      // Install the reaper before ending stdin or removing lifecycle listeners. This
      // prevents a fast child exit from being lost during teardown.
      proc.once('exit', done);
      proc.once('close', done);

      if (processErrHandler) proc.off('error', processErrHandler);
      if (processExitHandler) proc.off('exit', processExitHandler);

      if (proc.exitCode !== null || proc.signalCode !== null) {
        done();
        return;
      }

      try {
        proc.stdin?.end();
      } catch {
        // ignore — pipe may already be closed
      }

      forceKillTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        } catch {
          // ignore — process may have exited between check and kill
        }

        // Windows can fail to emit exit after a failed or racy kill. Teardown is always
        // bounded so callers and test workers cannot wait forever on a child-process
        // event that will never arrive.
        finalDeadlineTimer = setTimeout(() => {
          // If the platform never reports child exit, release every parent-side handle
          // before returning so the application/test worker is not kept alive.
          proc.stdin?.destroy();
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          proc.unref();
          done();
        }, FORCE_KILL_WAIT_MS);
      }, SHUTDOWN_GRACE_MS);
    });
  }
}
