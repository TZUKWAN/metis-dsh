/**
 * Built-in search tools.
 *
 * SECURITY: All path operations are sandboxed to allowed directories.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';

// Allowed directories for search operations (can be configured)
const ALLOWED_SEARCH_DIRS: string[] = [];

function isPathAllowed(targetPath: string): boolean {
  const resolved = nodePath.resolve(targetPath);
  // If no allowed dirs configured, default to cwd
  if (ALLOWED_SEARCH_DIRS.length === 0) {
    const cwd = nodePath.resolve(process.cwd());
    return resolved === cwd || resolved.startsWith(cwd + nodePath.sep);
  }
  return ALLOWED_SEARCH_DIRS.some((dir) => {
    const d = nodePath.resolve(dir);
    return resolved === d || resolved.startsWith(d + nodePath.sep);
  });
}

function sanitizePath(input: string): string {
  const normalized = nodePath.normalize(String(input));
  if (normalized.includes('..')) {
    throw new Error('Access denied: path contains traversal');
  }
  return normalized;
}

export const searchFilesSpec: ToolSpec = {
  name: 'search_files',
  description: 'Search for files matching a glob pattern within allowed directories.',
  parameters: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Directory to search in' },
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
    },
    required: ['directory', 'pattern'],
  },
};

export const searchContentSpec: ToolSpec = {
  name: 'search_content',
  description: 'Search for text content in files within allowed directories.',
  parameters: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Directory to search in' },
      query: { type: 'string', description: 'Text to search for' },
      filePattern: { type: 'string', description: 'File pattern to include', default: '*' },
    },
    required: ['directory', 'query'],
  },
};

export const readMultipleFilesSpec: ToolSpec = {
  name: 'read_multiple_files',
  description: 'Read multiple files at once from allowed directories.',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'List of file paths' },
    },
    required: ['paths'],
  },
};

function escapeGlobToRegex(pattern: string): string {
  // Escape all regex metacharacters except * and ?
  let escaped = '';
  for (const ch of pattern) {
    if (ch === '*') escaped += '.*';
    else if (ch === '?') escaped += '.';
    else if ('.+^${}()|[]\\'.includes(ch)) escaped += '\\' + ch;
    else escaped += ch;
  }
  return '^' + escaped + '$';
}

export const searchFilesHandler: ToolHandler = async (args) => {
  const dir = sanitizePath(String(args.directory));
  if (!isPathAllowed(dir)) {
    throw new Error('Access denied: directory outside allowed paths');
  }
  const pattern = String(args.pattern);
  const globRegex = new RegExp(escapeGlobToRegex(pattern));

  const results: string[] = [];
  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        }
      } else if (globRegex.test(entry.name)) {
        results.push(nodePath.relative(dir, fullPath));
      }
    }
  }
  await walk(dir);
  return results.join('\n') || 'No files found';
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
}

export const searchContentHandler: ToolHandler = async (args) => {
  const dir = sanitizePath(String(args.directory));
  if (!isPathAllowed(dir)) {
    throw new Error('Access denied: directory outside allowed paths');
  }
  const query = String(args.query ?? '');
  const results: string[] = [];
  const escapedQuery = escapeRegex(query);
  const regex = new RegExp(escapedQuery, 'gi');

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        }
      } else {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (regex.test(line)) {
              results.push(`${nodePath.relative(dir, fullPath)}:${i + 1}: ${line.trim()}`);
            }
            regex.lastIndex = 0;
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }
  await walk(dir);
  return results.slice(0, 100).join('\n') || 'No matches found';
};

export const readMultipleFilesHandler: ToolHandler = async (args) => {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  const results: string[] = [];
  for (const p of paths) {
    const sanitized = sanitizePath(String(p));
    if (!isPathAllowed(sanitized)) {
      results.push(`=== ${p} ===\n[Error: Access denied: path outside allowed directories]`);
      continue;
    }
    try {
      const content = await fs.readFile(nodePath.resolve(sanitized), 'utf-8');
      results.push(`=== ${p} ===\n${content}`);
    } catch (err) {
      results.push(`=== ${p} ===\n[Error: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }
  return results.join('\n\n');
};

export function getSearchToolSpecs(): ToolSpec[] {
  return [searchFilesSpec, searchContentSpec, readMultipleFilesSpec];
}

export function getSearchToolHandlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set('search_files', searchFilesHandler);
  map.set('search_content', searchContentHandler);
  map.set('read_multiple_files', readMultipleFilesHandler);
  return map;
}
