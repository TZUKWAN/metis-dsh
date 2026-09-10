/**
 * MainProcessLogger (Task 3 §11).
 *
 * Replaces the two chained console wrappers that previously lived in
 * `electron/main.ts`:
 *  1. a synchronous `fs.appendFileSync` tail log (blocked the main loop under
 *     high-frequency agent/tool/event logging, no rotation), and
 *  2. a stream mirror into the data directory (no day rollover, no redaction).
 *
 * Both destinations are preserved — the dev real-time tail file
 * (`logs/main-app.log`, 2026-08-25 requirement) and the data-dir archive
 * (`logs/main-<date>.log`, 2026-08-29 requirement) — but writes are now
 * buffered, size-rotated, day-rolled, redacted, and flushed on shutdown.
 *
 * Hard guarantees:
 *  - logging failures never propagate into the app (counted, surfaced once);
 *  - install() is idempotent and never double-wraps itself;
 *  - flush paths usable from `process.on('exit')` are synchronous;
 *  - no heavyweight logging framework is introduced.
 */

import fs from 'node:fs';
import path from 'node:path';

export type MainProcessLogLevel = 'log' | 'warn' | 'error';

export interface MainProcessLoggerOptions {
  /**
   * Real-time tail log (dev `tail -f` diagnostics). `null` disables the
   * destination entirely (e.g. packaged builds that never tail it).
   */
  tailLogPath: string | null;
  /**
   * Archive file for a given day. Called on first write of each day; the
   * directory is created if missing. Return `null` to disable archiving.
   */
  archivePathForDate: (date: Date) => string | null;
  /** Buffered flush cadence. Default 150ms. */
  flushIntervalMs?: number;
  /** Immediately flush when the buffer reaches this many lines. Default 64. */
  maxBufferedLines?: number;
  /** Rotate the tail log once it exceeds this size. Default 8 MiB. */
  maxTailFileBytes?: number;
  /** How many rotated tail files to keep (`main-app.log.1` … `.N`). Default 3. */
  tailRotationsToKeep?: number;
  /** Redact credential-shaped substrings. Default true. */
  redact?: boolean;
  /** Truncate single log lines beyond this length. Default 16000. */
  maxLineChars?: number;
  /**
   * Archive lines buffered while no archive destination is bound
   * (data dir not resolved yet). Oldest dropped beyond this. Default 5000.
   */
  maxArchiveBacklog?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface MainProcessLoggerStats {
  linesWritten: number;
  redactionsApplied: number;
  failedWrites: number;
  bufferedLines: number;
  tailRotations: number;
  archiveDayRolls: number;
}

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-***' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer ***' },
  {
    // api_key / apiKey / api-key, access_token, refresh_token, secret …
    pattern: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passphrase)\b(\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;}"']{4,})/gi,
    replacement: '$1$2***',
  },
  { pattern: /\b(authorization)\b(\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;}"']{4,})/gi, replacement: '$1$2***' },
  { pattern: /\b(cookie)\b(\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;}"']{4,})/gi, replacement: '$1$2***' },
];

export class MainProcessLogger {
  private readonly tailLogPath: string | null;
  private readonly archivePathForDate: (date: Date) => string | null;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedLines: number;
  private readonly maxTailFileBytes: number;
  private readonly tailRotationsToKeep: number;
  private readonly redact: boolean;
  private readonly maxLineChars: number;
  private readonly maxArchiveBacklog: number;
  private readonly now: () => Date;

  private readonly tailBuffer: string[] = [];
  private readonly archiveBuffer: string[] = [];
  private tailFd: number | null = null;
  private archiveFd: number | null = null;
  private archiveOpenDayKey: string | null = null;
  private archiveActivePath: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private installed = false;
  private originalConsole: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error } | null = null;
  private reportedWriteFailure = false;
  private exitHookInstalled = false;
  private contextStack: Array<Record<string, unknown>> = [];

  private readonly stats: MainProcessLoggerStats = {
    linesWritten: 0,
    redactionsApplied: 0,
    failedWrites: 0,
    bufferedLines: 0,
    tailRotations: 0,
    archiveDayRolls: 0,
  };

  constructor(options: MainProcessLoggerOptions) {
    this.tailLogPath = options.tailLogPath ?? null;
    this.archivePathForDate = options.archivePathForDate;
    this.flushIntervalMs = options.flushIntervalMs ?? 150;
    this.maxBufferedLines = options.maxBufferedLines ?? 64;
    this.maxTailFileBytes = options.maxTailFileBytes ?? 8 * 1024 * 1024;
    this.tailRotationsToKeep = Math.max(1, options.tailRotationsToKeep ?? 3);
    this.redact = options.redact ?? true;
    this.maxLineChars = options.maxLineChars ?? 16_000;
    this.maxArchiveBacklog = options.maxArchiveBacklog ?? 5000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Wraps console.log/warn/error. Idempotent: a second install on an already
   * wrapped console is a no-op, never a double wrap.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.originalConsole = { log: console.log, warn: console.warn, error: console.error };
    const write = (level: MainProcessLogLevel, args: unknown[]): void => {
      this.enqueue(level, args);
    };
    console.log = (...args: unknown[]) => {
      write('log', args);
      this.originalConsole!.log(...args);
    };
    console.warn = (...args: unknown[]) => {
      write('warn', args);
      this.originalConsole!.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      write('error', args);
      this.originalConsole!.error(...args);
    };

    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.on('exit', () => {
        // Synchronous best-effort flush; guaranteed not to throw.
        this.flushSync();
      });
    }

    if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => {
        this.flush();
      }, this.flushIntervalMs);
      // Never keep the process alive for the flush timer alone.
      this.flushTimer.unref?.();
    }
  }

  /** Pushes correlation fields (operationId / correlationId / …) for the scope of `fn`. */
  withContext<T>(context: Record<string, unknown>, fn: () => T): T {
    this.contextStack.push(context);
    try {
      return fn();
    } finally {
      this.contextStack.pop();
    }
  }

  /**
   * Enables the data-dir archive once the data directory is resolved.
   * Rebinds the day key so the next flush re-evaluates `archivePathForDate`
   * and drains the buffered pre-bind lines into the freshly opened file.
   */
  rebindArchiveTarget(): void {
    this.flush();
    this.archiveOpenDayKey = null;
    this.archiveActivePath = null;
  }

  /** Flushes buffers to their destinations. Safe to call any time. */
  flush(): void {
    this.flushSync();
  }

  /** Synchronous flush — also used by the `exit` hook. Never throws. */
  flushSync(): void {
    this.flushTail();
    this.flushArchive();
  }

  /** Flush + stop timer + restore console. Called from the shutdown path. */
  dispose(): void {
    this.flushSync();
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.closeTailFd();
    this.closeArchiveFd();
    if (this.installed && this.originalConsole) {
      console.log = this.originalConsole.log;
      console.warn = this.originalConsole.warn;
      console.error = this.originalConsole.error;
      this.installed = false;
    }
  }

  getStats(): MainProcessLoggerStats {
    return { ...this.stats, bufferedLines: this.tailBuffer.length + this.archiveBuffer.length };
  }

  // ── internals ────────────────────────────────────────────────

  private enqueue(level: MainProcessLogLevel, args: unknown[]): void {
    try {
      const timestamp = this.now().toISOString();
      const message = this.formatArgs(args);
      const context = this.contextStack.length > 0 ? this.contextStack[this.contextStack.length - 1] : null;
      const contextPrefix = context && Object.keys(context).length > 0
        ? ` [${Object.entries(context).map(([k, v]) => `${k}=${String(v)}`).join(' ')}]`
        : '';
      const line = `[${timestamp}] [${level}]${contextPrefix} ${message}\n`;
      if (this.tailLogPath !== null) this.tailBuffer.push(line);
      this.archiveBuffer.push(line);
      this.stats.bufferedLines = this.tailBuffer.length + this.archiveBuffer.length;
      const saturated = this.tailBuffer.length >= this.maxBufferedLines || this.archiveBuffer.length >= this.maxBufferedLines;
      if (saturated) this.flush();
    } catch {
      // Formatting must never break the caller.
    }
  }

  private formatArgs(args: unknown[]): string {
    const raw = args
      .map((item) => (typeof item === 'string' ? item : this.safeStringify(item)))
      .join(' ');
    const bounded = raw.length > this.maxLineChars ? `${raw.slice(0, this.maxLineChars)}…[truncated ${raw.length - this.maxLineChars} chars]` : raw;
    if (!this.redact) return bounded;
    let out = bounded;
    for (const rule of DEFAULT_REDACTION_RULES) {
      out = out.replace(rule.pattern, rule.replacement);
    }
    if (out !== bounded) this.stats.redactionsApplied += 1;
    return out;
  }

  private safeStringify(item: unknown): string {
    if (item instanceof Error) return `${item.name}: ${item.message}`;
    try {
      return JSON.stringify(item) ?? String(item);
    } catch {
      return String(item);
    }
  }

  private flushTail(): void {
    if (this.tailLogPath === null || this.tailBuffer.length === 0) return;
    const lines = this.tailBuffer.splice(0);
    this.stats.bufferedLines = this.tailBuffer.length + this.archiveBuffer.length;
    try {
      this.ensureTailFd();
      if (this.tailFd === null) throw new Error('tail fd unavailable');
      const payload = lines.join('');
      // Rotate before the write would exceed the size cap.
      if (this.shouldRotateTail(Buffer.byteLength(payload))) {
        this.rotateTail();
        this.ensureTailFd();
      }
      // fd.writeSync keeps the real-time tail contract without buffering
      // surprises, while the in-memory buffer above removes the per-line
      // syscall storm of the old appendFileSync path.
      fs.writeSync(this.tailFd!, payload);
      this.stats.linesWritten += lines.length;
    } catch {
      this.tailFd = null;
      this.recordWriteFailure(lines.length);
    }
  }

  private flushArchive(): void {
    if (this.archiveBuffer.length === 0) return;
    const today = this.now();
    const dayKey = today.toISOString().slice(0, 10);
    const requestedPath = this.archivePathForDate(today);
    if (requestedPath === null) {
      // Archive destination not bound yet (data dir unresolved): keep
      // buffering, bounded, exactly like the legacy pre-init buffer.
      if (this.archiveBuffer.length > this.maxArchiveBacklog) {
        const dropped = this.archiveBuffer.length - this.maxArchiveBacklog;
        this.archiveBuffer.splice(0, dropped);
        this.stats.failedWrites += dropped;
      }
      this.stats.bufferedLines = this.tailBuffer.length + this.archiveBuffer.length;
      return;
    }
    if (this.archiveOpenDayKey !== dayKey || this.archiveActivePath !== requestedPath) {
      this.closeArchiveFd();
      this.archiveOpenDayKey = dayKey;
      this.archiveActivePath = requestedPath;
      if (this.archiveOpenDayKey !== null && this.archiveActivePath !== null) {
        this.stats.archiveDayRolls += 1;
      }
    }
    const lines = this.archiveBuffer.splice(0);
    this.stats.bufferedLines = this.tailBuffer.length + this.archiveBuffer.length;
    try {
      this.ensureArchiveFd();
      if (this.archiveFd === null) throw new Error('archive fd unavailable');
      fs.writeSync(this.archiveFd, lines.join(''));
      this.stats.linesWritten += lines.length;
    } catch {
      this.archiveFd = null;
      this.recordWriteFailure(lines.length);
    }
  }

  private ensureTailFd(): void {
    if (this.tailFd !== null || this.tailLogPath === null) return;
    try {
      fs.mkdirSync(path.dirname(this.tailLogPath), { recursive: true });
      this.tailFd = fs.openSync(this.tailLogPath, 'a');
    } catch {
      this.tailFd = null;
    }
  }

  private ensureArchiveFd(): void {
    if (this.archiveFd !== null || this.archiveActivePath === null) return;
    try {
      fs.mkdirSync(path.dirname(this.archiveActivePath), { recursive: true });
      this.archiveFd = fs.openSync(this.archiveActivePath, 'a');
    } catch {
      this.archiveFd = null;
    }
  }

  private shouldRotateTail(incomingBytes: number): boolean {
    if (this.tailLogPath === null) return false;
    try {
      const current = fs.statSync(this.tailLogPath);
      return current.size + incomingBytes > this.maxTailFileBytes;
    } catch {
      return false; // File missing → fresh file, no rotation needed.
    }
  }

  private rotateTail(): void {
    if (this.tailLogPath === null) return;
    try {
      this.closeTailFd();
      const oldest = `${this.tailLogPath}.${this.tailRotationsToKeep}`;
      try {
        fs.unlinkSync(oldest);
      } catch {
        // Oldest rotation absent — fine.
      }
      for (let index = this.tailRotationsToKeep - 1; index >= 1; index -= 1) {
        const from = `${this.tailLogPath}.${index}`;
        const to = `${this.tailLogPath}.${index + 1}`;
        try {
          fs.renameSync(from, to);
        } catch {
          // Missing intermediate rotation — fine.
        }
      }
      fs.renameSync(this.tailLogPath, `${this.tailLogPath}.1`);
      this.stats.tailRotations += 1;
    } catch {
      // Rotation failure must not block logging; next open recreates the file.
    }
  }

  private closeTailFd(): void {
    if (this.tailFd !== null) {
      try {
        fs.closeSync(this.tailFd);
      } catch {
        // Already closed.
      }
      this.tailFd = null;
    }
  }

  private closeArchiveFd(): void {
    if (this.archiveFd !== null) {
      try {
        fs.closeSync(this.archiveFd);
      } catch {
        // Already closed.
      }
      this.archiveFd = null;
    }
  }

  private recordWriteFailure(droppedLines: number): void {
    this.stats.failedWrites += droppedLines;
    if (!this.reportedWriteFailure && this.originalConsole) {
      this.reportedWriteFailure = true;
      try {
        this.originalConsole.warn(
          `[MainProcessLogger] log destination unavailable — continuing without file logging (dropped=${this.stats.failedWrites})`,
        );
      } catch {
        // Even the fallback warn must never throw.
      }
    }
  }
}
