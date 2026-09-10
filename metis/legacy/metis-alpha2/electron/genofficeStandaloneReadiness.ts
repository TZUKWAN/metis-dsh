import path from 'node:path';
import type { ExternalEditorKind } from './OutcomeExternalEditorService.js';

export function readinessExpressionFor(kind: ExternalEditorKind, fileName: string): string {
  const name = JSON.stringify(path.basename(fileName));
  if (kind === 'word') return `document.title === ${name} && !!document.querySelector('.editor-scroll .ProseMirror')`;
  if (kind === 'ppt') return `!!document.querySelector('.stage-wrap') && !!document.querySelector('.slide-list') && document.querySelectorAll('.slide-list > *').length > 0`;
  if (kind === 'spreadsheet') return `!!document.querySelector('#univer-container') && /工作簿已完整加载|Workbook fully loaded|ブックを完全に読み込みました|ワークブック.*完全/u.test(document.querySelector('.workbook-status')?.textContent ?? '')`;
  return `document.querySelectorAll('.pdf-page-content').length > 0`;
}
