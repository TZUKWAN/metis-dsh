/**
 * CurrentAffairsPreview — renderer-safe pure display functions.
 *
 * NO node:crypto, NO node:fs, NO Node builtins.
 * Safe for Vite browser bundle. Import from here in renderer code.
 */
import type { CurrentAffairsManifest } from './CurrentAffairsProfile.js';
import type { CurrentAffairsWorkflowState } from './CurrentAffairsWorkflow.js';

export interface ExportPreview {
  title: string;
  summary: string;
  sections: ExportSection[];
  sourceCount: number;
  factCount: number;
  timestamp: number;
  exportReady: boolean;
}

export interface ExportSection {
  heading: string;
  content: string;
}

export function buildExportPreview(
  manifest: CurrentAffairsManifest,
  state: CurrentAffairsWorkflowState,
): ExportPreview {
  const sections: ExportSection[] = [];

  sections.push({ heading: '一、研究概述', content: manifest.title });

  sections.push({
    heading: '二、来源核验',
    content: manifest.sources
      .map((s) => {
        const verified = state.verifiedSourceIds.includes(s.sourceId) ? '✓' : '✗';
        const retracted = s.correctionState !== 'clean' ? ` [${s.correctionState}]` : '';
        return `${verified} ${s.title} (${s.kind})${retracted}`;
      })
      .join('\n'),
  });

  if (manifest.facts && manifest.facts.length > 0) {
    sections.push({
      heading: '三、事实陈述',
      content: manifest.facts.map((f) => `- ${f.statement}`).join('\n'),
    });
  }

  if (manifest.stances && manifest.stances.length > 0) {
    sections.push({
      heading: '四、立场分析',
      content: manifest.stances.map((s) => `[${s.stance}] ${s.rationale}`).join('\n'),
    });
  }

  if (manifest.interpretations && manifest.interpretations.length > 0) {
    sections.push({
      heading: '五、综合解读',
      content: manifest.interpretations.map((i) => i.interpretation).join('\n\n'),
    });
  }

  const temporalNote = state.temporalCheckPassed
    ? '✓ 时间一致性检查通过'
    : '✗ 时间一致性检查未通过（包含过期/未来/撤回来源）';

  sections.push({ heading: '六、时间一致性', content: temporalNote });

  if (state.rejectedSourceIds.length > 0) {
    sections.push({ heading: '七、未通过来源', content: state.rejectedSourceIds.join(', ') });
  }
  if (state.errors.length > 0) {
    sections.push({ heading: '八、审查警告', content: state.errors.join('\n') });
  }

  return {
    title: manifest.title,
    summary: `时政研究报告：${manifest.sources.length}个来源，${manifest.facts?.length ?? 0}项事实`,
    sections,
    sourceCount: manifest.sources.length,
    factCount: manifest.facts?.length ?? 0,
    timestamp: Date.now(),
    exportReady: state.exportReady,
  };
}

export function invalidatePreviewAfterCorrection(manifest: CurrentAffairsManifest): boolean {
  return manifest.sources.some((s) => s.correctionState !== 'clean');
}

export function bindDigestToPreview(
  preview: ExportPreview,
  contentDigest: string,
): ExportPreview & { contentDigest: string } {
  return { ...preview, contentDigest };
}
