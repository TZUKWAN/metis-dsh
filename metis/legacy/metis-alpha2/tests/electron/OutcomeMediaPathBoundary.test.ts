import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeMediaService } from '../../electron/OutcomeMediaService.js';

describe('OutcomeMediaService managed path boundary', () => {
  let db: Database.Database;
  let root: string;
  let media: OutcomeMediaService;
  let outcomeId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-outcome-media-boundary-'));
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('project-a', 'project-a', '', '', 'active', '', '', '{}', 1, 1, 1, 'user');
    outcomeId = new OutcomeRepository(db).create({
      projectId: 'project-a', categoryId: null, title: 'SVG boundary', kind: 'image',
      content: { type: 'other', text: '', media: null }, note: '',
    }).outcome.id;
    media = new OutcomeMediaService(db, path.join(root, 'managed'));
  });

  afterEach(async () => {
    db?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects traversal and drive-relative stored names without reading or deleting outside files', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
    const imported = await media.persistGenerated('project-a', outcomeId, svg, 'image/svg+xml', 'figure.svg');
    expect(imported).toBeTruthy();
    const outside = path.join(root, 'outside.svg');
    await fs.writeFile(outside, svg);
    const update = db.prepare('UPDATE outcome_media SET stored_name = ? WHERE id = ?');

    for (const storedName of ['../outside.svg', 'C:outside.svg']) {
      update.run(storedName, imported!.id);
      expect(await media.readDataUrl('project-a', outcomeId, imported!.id)).toBeUndefined();
      await media.removeGenerated('project-a', outcomeId, [imported!.id]);
      expect(await fs.readFile(outside)).toEqual(svg);
      expect((db.prepare('SELECT count(*) AS n FROM outcome_media WHERE id = ?').get(imported!.id) as { n: number }).n).toBe(1);
    }
  });
});
