/**
 * ResearchInspector context resolver (METIS-504).
 *
 * Decides which inspector tab + content to show based on what the user selected in the
 * center workspace. Selecting a PDF paragraph → evidence tab; a chart data point → evidence;
 * a Claim → properties (claim details); a manuscript paragraph → properties.
 *
 * Supports PINNING: the user can pin the current inspector context so it stays put while
 * they navigate the center (METIS-504: "supports pin and unpin").
 */

import type { InspectorTab } from './ProjectShell.js';

export type SelectionKind = 'pdf_paragraph' | 'chart_datapoint' | 'claim' | 'manuscript_paragraph' | 'source' | 'note' | 'artifact' | 'none';

export interface SelectionContext {
  kind: SelectionKind;
  id: string | null;
  label?: string;
}

export interface InspectorResolution {
  tab: InspectorTab;
  pinned: boolean;
  reason: string;
}

/**
 * Resolve which inspector tab to surface for a given center selection. If the user pinned
 * a tab, the pin wins (until they unpin).
 */
export function resolveInspectorTab(
  selection: SelectionContext,
  pinned: InspectorTab | null,
): InspectorResolution {
  if (pinned) {
    return { tab: pinned, pinned: true, reason: '检查器已固定，保持当前视图。' };
  }
  switch (selection.kind) {
    case 'pdf_paragraph':
    case 'chart_datapoint':
      return { tab: 'evidence', pinned: false, reason: '选中了原文/数据点，显示证据视图。' };
    case 'claim':
      return { tab: 'properties', pinned: false, reason: '选中了论断，显示论断属性。' };
    case 'manuscript_paragraph':
      return { tab: 'properties', pinned: false, reason: '选中了文稿段落，显示段落属性。' };
    case 'source':
    case 'note':
    case 'artifact':
      return { tab: 'properties', pinned: false, reason: '选中了资料/笔记/成果，显示其属性。' };
    case 'none':
    default:
      return { tab: 'metis', pinned: false, reason: '无选中对象，默认显示 Metis 对话。' };
  }
}

/** Whether a selection should let the user "ask Metis about this" (bridge to METIS-605). */
export function canAskMetisAbout(selection: SelectionContext): boolean {
  return selection.kind !== 'none' && selection.id !== null;
}
