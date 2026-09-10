import type { ExternalEditorKind } from './OutcomeExternalEditorService.js';

export function needsPdfStandaloneCompatibility(kind: ExternalEditorKind): boolean {
  return kind === 'pdf';
}
