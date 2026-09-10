import { spawn, type ChildProcess } from 'node:child_process';
import type { MCPTransport } from './MCPClient.js';

/**
 * stdio transport for managed personalization MCPs.
 *
 * Unlike the legacy transport, this transport does not merge `process.env`.
 * Only the explicitly resolved allowlist is requested (Windows itself may add
 * mandatory OS variables such as SYSTEMROOT), the executable is launched
 * directly with `shell:false`, and protocol lines are bounded.
 */
export class ExactEnvironmentStdioTransport implements MCPTransport {
  readonly #workingDirectory: string;
  readonly #maxLineBytes: number;
  #child: ChildProcess | null = null;
  #messageHandler: ((message: string) => void) | null = null;
  #errorHandler: ((error: Error) => void) | null = null;
  #buffer = '';

  constructor(workingDirectory: string, maxLineBytes = 2 * 1024 * 1024) {
    this.#workingDirectory = workingDirectory;
    this.#maxLineBytes = maxLineBytes;
  }

  async start(command: string[], environment?: Record<string, string>): Promise<void> {
    if (this.#child) throw new Error('Transport already started');
    const [executable, ...args] = command;
    if (!executable) throw new Error('Command cannot be empty');
    const child = spawn(executable, args, {
      cwd: this.#workingDirectory,
      env: { ...(environment ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.#acceptStdout(chunk));
    child.stderr?.on('data', () => { /* stderr is intentionally not forwarded */ });
    child.stdin?.on('error', (error) => this.#errorHandler?.(error));
    child.on('error', (error) => this.#errorHandler?.(error));
    child.on('exit', (code, signal) => {
      if (this.#child === child) {
        this.#errorHandler?.(new Error(`Managed MCP exited (${signal ?? code ?? 'unknown'})`));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number | null) => { cleanup(); reject(new Error(`Managed MCP exited before handshake (${code ?? 'unknown'})`)); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, 100);
      const cleanup = () => {
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  send(message: string): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error('Managed MCP stdin is unavailable');
    if (Buffer.byteLength(message, 'utf8') > this.#maxLineBytes || message.includes('\n') || message.includes('\r')) {
      throw new Error('Managed MCP request exceeds the newline-delimited protocol boundary');
    }
    stdin.write(`${message}\n`);
  }

  onMessage(handler: (message: string) => void): void {
    this.#messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.#errorHandler = handler;
  }

  async close(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#buffer = '';
    if (!child) return;
    await new Promise<void>((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        child.removeAllListeners();
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        resolve();
      };
      child.once('exit', finish);
      child.once('close', finish);
      try { child.stdin?.end(); } catch { /* already closed */ }
      const forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 500);
      const deadline = setTimeout(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish();
      }, 1_500);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }

  #acceptStdout(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxLineBytes) {
      this.#errorHandler?.(new Error('Managed MCP protocol line exceeded the configured limit'));
      try { this.#child?.kill('SIGKILL'); } catch { /* process already gone */ }
      return;
    }
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim()) this.#messageHandler?.(line);
      newline = this.#buffer.indexOf('\n');
    }
  }
}
