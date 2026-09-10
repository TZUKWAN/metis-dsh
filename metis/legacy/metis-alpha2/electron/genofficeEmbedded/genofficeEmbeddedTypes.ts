import type { ExternalEditorKind } from '../OutcomeExternalEditorService.js';

export type EmbeddedGenofficeKind = ExternalEditorKind;

export interface EmbeddedOpenPayload {
  path: string;
  name: string;
  data: ArrayBuffer;
  hash: string;
}

/** Per-view embedded session: one GenOffice editor living inside METIS's window. */
export interface EmbeddedViewSession {
  token: string;
  kind: EmbeddedGenofficeKind;
  projectId: string;
  outcomeId: string;
  /** Session file this view edits; owned by OutcomeExternalEditorService. */
  filePath: string;
  fileName: string;
  viewId: number;
  partition: string;
}

export function appSubdirFor(kind: EmbeddedGenofficeKind): string {
  return kind === 'word'
    ? 'docs'
    : kind === 'ppt'
      ? 'slides'
      : kind === 'spreadsheet'
        ? 'sheets'
        : 'pdf';
}
