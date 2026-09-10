import { useState, type ReactNode } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, BookOpen, FilePlus2, Italic, List, ListOrdered, Minus, Plus, Redo2, Ruler, Save, Table2, Underline, Undo2 } from 'lucide-react';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { OfficeRibbon, type OfficeRibbonTab } from './OfficeRibbon';
import { insertWordPageBreak, insertWordTable, toggleWordList, updateWordActiveStyle, wordDocumentStats } from './OfficeWordOperations';

type Props = Readonly<{
  document: WordDocument;
  activeBlockId: string;
  activeStyle: Record<string, unknown>;
  activeKind?: 'paragraph' | 'heading';
  activeLevel?: number;
  historyState: { index: number; length: number };
  onChange: (document: WordDocument) => void;
  onSave?: () => void;
  onHistory: (direction: -1 | 1) => void;
  onCitation: () => void;
  onNotice: (notice: string) => void;
}>;

const alignments = [
  ['left', '左对齐', AlignLeft],
  ['center', '居中', AlignCenter],
  ['right', '右对齐', AlignRight],
  ['justify', '两端对齐', AlignJustify],
] as const;

function controlButton(label: string, onClick: () => void, disabled = false, active = false, icon?: ReactNode, key?: string) {
  return <button key={key} type="button" className={`office-ribbon__control${active ? ' is-active' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{icon ?? label}</button>;
}

export function OfficeWordRibbon({ document, activeBlockId, activeStyle, activeKind = 'paragraph', activeLevel = 1, historyState, onChange, onSave, onHistory, onCitation }: Props) {
  const [activeTab, setActiveTab] = useState('home');
  const stats = wordDocumentStats(document);
  const changeStyle = (patch: Record<string, unknown>) => onChange(updateWordActiveStyle(document, activeBlockId, patch));
  const changeKind = (value: string) => onChange({ ...document, blocks: document.blocks.map((block) => block.id === activeBlockId ? value === 'p' ? { ...block, kind: 'paragraph' } : { ...block, kind: 'heading', level: Number(value.slice(1)) } : block) });
  const insertTable = (rows: number, columns: number) => onChange(insertWordTable(document, rows, columns, activeBlockId));
  const tabs: OfficeRibbonTab[] = [
    {
      id: 'home', label: '开始', groups: [
         { id: 'clipboard', label: '剪贴板', content: <div className="office-ribbon__controls"><>{controlButton('撤销', () => onHistory(-1), historyState.index <= 0, false, <Undo2 size={16} />)}{controlButton('重做', () => onHistory(1), historyState.index >= historyState.length - 1, false, <Redo2 size={16} />)}<button type="button" className="office-ribbon__text-control" onClick={() => onSave?.()} disabled={!onSave}><Save size={16} />保存</button>{controlButton('插入表格', () => onChange(insertWordTable(document, 2, 2, activeBlockId)), false, false, <Table2 size={16} />)}{controlButton('• 列表', () => onChange(toggleWordList(document, activeBlockId, 'bullet')), false, false, <List size={16} />)}</></div> },
        { id: 'font', label: '字体', content: <div className="office-ribbon__controls office-ribbon__controls--font"><select aria-label="段落样式" value={activeKind === 'heading' ? `h${activeLevel}` : 'p'} onChange={(event) => changeKind(event.target.value)}><option value="p">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option></select><input aria-label="字体" value={typeof activeStyle.fontFamily === 'string' ? activeStyle.fontFamily : ''} placeholder="字体" onChange={(event) => changeStyle({ fontFamily: event.target.value })} /><input aria-label="字号" type="number" min="6" max="96" value={typeof activeStyle.fontSizePt === 'number' ? activeStyle.fontSizePt : 12} onChange={(event) => changeStyle({ fontSizePt: Number(event.target.value) || 12 })} />{controlButton('加粗', () => changeStyle({ bold: activeStyle.bold !== true }), false, activeStyle.bold === true, <Bold size={16} />)}{controlButton('斜体', () => changeStyle({ italic: activeStyle.italic !== true }), false, activeStyle.italic === true, <Italic size={16} />)}{controlButton('下划线', () => changeStyle({ underline: activeStyle.underline !== true }), false, activeStyle.underline === true, <Underline size={16} />)}<input aria-label="文字颜色" type="color" value={typeof activeStyle.color === 'string' && /^#[0-9a-f]{6}$/iu.test(activeStyle.color) ? activeStyle.color : '#17243A'} onChange={(event) => changeStyle({ color: event.target.value })} /></div> },
        { id: 'paragraph', label: '段落', content: <div className="office-ribbon__controls"><div className="office-ribbon__control-group">{alignments.map(([value, label, Icon]) => controlButton(label, () => changeStyle({ align: value }), false, activeStyle.align === value, <Icon size={15} />, label))}</div>{controlButton('项目符号', () => onChange(toggleWordList(document, activeBlockId, 'bullet')), false, activeStyle.list === 'bullet', <List size={16} />)}{controlButton('编号', () => onChange(toggleWordList(document, activeBlockId, 'numbered')), false, activeStyle.list === 'numbered', <ListOrdered size={16} />)}{controlButton('增加缩进', () => changeStyle({ indentLeft: Number(activeStyle.indentLeft ?? 0) + 20 }), false, false, <Plus size={14} />)}{controlButton('减少缩进', () => changeStyle({ indentLeft: Math.max(0, Number(activeStyle.indentLeft ?? 0) - 20) }), false, false, <Minus size={14} />)}</div> },
      ],
    },
    {
      id: 'insert', label: '插入', groups: [
        { id: 'tables', label: '表格', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => insertTable(2, 2)}><Table2 size={16} />2 × 2 表格</button><button type="button" className="office-ribbon__text-control" onClick={() => insertTable(3, 3)}><Table2 size={16} />3 × 3 表格</button></div> },
        { id: 'pages', label: '页面', content: <div className="office-ribbon__controls">{controlButton('分页符', () => onChange(insertWordPageBreak(document, activeBlockId)), false, false, <FilePlus2 size={16} />)}</div> },
        { id: 'references', label: '引用', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={onCitation}><BookOpen size={16} />插入引用</button></div> },
      ],
    },
    {
      id: 'layout', label: '布局', groups: [
         { id: 'page-layout', label: '页面设置', content: <div className="office-ribbon__status-card"><strong>页面排版</strong><span>请使用成果操作行中的“排版”打开页面设置。</span></div> },
      ],
    },
    {
      id: 'references', label: '引用', groups: [
        { id: 'citation-manager', label: '引用与目录', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={onCitation}><BookOpen size={16} />添加引用</button><span className="office-ribbon__hint">当前引用块：{document.blocks.filter((block) => block.style?.reference === true).length}</span></div> },
      ],
    },
    {
      id: 'review', label: '审阅', groups: [
        { id: 'proofing', label: '校验', content: <div className="office-ribbon__status-card"><strong>结构化编辑</strong><span>METIS 版本与来源治理继续生效</span></div> },
        { id: 'selection', label: '当前选区', content: <div className="office-ribbon__status-card"><strong>{activeBlockId || '未选择段落'}</strong><span>未选中文本时不会发送局部 AI</span></div> },
      ],
    },
    {
      id: 'view', label: '视图', groups: [
        { id: 'statistics', label: '文档统计', content: <div className="office-ribbon__status-card"><strong>{stats.words} 词 · {stats.characters} 字符</strong><span>{stats.paragraphs} 段落 · {stats.tables} 表格 · {stats.images} 图片</span></div> },
        { id: 'page-view', label: '页面', content: <div className="office-ribbon__status-card"><Ruler size={16} /><span>{String(document.page.paper ?? 'A4')} 页面视图</span></div> },
      ],
    },
  ];
  return <OfficeRibbon tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />;
}
