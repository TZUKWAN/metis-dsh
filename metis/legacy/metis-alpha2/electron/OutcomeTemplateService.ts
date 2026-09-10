import { randomUUID } from 'node:crypto';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import {
  OutcomeTemplateKindSchema,
  OutcomeTemplateSaveRequestSchema,
  OutcomeTemplateUpdateRequestSchema,
  WordFormattingTemplateDefinitionSchema,
  decodePptTemplateDefinition,
  outcomeTemplateRecordSchema,
  serializeOutcomeTemplateDefinition,
  type OutcomeTemplateKind,
  type OutcomeTemplateSaveRequest,
  type OutcomeTemplateUpdateRequest,
} from '../engine/runtime/OutcomeRuntimeContract.js';

export type OutcomeTemplateRecord = ReturnType<typeof outcomeTemplateRecordSchema.parse>;

type TemplateRow = {
  id: string;
  name: string;
  kind: string;
  definition_json: string;
  created_at: number;
  updated_at: number;
};

function parseDefinition(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('outcome_template_definition_invalid');
  return parsed as Record<string, unknown>;
}

export class OutcomeTemplateService {
  private readonly db: PersistenceStore['raw'];

  constructor(store: PersistenceStore) {
    this.db = store.raw;
  }

  private normalizeDefinition(kind: OutcomeTemplateKind, definition: Record<string, unknown>): Record<string, unknown> {
    if (kind === 'word_formatting') return WordFormattingTemplateDefinitionSchema.parse(definition);
    const decoded = decodePptTemplateDefinition(definition, '16:9');
    if (!decoded) throw new Error('outcome_template_ppt_definition_invalid');
    return decoded;
  }

  private decode(row: TemplateRow, expectedKind?: OutcomeTemplateKind): OutcomeTemplateRecord {
    const kind = OutcomeTemplateKindSchema.safeParse(row.kind);
    if (!kind.success || (expectedKind && kind.data !== expectedKind)) throw new Error('outcome_template_kind_invalid');
    const record = outcomeTemplateRecordSchema.parse({
      id: row.id,
      name: row.name,
      definition: this.normalizeDefinition(kind.data, parseDefinition(row.definition_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return record;
  }

  private row(id: string, kind: OutcomeTemplateKind): OutcomeTemplateRecord {
    const row = this.db.prepare(
      'SELECT id, name, kind, definition_json, created_at, updated_at FROM outcome_templates WHERE id = ? AND kind = ?',
    ).get(id, kind) as TemplateRow | undefined;
    if (!row) throw new Error('outcome_template_not_found');
    return this.decode(row, kind);
  }

  list(kind: OutcomeTemplateKind): OutcomeTemplateRecord[] {
    const parsedKind = OutcomeTemplateKindSchema.parse(kind);
    const rows = this.db.prepare(
      'SELECT id, name, kind, definition_json, created_at, updated_at FROM outcome_templates WHERE kind = ? ORDER BY updated_at DESC, created_at DESC',
    ).all(parsedKind) as TemplateRow[];
    return rows.flatMap((row) => {
      try { return [this.decode(row, parsedKind)]; } catch { return []; }
    });
  }

  save(request: OutcomeTemplateSaveRequest): OutcomeTemplateRecord;
  save(kind: OutcomeTemplateKind, name: string, definition: Record<string, unknown>): OutcomeTemplateRecord;
  save(
    requestOrKind: OutcomeTemplateSaveRequest | OutcomeTemplateKind,
    name?: string,
    definition?: Record<string, unknown>,
  ): OutcomeTemplateRecord {
    const request = typeof requestOrKind === 'string'
      ? { kind: requestOrKind, name: name ?? '', definition: definition ?? {} }
      : requestOrKind;
    const parsed = OutcomeTemplateSaveRequestSchema.parse(request);
    const normalizedDefinition = this.normalizeDefinition(parsed.kind, parsed.definition);
    const now = Date.now();
    const id = `outcome-template-${randomUUID()}`;
    this.db.prepare(
      'INSERT INTO outcome_templates (id, name, kind, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, parsed.name, parsed.kind, serializeOutcomeTemplateDefinition(normalizedDefinition), now, now);
    return this.row(id, parsed.kind);
  }

  update(request: OutcomeTemplateUpdateRequest): OutcomeTemplateRecord {
    const parsed = OutcomeTemplateUpdateRequestSchema.parse(request);
    const current = this.row(parsed.id, parsed.kind);
    const nextName = parsed.name ?? current.name;
    const nextDefinition = parsed.definition === undefined
      ? current.definition
      : this.normalizeDefinition(parsed.kind, parsed.definition);
    const now = Date.now();
    if (parsed.name !== undefined && parsed.definition !== undefined) {
      this.db.prepare('UPDATE outcome_templates SET name = ?, definition_json = ?, updated_at = ? WHERE id = ? AND kind = ?')
        .run(nextName, serializeOutcomeTemplateDefinition(nextDefinition), now, parsed.id, parsed.kind);
    } else if (parsed.name !== undefined) {
      this.db.prepare('UPDATE outcome_templates SET name = ?, updated_at = ? WHERE id = ? AND kind = ?')
        .run(nextName, now, parsed.id, parsed.kind);
    } else {
      this.db.prepare('UPDATE outcome_templates SET definition_json = ?, updated_at = ? WHERE id = ? AND kind = ?')
        .run(serializeOutcomeTemplateDefinition(nextDefinition), now, parsed.id, parsed.kind);
    }
    return this.row(parsed.id, parsed.kind);
  }

  delete(request: { id: string; kind: OutcomeTemplateKind }): void {
    const kind = OutcomeTemplateKindSchema.parse(request.kind);
    const id = outcomeTemplateRecordSchema.shape.id.parse(request.id);
    const exists = this.db.prepare('SELECT 1 FROM outcome_templates WHERE id = ? AND kind = ?').get(id, kind);
    if (!exists) throw new Error('outcome_template_not_found');
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM outcome_default_templates WHERE kind = ? AND template_id = ?').run(kind, id);
      const result = this.db.prepare('DELETE FROM outcome_templates WHERE id = ? AND kind = ?').run(id, kind);
      if (result.changes !== 1) throw new Error('outcome_template_delete_failed');
    });
    remove();
  }

  getDefault(kind: OutcomeTemplateKind): OutcomeTemplateRecord | null {
    const parsedKind = OutcomeTemplateKindSchema.parse(kind);
    const row = this.db.prepare(
      `SELECT t.id, t.name, t.kind, t.definition_json, t.created_at, t.updated_at
       FROM outcome_default_templates d
       JOIN outcome_templates t ON t.id = d.template_id AND t.kind = d.kind
       WHERE d.kind = ?`,
    ).get(parsedKind) as TemplateRow | undefined;
    if (!row) return null;
    try { return this.decode(row, parsedKind); } catch { return null; }
  }

  setDefault(kind: OutcomeTemplateKind, templateId: string | null): OutcomeTemplateRecord | null {
    const parsedKind = OutcomeTemplateKindSchema.parse(kind);
    if (templateId === null) {
      this.db.prepare('DELETE FROM outcome_default_templates WHERE kind = ?').run(parsedKind);
      return null;
    }
    const selected = this.row(templateId, parsedKind);
    this.db.prepare(
      `INSERT INTO outcome_default_templates (kind, template_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET template_id = excluded.template_id, updated_at = excluded.updated_at`,
    ).run(parsedKind, selected.id, Date.now());
    return selected;
  }
}
