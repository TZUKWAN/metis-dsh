/**
 * Note Manager — manages research notes with tagging and linking.
 */

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  linkedPaperIds: string[];
  linkedNoteIds: string[];
  createdAt: number;
  updatedAt: number;
}

export class NoteManager {
  private readonly notes = new Map<string, Note>();

  /** Create or update a note. */
  save(note: Omit<Note, 'createdAt' | 'updatedAt'>): Note {
    const existing = this.notes.get(note.id);
    const now = Date.now();
    const entry: Note = {
      ...note,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.notes.set(note.id, entry);
    return entry;
  }

  /** Get a note by ID. */
  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  /** Delete a note and clean up cross-references. */
  delete(id: string): boolean {
    // Remove from linked notes
    for (const note of this.notes.values()) {
      note.linkedNoteIds = note.linkedNoteIds.filter((lid) => lid !== id);
    }
    return this.notes.delete(id);
  }

  /** Search notes by title, content, or tags. */
  search(query: string): Note[] {
    const lower = query.toLowerCase();
    return [...this.notes.values()].filter((n) =>
      n.title.toLowerCase().includes(lower) ||
      n.content.toLowerCase().includes(lower) ||
      n.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /** Get notes by tag. */
  getByTag(tag: string): Note[] {
    return [...this.notes.values()].filter((n) => n.tags.includes(tag));
  }

  /** Get notes linked to a paper. */
  getByPaper(paperId: string): Note[] {
    return [...this.notes.values()].filter((n) => n.linkedPaperIds.includes(paperId));
  }

  /** Link two notes bidirectionally. */
  linkNotes(idA: string, idB: string): boolean {
    const a = this.notes.get(idA);
    const b = this.notes.get(idB);
    if (!a || !b) return false;
    if (!a.linkedNoteIds.includes(idB)) a.linkedNoteIds.push(idB);
    if (!b.linkedNoteIds.includes(idA)) b.linkedNoteIds.push(idA);
    return true;
  }

  list(): Note[] {
    return [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get count(): number { return this.notes.size; }
}
