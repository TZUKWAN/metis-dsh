/**
 * IncrementalMarkdownParser（2026-09-05 Conversation Streaming P0，Phase 4）。
 *
 * 参考 DeepSeek Harness ui-primitives/src/markdown/incremental.ts 的本质：
 * - CommonMark 顶层块解析是行级的，追加文本只会重塑解析前沿（最后几个块）；
 * - 除尾部 UNSTABLE_TAIL_BLOCKS 个块外全部冻结，只解析 frozenUntil 之后的尾部；
 * - 切割点用解析器自身的 position.end.offset（不自制扫描），块区间取
 *   「上一块 end → 本块 end」保证切片逐字保真；
 * - 块的稳定 key = 全文绝对起始偏移：块从尾部跨入冻结区时 key 不变，
 *   React reconcile 而非 remount（DOM identity 保证）；
 * - 非 append 输入（retry/regenerate/最终归一化）→ generation+1 整体重置；
 * - 已知偏差（跨冻结边界的引用式链接/脚注先字面渲染）由 settled 全文解析自愈
 *   （渲染层 streaming=false 时切换全文管线）。
 *
 * 与 DSH 的差异：未闭合 fenced code block 的二级解析前沿（约 150 行）第一版不移植——
 * 未闭合 fence 期间它整体留在尾部参与每帧解析（有界，闭合后即冻结），性能仍远优于全文重解析。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

/** 尾部不稳定块数：最后一块是解析前沿，倒数第二块是安全余量（setext heading 等歧义）。 */
const UNSTABLE_TAIL_BLOCKS = 2;

export interface MarkdownBlockSpan {
  /** 全文绝对起始偏移：跨帧稳定的 React key。 */
  key: number;
  start: number;
  end: number;
}

export interface IncrementalParseResult {
  /** 冻结区全部块（按顺序；渲染层缓存其 React elements）。 */
  frozen: MarkdownBlockSpan[];
  /** 本帧新冻结的块（渲染层只需为它们创建元素一次）。 */
  newlyFrozen: MarkdownBlockSpan[];
  /** 不稳定尾部块（每帧重解析重渲染）。 */
  tail: MarkdownBlockSpan[];
  /** 整体重置代数：渲染层据此丢弃全部缓存。 */
  generation: number;
  reset: boolean;
}

interface TopLevelBlock {
  startOffset: number;
  endOffset: number;
}

export class IncrementalMarkdownParser {
  private readonly processor = unified().use(remarkParse).use(remarkGfm);
  private prevText = '';
  private frozenUntil = 0;
  private readonly frozen: MarkdownBlockSpan[] = [];
  private generation = 0;
  private totalParsedChars = 0;
  private lastResult: IncrementalParseResult | null = null;

  /** 诊断指标（规格六十七）：累计解析的源字符数。健康形态 ≈ O(最终长度 × 小常数)。 */
  get parsedCharsTotal(): number {
    return this.totalParsedChars;
  }

  get frozenBlockCount(): number {
    return this.frozen.length;
  }

  update(text: string): IncrementalParseResult {
    // 幂等短路：相同文本返回上次结果（render 阶段可能被 React 重复调用）。
    if (this.lastResult !== null && text === this.prevText) return this.lastResult;
    const reset = !text.startsWith(this.prevText);
    if (reset) {
      this.generation += 1;
      this.prevText = '';
      this.frozenUntil = 0;
      this.frozen.length = 0;
    }
    this.prevText = text;

    const tailBase = this.frozenUntil;
    const tailSource = text.slice(tailBase);
    this.totalParsedChars += tailSource.length;

    const tree = this.processor.parse(tailSource);
    const topLevel = (tree.children ?? []) as Array<{ position?: { start?: { offset?: number }; end?: { offset?: number } } }>;
    const blocks: TopLevelBlock[] = [];
    for (const node of topLevel) {
      const startOffset = node.position?.start?.offset;
      const endOffset = node.position?.end?.offset;
      if (startOffset === undefined || endOffset === undefined) continue;
      // 内容精确区间 [startOffset, endOffset]：remark 的 start/end 都指向内容边界，
      // 跨帧重切时（切点 = 上一块 endOffset）相对坐标与上一帧绝对坐标严格对齐，
      // key 不漂移；块间空行不进入任何块（渲染为兄弟块，间距由 CSS 提供）。
      blocks.push({ startOffset, endOffset });
    }

    const newlyFrozen: MarkdownBlockSpan[] = [];
    const firstUnstable = Math.max(0, blocks.length - UNSTABLE_TAIL_BLOCKS);
    if (firstUnstable > 0) {
      const cutEnd = blocks[firstUnstable - 1]?.endOffset;
      if (cutEnd !== undefined) {
        for (let index = 0; index < firstUnstable; index += 1) {
          const block = blocks[index];
          if (!block) continue;
          const span: MarkdownBlockSpan = {
            key: tailBase + block.startOffset,
            start: tailBase + block.startOffset,
            end: tailBase + block.endOffset,
          };
          newlyFrozen.push(span);
          this.frozen.push(span);
        }
        this.frozenUntil += cutEnd;
      }
    }

    const tail: MarkdownBlockSpan[] = [];
    for (let index = firstUnstable; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block) continue;
      tail.push({
        key: tailBase + block.startOffset,
        start: tailBase + block.startOffset,
        end: tailBase + block.endOffset,
      });
    }

    this.lastResult = {
      frozen: [...this.frozen],
      newlyFrozen,
      tail,
      generation: this.generation,
      reset,
    };
    return this.lastResult;
  }
}
