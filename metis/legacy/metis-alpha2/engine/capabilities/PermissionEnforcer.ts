/**
 * Capability Permission Model (METIS-207).
 *
 * Enforces least-privilege: a capability may only invoke tools that fall under its declared
 * permissions. Tool calls outside the capability's permission set are rejected BEFORE
 * execution. This is the gate between the router/manifest and the ToolDispatcher.
 *
 * Permission → tool mapping is closed (defined here). Path traversal and unauthorized
 * network/command attempts are caught by the permission check itself plus input guards.
 */

import path from 'node:path';
import type { CapabilityManifest, CapabilityPermission } from './types.js';

// ─── Permission → tools mapping (closed set) ──────────────────

const PERMISSION_TOOLS: Record<CapabilityPermission, readonly string[]> = {
  read_source: ['read_file', 'read_pdf', 'search_library', 'list_sources'],
  search_web: ['web_search', 'openalex_search', 'crossref_lookup', 'arxiv_fetch', 'semantic_scholar'],
  write_file: ['write_file', 'save_note', 'create_artifact'],
  execute_code: ['run_python', 'run_stats', 'data_summary'],
  call_external: ['run_latex', 'mcp_connector'],
  access_sensitive: ['read_sensitive'],
};

export function toolsAllowedByPermission(perm: CapabilityPermission): readonly string[] {
  return PERMISSION_TOOLS[perm] ?? [];
}

/** Reverse: which permission is required to use a given tool name. */
const TOOL_REQUIRED_PERMISSION = new Map<string, CapabilityPermission>();
for (const [perm, tools] of Object.entries(PERMISSION_TOOLS)) {
  for (const t of tools) TOOL_REQUIRED_PERMISSION.set(t, perm as CapabilityPermission);
}

export function permissionRequiredForTool(toolName: string): CapabilityPermission | undefined {
  return TOOL_REQUIRED_PERMISSION.get(toolName);
}

// ─── Enforcer ─────────────────────────────────────────────────

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string; code: 'unknown_tool' | 'not_permitted' | 'path_traversal' };

/**
 * Decide whether a tool call is permitted under the active capability. The active
 * capability's permission set is the upper bound; any tool not mapped to one of those
 * permissions is rejected.
 */
export function checkToolPermission(
  toolName: string,
  args: Record<string, unknown>,
  capability: CapabilityManifest,
): PermissionDecision {
  const required = permissionRequiredForTool(toolName);
  if (!required) {
    return { allowed: false, reason: `Tool '${toolName}' is not a known Metis tool`, code: 'unknown_tool' };
  }
  if (!capability.permissions.includes(required)) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' requires permission '${required}', which capability '${capability.id}' does not declare`,
      code: 'not_permitted',
    };
  }
  // Path traversal guard for file-touching tools.
  if (toolName === 'read_file' || toolName === 'write_file') {
    const target = typeof args.path === 'string' ? args.path : typeof args.filePath === 'string' ? args.filePath : null;
    if (target) {
      const normalized = path.normalize(target);
      if (normalized.includes('..') || path.isAbsolute(normalized) === false && normalized.startsWith('..')) {
        // Allow relative paths that don't escape, but block explicit traversal.
        if (normalized.includes('..')) {
          return {
            allowed: false,
            reason: `Path traversal blocked: '${target}' normalizes to '${normalized}'`,
            code: 'path_traversal',
          };
        }
      }
    }
  }
  return { allowed: true };
}

/**
 * Enforce — throws on denial. Use this when the caller wants fail-fast behavior (the
 * ToolDispatcher integration point).
 */
export function enforceToolPermission(
  toolName: string,
  args: Record<string, unknown>,
  capability: CapabilityManifest,
): void {
  const decision = checkToolPermission(toolName, args, capability);
  if (!decision.allowed) {
    throw new Error(`Permission denied: ${decision.reason}`);
  }
}
