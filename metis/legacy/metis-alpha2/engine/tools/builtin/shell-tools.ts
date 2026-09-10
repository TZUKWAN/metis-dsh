/**
 * Built-in shell command tool (WSL/sandbox removed).
 *
 * Commands execute locally via execFile against a whitelist of safe binaries
 * (Python/Node/LaTeX/LibreOffice/pandoc etc.). Dangerous shell metacharacters
 * are filtered as a defense layer.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { execFile } from 'node:child_process';

// ─── Whitelist ─────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set([
  'git', 'python', 'python3', 'node', 'npm', 'npx', 'cat', 'ls', 'dir',
  'echo', 'pwd', 'cd', 'find', 'grep', 'wc', 'head', 'tail', 'sort',
  'uniq', 'diff', 'file', 'stat', 'date', 'which', 'where',
  'pdflatex', 'xelatex', 'lualatex', 'bibtex',
  'libreoffice', 'pandoc',
  'pip', 'pip3', 'cargo', 'go', 'make', 'cmake',
]);

const MAX_TIMEOUT_SECONDS = 300;

// ─── Tool spec ─────────────────────────────────────────────

export const executeCommandSpec: ToolSpec = {
  name: 'execute_command',
  description: 'Execute a whitelisted shell command locally (Python, Node, LaTeX, LibreOffice, etc.).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments', default: [] },
      timeout: { type: 'number', description: 'Timeout in seconds (max 300)', default: 30 },
      cwd: { type: 'string', description: 'Working directory', default: '.' },
    },
    required: ['command'],
  },
};

// ─── Handler ───────────────────────────────────────────────

export const executeCommandHandler: ToolHandler = async (args) => {
  const command = String(args.command ?? '');
  const timeoutSec = Math.min(Number(args.timeout ?? 30), MAX_TIMEOUT_SECONDS);
  const timeout = Math.max(1000, timeoutSec * 1000);
  const cwd = String(args.cwd ?? '.');

  if (!command.trim()) {
    throw new Error('Empty command');
  }

  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];

  const baseName = getCommandBaseName(command);
  if (!baseName || !ALLOWED_COMMANDS.has(baseName)) {
    throw new Error(`Command '${baseName || command}' is not in the whitelist. Allowed: ${[...ALLOWED_COMMANDS].sort().join(', ')}`);
  }

  return new Promise((resolve, reject) => {
    execFile(baseName, cmdArgs, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Command failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join('\n');
      resolve(output || '(no output)');
    });
  });
};

// ─── Helpers ───────────────────────────────────────────────

function getCommandBaseName(cmd: string): string {
  const trimmed = cmd.trim();
  const dangerousChars = /[;|&$`\\{}()[\]<>!]/;
  if (dangerousChars.test(trimmed)) {
    return '';
  }
  const firstWord = trimmed.split(/\s+/)[0];
  if (!firstWord) return '';
  return firstWord.replace(/^.*[/\\]/, '');
}

// ─── Registration ──────────────────────────────────────────

export function getShellToolSpecs(): ToolSpec[] {
  return [executeCommandSpec];
}

export function getShellToolHandlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set('execute_command', executeCommandHandler);
  return map;
}
