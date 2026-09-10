/**
 * Comparison Matrix — multi-paper side-by-side analysis engine.
 *
 * Extracts structured metadata from multiple papers and generates
 * a comparison table suitable for survey papers' "Table 1" style.
 */

import type { PaperItem } from './PaperItem.js';

// ─── Types ──────────────────────────────────────────────────

export interface PaperSummary {
  id: string;
  title: string;
  year: number;
  method: string;
  dataset: string;
  metric: string;
  score: string;
  keyContrib: string;
}

export interface ComparisonMatrixResult {
  papers: PaperSummary[];
  columns: string[];
  rows: string[][];
  markdown: string;
}

// ─── Method / Dataset / Metric Extraction ──────────────────

const METHOD_PATTERNS = [
  'transformer', 'cnn', 'rnn', 'lstm', 'gan', 'diffusion', 'reinforcement learning',
  'bert', 'gpt', 'llm', 'graph neural', 'attention', 'variational', 'flow-based',
  'contrastive', 'self-supervised', 'transfer learning', 'few-shot', 'zero-shot',
  'fine-tun', 'prompt', 'chain-of-thought', 'rag',
];

const DATASET_PATTERNS = [
  'imagenet', 'cifar', 'mnist', 'coco', 'squad', 'glue', 'superglue',
  'wikitext', 'common crawl', 'the pile', 'openwebtext', 'wmt', 'librispeech',
  'pascal voc', 'cityscapes', 'kinetics', 'something-something', 'ms marco',
  'natural questions', 'triviaqa', 'mmlu', 'humanEval', 'gsm8k',
];

const METRIC_PATTERNS = [
  'accuracy', 'f1', 'bleu', 'rouge', 'perplexity', 'map', 'ndcg',
  'precision', 'recall', 'auc', 'mse', 'mae', 'psnr', 'ssim',
  'top-1', 'top-5', 'wer', 'cer',
];

function extractMethod(abstract: string): string {
  const lower = abstract.toLowerCase();
  const found = METHOD_PATTERNS.filter((p) => lower.includes(p));
  return found.length > 0 ? found.slice(0, 3).join(', ') : 'N/A';
}

function extractDataset(abstract: string): string {
  const lower = abstract.toLowerCase();
  const found = DATASET_PATTERNS.filter((p) => lower.includes(p));
  return found.length > 0 ? found.slice(0, 3).join(', ') : 'N/A';
}

function extractScore(abstract: string): string {
  const scores: string[] = [];
  for (const m of METRIC_PATTERNS) {
    const regex = new RegExp(`${m}[\\s:of]*?(\\d+\\.?\\d*)`, 'i');
    const match = abstract.match(regex);
    if (match?.[1]) {
      scores.push(`${m}: ${match[1]}`);
    }
  }
  return scores.length > 0 ? scores.slice(0, 2).join('; ') : 'N/A';
}

// ─── Comparison Matrix Engine ──────────────────────────────

export class ComparisonMatrix {
  /**
   * Generate a comparison table from a set of papers.
   */
  generate(papers: PaperItem[]): ComparisonMatrixResult {
    const summaries: PaperSummary[] = papers.map((p) => {
      const text = `${p.title} ${p.abstract} ${p.notes}`;
      return {
        id: p.id,
        title: p.title.length > 60 ? p.title.slice(0, 60) + '...' : p.title,
        year: p.year,
        method: extractMethod(text),
        dataset: extractDataset(text),
        metric: extractMetricFromAbstract(text),
        score: extractScore(text),
        keyContrib: p.abstract.slice(0, 100).replace(/\n/g, ' '),
      };
    });

    const columns = ['Paper', 'Year', 'Method', 'Dataset', 'Metric', 'Score', 'Key Contribution'];
    const rows = summaries.map((s) => [
      s.title,
      String(s.year),
      s.method,
      s.dataset,
      s.metric,
      s.score,
      s.keyContrib,
    ]);

    const markdown = this.formatMarkdown(columns, rows);

    return { papers: summaries, columns, rows, markdown };
  }

  /**
   * Compare by a specific metric across papers.
   */
  compareByMetric(papers: PaperItem[], metricName: string): Array<{ title: string; value: string }> {
    return papers.map((p) => {
      const regex = new RegExp(`${metricName}[\\s:of]*?(\\d+\\.?\\d*)`, 'i');
      const match = p.abstract.match(regex);
      return { title: p.title, value: match?.[1] ?? 'N/A' };
    });
  }

  /**
   * Format as markdown table.
   */
  private formatMarkdown(columns: string[], rows: string[][]): string {
    const lines: string[] = [];
    lines.push('| ' + columns.join(' | ') + ' |');
    lines.push('| ' + columns.map(() => '---').join(' | ') + ' |');
    for (const row of rows) {
      lines.push('| ' + row.map((c) => c.length > 80 ? c.slice(0, 80) + '...' : c).join(' | ') + ' |');
    }
    return lines.join('\n');
  }
}

/**
 * Extract primary metric name from abstract text.
 */
function extractMetricFromAbstract(text: string): string {
  const lower = text.toLowerCase();
  const found = METRIC_PATTERNS.filter((p) => lower.includes(p));
  return found.length > 0 ? found[0]! : 'N/A';
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: ComparisonMatrix | null = null;

export function getComparisonMatrix(): ComparisonMatrix {
  if (!_instance) _instance = new ComparisonMatrix();
  return _instance;
}
