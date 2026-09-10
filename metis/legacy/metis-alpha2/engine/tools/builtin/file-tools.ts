/**
 * Built-in file operation tools.
 *
 * Ported from metis/tools/builtin.py file tools section.
 * Includes path sandboxing to prevent directory traversal attacks.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

// ─── Path Sandbox ──────────────────────────────────────────────

/** Configurable allowed root directories for file operations. */
let allowedRoots: string[] = [process.cwd()];

/**
 * Configure which root directories file tools are allowed to access.
 * All file paths are resolved and checked against these roots.
 */
export function configureFileSandbox(roots: string[]): void {
  allowedRoots = roots.map((r) => path.resolve(r));
}

/**
 * Validate that a resolved path is within the allowed sandbox roots.
 * Throws if the path escapes the sandbox (directory traversal).
 */
function validatePath(resolvedPath: string): void {
  const normalized = path.normalize(resolvedPath);
  const isAllowed = allowedRoots.some((root) => {
    const rel = path.relative(root, normalized);
    // path.relative returns something starting with '..' if outside root
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!isAllowed) {
    throw new Error(
      `Path traversal blocked: '${resolvedPath}' is outside allowed roots [${allowedRoots.join(', ')}]`,
    );
  }
}

/** Resolve and validate a file path argument, following symlinks to prevent traversal bypass. */
function resolveAndValidate(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  // SECURITY: Resolve symlinks to prevent symlink-based directory traversal bypass
  let realPath: string;
  try {
    realPath = fsSync.realpathSync(resolved);
  } catch {
    // If the path doesn't exist yet (e.g., write_file), validate the resolved path directly
    realPath = resolved;
  }
  validatePath(realPath);
  return realPath;
}

// ─── Tool Specs ───────────────────────────────────────────────

export const readFileSpec: ToolSpec = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      encoding: { type: 'string', description: 'File encoding', default: 'utf-8' },
    },
    required: ['path'],
  },
};

export const writeFileSpec: ToolSpec = {
  name: 'write_file',
  description: 'Write content to a file, creating it if it does not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
};

export const listDirectorySpec: ToolSpec = {
  name: 'list_directory',
  description: 'List files and directories at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
};

export const createDirectorySpec: ToolSpec = {
  name: 'create_directory',
  description: 'Create a directory and all parent directories.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to create' },
    },
    required: ['path'],
  },
};

// ─── Tool Handlers ────────────────────────────────────────────

export const readFileHandler: ToolHandler = async (args) => {
  const filePath = resolveAndValidate(String(args.path));
  const encoding = String(args.encoding ?? 'utf-8');
  const content = await fs.readFile(filePath, { encoding: encoding as BufferEncoding });
  return content;
};

export const writeFileHandler: ToolHandler = async (args) => {
  const filePath = resolveAndValidate(String(args.path));
  const content = String(args.content);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return `Successfully wrote ${content.length} bytes to ${filePath}`;
};

export const listDirectoryHandler: ToolHandler = async (args) => {
  const dirPath = resolveAndValidate(String(args.path));
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
    .join('\n');
};

export const createDirectoryHandler: ToolHandler = async (args) => {
  const dirPath = resolveAndValidate(String(args.path));
  await fs.mkdir(dirPath, { recursive: true });
  return `Created directory: ${dirPath}`;
};

// ─── Registration Helper ──────────────────────────────────────

export function getFileToolSpecs(): ToolSpec[] {
  return [readFileSpec, writeFileSpec, listDirectorySpec, createDirectorySpec];
}

export function getFileToolHandlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set('read_file', readFileHandler);
  map.set('write_file', writeFileHandler);
  map.set('list_directory', listDirectoryHandler);
  map.set('create_directory', createDirectoryHandler);
  return map;
}
