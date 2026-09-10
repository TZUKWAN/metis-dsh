/**
 * MarkdownToWordDocument — Markdown → WordDocument 块树转换（2026-08-31
 * 刘总要求：研究交付物必须形成排版好的 Word 文件，而不是只停留在对话文本）。
 *
 * 覆盖主流学术写作结构：标题层级（h1-h6）、段落、有序/无序列表（嵌套
 * listLevel 映射到 Word 编号）、GFM 表格、引用块（缩进）、代码块（等宽
 * 字体按行拆段，保留换行）、GFM 脚注定义、链接（可见文本 + 相异 URL 追加）。
 *
 * 如实降级的部分（WordDocument 块模型表达不了，不虚构样式）：
 * - 行内粗体/斜体/删除线：剥除标记保留纯文本（块树 style 是段落级，
 *   导出 codec 每段一个 run，无行内 run 概念）；
 * - md 图片：不下载远程资源，降级为 `[图片：alt]` 文本占位；
 * - html 块/行内 html：跳过（与 SafeMarkdown 的 skipHtml 策略一致）。
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type {
  Blockquote,
  FootnoteDefinition,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import type { WordDocument } from '../runtime/OutcomeRuntimeContract.js';

type WordBlock = WordDocument['blocks'][number];

/** 递归提取行内节点的可见纯文本（样式标记剥除——见文件头降级说明）。 */
function inlineText(node: PhrasingContent): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'strong':
    case 'emphasis':
    case 'delete':
      return node.children.map(inlineText).join('');
    case 'link': {
      const label = node.children.map(inlineText).join('');
      const url = typeof node.url === 'string' ? node.url : '';
      if (!url) return label;
      // 自动链接（<https://…>）可见文本即 URL；手写链接文本与 URL 相异时追加，
      // 学术场景下保住 DOI/来源可达性。
      return label && label !== url ? `${label} (${url})` : url;
    }
    case 'image':
      return node.alt ? `[图片：${node.alt}]` : '';
    case 'break':
      return ' ';
    case 'footnoteReference':
      return `[${node.identifier}]`;
    default:
      return '';
  }
}

function blockInlineText(children: readonly PhrasingContent[]): string {
  return children.map(inlineText).join('').replace(/[ \t]{2,}/gu, ' ').trim();
}

class BlockEmitter {
  private counter = 0;
  readonly blocks: WordBlock[] = [];

  private nextId(): string {
    this.counter += 1;
    return `b-${this.counter}`;
  }

  push(block: Omit<WordBlock, 'id'>): void {
    this.blocks.push({ id: this.nextId(), ...block } as WordBlock);
  }

  /** 文本里残留的字面换行按行拆成多个段落（codec 的 <w:t> 不认 \n）。 */
  pushParagraphLines(text: string, style?: Record<string, unknown>): void {
    const lines = text.split('\n').map((line) => line.trimEnd());
    for (const line of lines) {
      if (!line.trim() && lines.length === 1) return;
      this.push({ kind: 'paragraph', text: line, ...(style ? { style } : {}) });
    }
  }

  emitList(list: List, level: number): void {
    const listKind = list.ordered ? 'numbered' : 'bullet';
    for (const item of list.children) {
      this.emitListItem(item, listKind, level);
    }
  }

  private emitListItem(item: ListItem, listKind: 'bullet' | 'numbered', level: number): void {
    let emittedOwnText = false;
    for (const child of item.children) {
      if (child.type === 'paragraph' && !emittedOwnText) {
        const text = blockInlineText(child.children);
        if (text) {
          this.push({ kind: 'paragraph', text, style: { list: listKind, listLevel: level } });
          emittedOwnText = true;
        }
        continue;
      }
      if (child.type === 'list') {
        this.emitList(child, level + 1);
        continue;
      }
      // 松散列表项里的额外块（引用/代码等）按普通块输出。
      this.emit(child);
    }
  }

  emitBlockquote(quote: Blockquote): void {
    for (const child of quote.children) {
      if (child.type === 'paragraph') {
        const text = blockInlineText(child.children);
        if (text) this.push({ kind: 'paragraph', text, style: { indentLeftPt: 18, spaceBeforePt: 3, spaceAfterPt: 3 } });
        continue;
      }
      this.emit(child);
    }
  }

  emitTable(table: Table): void {
    const rows = table.children.map((row) =>
      row.children.map((cell) => blockInlineText(cell.children)),
    );
    if (rows.length > 0) this.push({ kind: 'table', rows });
  }

  emitFootnote(definition: FootnoteDefinition): void {
    const text = definition.children
      .map((child) => (child.type === 'paragraph' ? blockInlineText(child.children) : ''))
      .filter(Boolean)
      .join(' ');
    if (text) this.push({ kind: 'paragraph', text: `[${definition.identifier}] ${text}`, style: { fontSizePt: 9 } });
  }

  emit(node: RootContent): void {
    switch (node.type) {
      case 'heading': {
        const text = blockInlineText(node.children);
        if (text) this.push({ kind: 'heading', level: Math.min(6, Math.max(1, node.depth)), text });
        return;
      }
      case 'paragraph': {
        const text = blockInlineText(node.children);
        if (text) this.push({ kind: 'paragraph', text });
        return;
      }
      case 'list':
        this.emitList(node, 0);
        return;
      case 'table':
        this.emitTable(node);
        return;
      case 'blockquote':
        this.emitBlockquote(node);
        return;
      case 'code':
        this.pushParagraphLines(node.value.replace(/\n+$/u, ''), { fontFamily: 'Consolas', fontSizePt: 10 });
        return;
      case 'footnoteDefinition':
        this.emitFootnote(node);
        return;
      // thematicBreak / html / yaml / 未知节点：跳过（见文件头降级说明）。
      default:
        return;
    }
  }
}

/**
 * Markdown 字符串 → WordDocument。空输入返回空 blocks（调用方判空，
 * 不为空输入伪造内容）。解析失败（畸形 md 不会抛，但防御）时回退为
 * 按双换行切段的纯段落文档——保证交付物一定能成形。
 */
export function markdownToWordDocument(markdown: string): WordDocument {
  const page = { paper: 'A4', lineSpacing: 1.5 };
  const source = typeof markdown === 'string' ? markdown : '';
  if (!source.trim()) return { type: 'word', blocks: [], page, header: '', footer: '' };
  try {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
    const emitter = new BlockEmitter();
    for (const node of tree.children) emitter.emit(node);
    if (emitter.blocks.length === 0) throw new Error('empty_block_tree');
    return { type: 'word', blocks: emitter.blocks, page, header: '', footer: '' };
  } catch {
    const segments = source.split(/\n{2,}/u).map((segment) => segment.trim()).filter(Boolean);
    return {
      type: 'word',
      blocks: segments.map((segment, index) => ({ id: `b-${index + 1}`, kind: 'paragraph' as const, text: segment })),
      page,
      header: '',
      footer: '',
    };
  }
}
