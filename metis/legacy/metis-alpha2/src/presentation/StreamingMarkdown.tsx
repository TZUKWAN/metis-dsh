/**
 * StreamingMarkdown — incremental markdown rendering for live-streamed
 * assistant output, adapted from deepseek-harness's IncrementalMarkdownParser
 * (dsh `packages/client/ui-primitives/src/markdown/incremental.ts`, MIT).
 *
 * 2026-09-05 P0 升级（规格五/九十九.5）：旧实现每帧对**全文**重新 remark parse
 * 再按块 memo——那只是 React Render Incremental；本版换用真正的
 * IncrementalMarkdownParser（src/conversation/markdown/）：冻结前缀不再重新
 * parse，每帧只解析 frozenUntil 之后的尾部，累计解析成本 O(最终长度 × 小常数)。
 *
 * Strategy:
 *  - IncrementalMarkdownParser 维护冻结前缀：除尾部 UNSTABLE_TAIL_BLOCKS=2 块外
 *    全部冻结，每帧只对尾部做 remark parse（解析器自身的 position.end.offset 切割）；
 *  - 每个冻结块用 SafeMarkdown 渲染一次并缓存 React element（key = 全文绝对起始
 *    偏移，跨冻结边界 reconcile 而非 remount——DOM identity 保证）；
 *  - 尾部 ≤2 块 + 本帧增长每帧重解析重渲染，成本有界；
 *  - transform（emoji strip + DOI linkify）只应用于渲染时的块文本，不进入解析器
 *    输入：原始文本严格 append-only，且 transform 对历史区域的改写（DOI 完整出现
 *    后才 linkify）不破坏冻结偏移；块仍在尾部时其文本必然已完整；
 *  - 当 `streaming` flips false，整篇走一次 SafeMarkdown 全文管线（settled full
 *    parse），自愈流式期的已知偏差（跨冻结边界的引用式链接/脚注）。
 *
 * Sanitization, allowedElements and the custom link/image/code renderers all
 * stay inside SafeMarkdown — nothing is forked here.
 */
