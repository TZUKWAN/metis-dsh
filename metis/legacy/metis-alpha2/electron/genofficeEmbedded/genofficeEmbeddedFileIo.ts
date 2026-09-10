import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Session-file IO for embedded GenOffice views. All compat handlers funnel
 * through here so the only writable paths are the per-token session files
 * owned by OutcomeExternalEditorService.
 */

export async function readEmbeddedSessionFile(filePath: string): Promise<Buffer> {
  return fsp.readFile(filePath);
}

/** Same durability contract as GenOffice's atomic write: temp file + rename. */
export async function writeEmbeddedSessionFile(filePath: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.embed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fsp.writeFile(temporary, bytes);
  await fsp.rename(temporary, filePath).catch(async (error) => {
    await fsp.rm(temporary, { force: true });
    throw error;
  });
}
