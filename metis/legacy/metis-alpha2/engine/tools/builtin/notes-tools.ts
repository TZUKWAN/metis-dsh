/**
 * notes-tools — 研究笔记类型化（T28）。
 *
 * 四类知识卡 + 转写稿：文献卡（literature）/方法卡（method）/理论卡（theory）
 * /灵感卡（insight）/转写稿（transcript，T23 ASR 产物入笔记）。
 * 类型写入 tags['type:X']，与既有 notes 表兼容（零迁移）。全部确定性存取。
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { sharedStore } from '../../persistence/PersistenceStore.js';

export const NOTE_TYPES = ['literature', 'method', 'theory', 'insight', 'transcript'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  literature: '文献卡',
  method: '方法卡',
  theory: '理论卡',
  insight: '灵感卡',
  transcript: '转写稿',
};

export const NOTES_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'create_typed_note',
    description: `Create a typed research note. Types: ${NOTE_TYPES.join(' | ')} (文献卡=reading takeaways tied to a paper; 方法卡=method how-to & pitfalls; 理论卡=theory summary & applicability; 灵感卡=ideas & questions; 转写稿=interview transcripts). Use during reading/coding/analysis to accumulate the project knowledge base.`,
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `One of: ${NOTE_TYPES.join('|')}` },
        title: { type: 'string' },
        content: { type: 'string' },
        linkedPaperIds: { type: 'array', items: { type: 'string' }, description: 'Related library paper ids (文献卡必填).' },
      },
      required: ['type', 'title', 'content'],
    },
  },
  {
    name: 'list_typed_notes',
    description: 'List typed research notes for the active project (optionally filtered by type).',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Optional filter: ${NOTE_TYPES.join('|')}` },
      },
    },
  },
];

function normalizeType(raw: unknown): NoteType | null {
  return NOTE_TYPES.includes(raw as NoteType) ? (raw as NoteType) : null;
}

export function getNotesToolHandlers(): Map<string, ToolHandler> {
  const createTypedNote: ToolHandler = async (args, context) => {
    if (!sharedStore) return 'Error: store unavailable.';
    const type = normalizeType(args.type);
    const title = String(args.title ?? '').trim().slice(0, 200);
    const content = String(args.content ?? '').trim().slice(0, 20_000);
    if (!type || !title || !content) {
      return `Error: type (${NOTE_TYPES.join('|')}), title and content are required.`;
    }
    const projectId = typeof (context as { projectId?: unknown }).projectId === 'string'
      ? (context as { projectId: string }).projectId
      : undefined;
    if (!projectId) return 'Error: typed notes require an active research project.';
    const linkedPaperIds = Array.isArray(args.linkedPaperIds)
      ? (args.linkedPaperIds as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 30)
      : [];
    if (type === 'literature' && linkedPaperIds.length === 0) {
      return 'Error: 文献卡必须 linkedPaperIds（挂到具体文献）。';
    }
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sharedStore.saveNote({
      id,
      title: `[${NOTE_TYPE_LABELS[type]}] ${title}`,
      content,
      tags: [`type:${type}`],
      linkedPaperIds,
      linkedNoteIds: [],
      updatedAt: Date.now(),
      scope: 'research',
      projectId,
    });
    return JSON.stringify({ ok: true, noteId: id, type, linkedPapers: linkedPaperIds.length });
  };

  const listTypedNotes: ToolHandler = async (args, context) => {
    if (!sharedStore) return 'Error: store unavailable.';
    const projectId = typeof (context as { projectId?: unknown }).projectId === 'string'
      ? (context as { projectId: string }).projectId
      : undefined;
    if (!projectId) return 'Error: requires an active research project.';
    const typeFilter = normalizeType(args.type);
    const rows = sharedStore.raw.prepare(
      'SELECT id, title, tags, updated_at FROM notes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100',
    ).all(projectId) as Array<{ id: string; title: string; tags: string; updated_at: number }>;
    const notes = rows
      .map((row) => {
        let tags: string[] = [];
        try { tags = JSON.parse(row.tags) as string[]; } catch { /* 忽略脏 tags */ }
        return { id: row.id, title: row.title, tags, updatedAt: row.updated_at };
      })
      .filter((note) => note.tags.some((tag) => tag.startsWith('type:')))
      .map((note) => ({
        id: note.id,
        title: note.title,
        type: note.tags.find((tag) => tag.startsWith('type:'))!.slice('type:'.length),
        updatedAt: note.updatedAt,
      }))
      .filter((note) => !typeFilter || note.type === typeFilter);
    return JSON.stringify({ projectId, total: notes.length, notes });
  };

  return new Map<string, ToolHandler>([
    ['create_typed_note', createTypedNote],
    ['list_typed_notes', listTypedNotes],
  ]);
}