import { memo, useRef, type ReactElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { SafeMarkdown, type SafeMarkdownMode, type SafeMarkdownProps } from './SafeMarkdown';
import type { PresentationLocale } from './executionPresentation';
import { IncrementalMarkdownParser } from '../conversation/markdown/IncrementalMarkdownParser';

interface MdastPositionShape {
  start: { offset?: number };
  end: { offset?: number };
}

interface MdastNodeShape {
  position?: MdastPositionShape;
  children?: MdastNodeShape[];
}

export interface MarkdownBlockRange {
  /** Absolute source offset where the block starts — used as the React key. */
  start: number;
  end: number;
}

// Module-level processor: the parser configuration never changes.
const blockSplitProcessor = unified().use(remarkParse).use(remarkGfm);

/**
 * Split `text` into top-level markdown block ranges with absolute offsets.
 * Any parse anomaly degrades to a single whole-document block — the output is
 * then identical to the non-incremental path.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlockRange[] {
  if (!text) return [];
  try {
    const tree = blockSplitProcessor.parse(text) as unknown as MdastNodeShape;
    const ranges: MarkdownBlockRange[] = [];
    for (const node of tree.children ?? []) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start !== 'number' || typeof end !== 'number') {
        return [{ start: 0, end: text.length }];
      }
      ranges.push({ start, end });
    }
    return ranges.length > 0 ? ranges : [{ start: 0, end: text.length }];
  } catch {
    return [{ start: 0, end: text.length }];
  }
}

/**
 * One frozen-or-live block. `React.memo` compares `content` by value, so an
 * already-frozen block never re-parses even though the parent re-renders on
 * every animation frame while tokens arrive.
 */
const StreamingBlock = memo(function StreamingBlock({
  content,
  uiMode,
  locale,
  codeComponent,
  onOpenPaper,
}: {
  content: string;
  uiMode?: SafeMarkdownMode;
  locale: PresentationLocale;
  codeComponent?: SafeMarkdownProps['codeComponent'];
  onOpenPaper?: (doi: string) => void;
}) {
  return (
    <SafeMarkdown
      content={content}
      uiMode={uiMode}
      locale={locale}
      codeComponent={codeComponent}
      onOpenPaper={onOpenPaper}
    />
  );
});

export interface StreamingMarkdownProps {
  text: string;
  streaming: boolean;
  uiMode?: SafeMarkdownMode;
  locale: PresentationLocale;
  codeComponent?: SafeMarkdownProps['codeComponent'];
  onOpenPaper?: (doi: string) => void;
  /**
   * Source transform shared with the settled renderer (emoji strip + DOI
   * linkify). Applied to the whole accumulated text once per frame — a linear
   * regex pass, negligible next to the markdown parse it feeds — so streaming
   * output stays byte-identical to the settled output.
   */
  transform?: (text: string) => string;
}

const identityTransform = (value: string): string => value;

interface RendererState {
  parser: IncrementalMarkdownParser;
  frozenElements: Map<number, ReactElement>;
  /** 缓存失效键：这些 props 变化时冻结元素全部重建（DSH labels 陷阱的同款防御）。 */
  signature: string;
}

export function StreamingMarkdown({
  text,
  streaming,
  uiMode,
  locale,
  codeComponent,
  onOpenPaper,
  transform = identityTransform,
}: StreamingMarkdownProps) {
  // settled：全文一次渲染自愈（引用式链接/脚注/复杂数学）。
  if (!streaming) {
    return (
      <SafeMarkdown
        content={transform(text)}
        uiMode={uiMode}
        locale={locale}
        codeComponent={codeComponent}
        onOpenPaper={onOpenPaper}
      />
    );
  }
  return (
    <StreamingPipeline
      text={text}
      uiMode={uiMode}
      locale={locale}
      codeComponent={codeComponent}
      onOpenPaper={onOpenPaper}
      transform={transform}
    />
  );
}

function StreamingPipeline({
  text,
  uiMode,
  locale,
  codeComponent,
  onOpenPaper,
  transform,
}: Omit<StreamingMarkdownProps, 'streaming'>) {
  const stateRef = useRef<RendererState | null>(null);

  // 缓存失效签名：locale/模式变化 ⇒ 冻结元素全部重建（元素捕获了旧 props）。
  const signature = `${locale}|${uiMode ?? ''}`;
  let state = stateRef.current;
  if (state === null || state.signature !== signature) {
    state = {
      parser: new IncrementalMarkdownParser(),
      frozenElements: new Map<number, ReactElement>(),
      signature,
    };
    stateRef.current = state;
  }

  const result = state.parser.update(text);
  if (result.reset) {
    state.frozenElements.clear();
  }
  const applyTransform = transform ?? identityTransform;
  const renderBlock = (source: string, key: number): ReactElement => (
    <StreamingBlock
      key={key}
      content={applyTransform(source)}
      uiMode={uiMode}
      locale={locale}
      codeComponent={codeComponent}
      onOpenPaper={onOpenPaper}
    />
  );
  for (const block of result.newlyFrozen) {
    state.frozenElements.set(block.key, renderBlock(text.slice(block.start, block.end), block.key));
  }

  const frozenElements = result.frozen.map((block) => {
    const cached = state.frozenElements.get(block.key);
    if (cached) return cached;
    // 防御：签名外的缓存丢失后按需重建（正常路径不触发）。
    const element = renderBlock(text.slice(block.start, block.end), block.key);
    state.frozenElements.set(block.key, element);
    return element;
  });
  const tailElements = result.tail.map((block) => renderBlock(text.slice(block.start, block.end), block.key));

  // 关键：frozen 与 tail 必须合并在**同一个 children 数组**里输出。
  // 若分成两个数组（两个 React children 槽位），块从 tail 跨入 frozen 时
  // 会被视为不同位置而 remount，memo 缓存与 DOM identity 全部失效。
  const elements = [...frozenElements, ...tailElements];

  return (
    <>
      {elements}
      <span className="streaming-caret" data-testid="streaming-caret" aria-hidden="true" />
    </>
  );
}

