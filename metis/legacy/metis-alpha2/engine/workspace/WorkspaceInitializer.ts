/**
 * Workspace Initializer — scaffold a structured research project layout.
 *
 * Generates a standard directory tree plus a `research-state.yaml` manifest so
 * a new or resumed research project has a consistent place for literature,
 * experiments, notes, data, figures, and manuscripts. Inspired by
 * WenyuChiou/ai-research-skills' structured workspace templates and
 * Orchestra-Research/AI-Research-SKILLs' `research-state.yaml`.
 *
 * The manifest is intentionally simple YAML (no external parser dependency):
 * key: value pairs and a top-level list. It can be read back later to recover
 * the project shape across sessions.
 *
 * Added round 310.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceLayout {
  root: string;
  directories: string[];
  manifestPath: string;
  manifestWritten: boolean;
  alreadyInitialized: boolean;
}

export interface WorkspaceInitOptions {
  /** Absolute root directory for the project. Required. */
  root: string;
  /** Project name written into the manifest. */
  projectName?: string;
  /** Research question written into the manifest. */
  researchQuestion?: string;
  /** Extra directories to create beyond the defaults. */
  extraDirectories?: string[];
  /** If false (default), refuse to overwrite an existing research-state.yaml. */
  force?: boolean;
}

export const DEFAULT_DIRECTORIES = [
  'literature',
  'experiments',
  'notes',
  'data',
  'figures',
  'manuscripts',
] as const;

const MANIFEST_FILENAME = 'research-state.yaml';

/**
 * Render a minimal YAML manifest without a YAML library.
 * Values are escaped so a stray colon or newline cannot corrupt the file.
 */
export function renderManifest(options: {
  projectName?: string;
  researchQuestion?: string;
  createdAt: number;
}): string {
  const created = new Date(options.createdAt).toISOString();
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    '# Metis research workspace manifest.',
    '# Edit freely; workspace_init will not overwrite this file unless force=true.',
    `created_at: "${created}"`,
    `updated_at: "${created}"`,
  ];
  if (options.projectName) {
    lines.push(`project_name: "${esc(options.projectName)}"`);
  }
  if (options.researchQuestion) {
    lines.push(`research_question: "${esc(options.researchQuestion)}"`);
  }
  lines.push(
    'status: "init"',
    'milestones: []',
    '',
    '# Standard directories (created by workspace_init):',
    '#   literature/    - PDFs, BibTeX, reading notes per paper',
    '#   experiments/   - scripts, configs, result snapshots',
    '#   notes/         - free-form research notes',
    '#   data/          - datasets and intermediate artifacts',
    '#   figures/       - plots and figures for the manuscript',
    '#   manuscripts/   - LaTeX / Markdown drafts',
    '',
    '# Findings log: append concise factual findings as you discover them.',
    'findings: []',
    '',
  );
  return lines.join('\n');
}

/**
 * Initialize a structured research workspace at the given root.
 * Creates the standard directories and writes a research-state.yaml manifest
 * unless one already exists (override with force).
 */
export async function initWorkspace(options: WorkspaceInitOptions): Promise<WorkspaceLayout> {
  if (!options.root || !path.isAbsolute(options.root)) {
    throw new Error(`root must be an absolute path (got "${options.root}")`);
  }

  const manifestPath = path.join(options.root, MANIFEST_FILENAME);
  const alreadyInitialized = fsSync.existsSync(manifestPath);
  if (alreadyInitialized && !options.force) {
    // Return a layout describing the existing state without touching anything.
    const directories = DEFAULT_DIRECTORIES.map((d) => path.join(options.root, d));
    return {
      root: options.root,
      directories,
      manifestPath,
      manifestWritten: false,
      alreadyInitialized: true,
    };
  }

  const allDirs = [...DEFAULT_DIRECTORIES, ...(options.extraDirectories ?? [])];
  const directories: string[] = [];
  for (const dir of allDirs) {
    const full = path.join(options.root, dir);
    await fs.mkdir(full, { recursive: true });
    directories.push(full);
  }

  const manifestContent = renderManifest({
    projectName: options.projectName,
    researchQuestion: options.researchQuestion,
    createdAt: Date.now(),
  });
  await fs.mkdir(options.root, { recursive: true });
  await fs.writeFile(manifestPath, manifestContent, 'utf-8');

  // Drop a .gitkeep in each directory so the structure survives in git even
  // before any real content lands there.
  for (const dir of directories) {
    const keep = path.join(dir, '.gitkeep');
    try {
      await fs.writeFile(keep, '', 'utf-8');
    } catch {
      // Non-fatal: the directory itself is the important part.
    }
  }

  return {
    root: options.root,
    directories,
    manifestPath,
    manifestWritten: true,
    alreadyInitialized: false,
  };
}

/**
 * Read a previously written research-state.yaml manifest as a plain object.
 * Returns null if the file does not exist. Uses a minimal line-based parser
 * that supports `key: "value"` pairs and ignores comments / blank lines.
 */
export async function readWorkspaceManifest(
  root: string,
): Promise<Record<string, unknown> | null> {
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const out: Record<string, unknown> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf(':');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value: string = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value === '[]') {
        out[key] = [];
      } else {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return null;
  }
}
