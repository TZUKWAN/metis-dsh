import { createHash } from 'node:crypto';

/** Node-only SHA-256 helper for the main-process workspace AGENTS store. */
export function hashWorkspaceAgentsContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
