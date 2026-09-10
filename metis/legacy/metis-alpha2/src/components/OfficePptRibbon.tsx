import { useState, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, BarChart3, Copy, Eye, Image as ImageIcon, Plus, Save, Square, Table2, Trash2, Type } from 'lucide-react';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { addPptElement, deletePptPage, duplicatePptPage, pptDocumentStats, updatePptElementProps } from './OfficePptOperations';
import { OfficeRibbon, type OfficeRibbonTab } from './OfficeRibbon';

type PptElement = PptDocument['pages'][number]['elements'][number];
type PptElementType = PptElement['type'];

type Props = Readonly<{
  document: PptDocument;
  pageIndex: number;
  selectedElementId?: string;
  onChange: (document: PptDocument) => void;
  onSave: () => void;
  onSelectPage: (index: number, pageId?: string) => void;
  onSelectElement: (elementId?: string) => void;
  onNotice: (notice: string) => void;
}>;

function controlButton(label: string, onClick: () => void, disabled = false, active = false, icon?: ReactNode) {
  return <button type="button" className={`office-ribbon__control${active ? ' is-active' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{icon ?? label}</button>;
}

export function OfficePptRibbon({ document, pageIndex, selectedElementId, onChange, onSave, onSelectPage, onSelectElement, onNotice }: Props) {
  const [activeTab, setActiveTab] = useState('home');
  const page = document.pages[pageIndex] ?? document.pages[0];
  const selected = page?.elements.find((element) => element.id === selectedElementId);
  const stats = pptDocumentStats(document);
  const addElement = (type: PptElementType) => {
    const next = addPptElement(document, pageIndex, type);
    const added = next.pages[pageIndex]?.elements.at(-1);
    onChange(next);
    onSelectElement(added?.id);
  };
  const addSlide = () => {
    let index = document.pages.length + 1;
    let id = `slide-${index}`;
    while (document.pages.some((candidate) => candidate.id === id)) id = `slide-${++index}`;
    const nextPage: PptDocument['pages'][number] = { id, title: `第 ${document.pages.length + 1} 页`, pageType: 'content', humanModified: true, status: 'draft', elements: [] };
    const next = { ...document, pages: [...document.pages, nextPage] };
    onChange(next);
    onSelectPage(next.pages.length - 1, nextPage.id);
  };
  const updateSelected = (patch: Record<string, unknown>) => {
    if (!selected) return;
    onChange(updatePptElementProps(document, pageIndex, selected.id, patch));
  };
  const updateTheme = (key: 'primary' | 'accent' | 'surface' | 'text', color: string) => onChange({ ...document, theme: { ...document.theme, [key]: color } });
  const tabs: OfficeRibbonTab[] = [
    {
      id: 'home', label: '开始', groups: [
         { id: 'slides', label: '幻灯片', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={addSlide}><Plus size={16} />新建幻灯片</button><button type="button" className="office-ribbon__text-control" onClick={() => { const next = duplicatePptPage(document, pageIndex); onChange(next); onSelectPage(pageIndex + 1, next.pages[pageIndex + 1]?.id); }}><Copy size={16} />复制幻灯片</button>{controlButton('删除幻灯片', () => { const next = deletePptPage(document, pageIndex); const nextIndex = Math.max(0, pageIndex - 1); onChange(next); onSelectPage(nextIndex, next.pages[nextIndex]?.id); }, document.pages.length <= 1, false, <Trash2 size={16} />)}</div> },
        { id: 'editing', label: '编辑', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => addElement('text')}><Type size={16} />文本</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('rect')}><Square size={16} />矩形</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('table')}><Table2 size={16} />表格</button><button type="button" className="office-ribbon__text-control" onClick={() => onNotice(selected?.type === 'image' ? '请在右侧“AI 图片生成”面板输入提示词。' : '请先选择一个图片占位元素，再生成图片。')}><ImageIcon size={16} />AI 图片</button>{controlButton('保存', onSave, false, false, <Save size={16} />)}<button type="button" className={`office-ribbon__control${document.ratio === '16:9' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '16:9' })}>16:9</button><button type="button" className={`office-ribbon__control${document.ratio === '4:3' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '4:3' })}>4:3</button><span className="office-ribbon__hint">{document.ratio} · {page?.elements.length ?? 0} 个元素</span></div> },
      ],
    },
    {
      id: 'insert', label: '插入', groups: [
        { id: 'text', label: '文本', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => addElement('text')}><Type size={16} />文本</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('table')}><Table2 size={16} />表格</button></div> },
        { id: 'shapes', label: '形状与媒体', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => addElement('rect')}><Square size={16} />矩形</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('image')}><ImageIcon size={16} />图片占位</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('chart')}><BarChart3 size={16} />图表</button></div> },
      ],
    },
    {
      id: 'design', label: '设计', groups: [
        { id: 'ratio', label: '页面设置', content: <div className="office-ribbon__controls"><button type="button" className={`office-ribbon__control${document.ratio === '16:9' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '16:9' })}>16:9</button><button type="button" className={`office-ribbon__control${document.ratio === '4:3' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '4:3' })}>4:3</button></div> },
        { id: 'theme', label: '主题颜色', content: <div className="office-ribbon__controls office-ribbon__controls--font">{(['primary', 'accent', 'surface', 'text'] as const).map((key) => <label key={key} className="office-ribbon__color-control"><span>{key === 'primary' ? '主色' : key === 'accent' ? '强调' : key === 'surface' ? '画布' : '正文'}</span><input aria-label={`主题${key}`} type="color" value={typeof document.theme[key] === 'string' ? String(document.theme[key]) : '#236c91'} onChange={(event) => updateTheme(key, event.target.value)} /></label>)}</div> },
      ],
    },
    {
      id: 'transitions', label: '切换', groups: [
        { id: 'transition-status', label: '幻灯片切换', content: <div className="office-ribbon__status-card"><strong>结构化切换</strong><span>切换参数将在真实演示导出能力可用后写入。</span></div> },
      ],
    },
    {
      id: 'animations', label: '动画', groups: [
        { id: 'animation-status', label: '对象动画', content: <div className="office-ribbon__status-card"><strong>{selected ? '已选中对象' : '未选中对象'}</strong><span>当前编辑器保留对象与层级，不伪造未支持的动画效果。</span><button type="button" className="office-ribbon__text-control" onClick={() => onNotice('当前 PPT 编辑器暂不写入动画效果；本次没有修改成果。')}>查看支持边界</button></div> },
      ],
    },
    {
      id: 'review', label: '审阅', groups: [
        { id: 'review-status', label: '校验', content: <div className="office-ribbon__status-card"><strong>METIS 版本治理</strong><span>保存后才创建人工 PPT 版本，生成服务仍走主进程。</span></div> },
      ],
    },
    {
      id: 'view', label: '视图', groups: [
        { id: 'statistics', label: '演示文稿统计', content: <div className="office-ribbon__status-card"><strong>{stats.slides} 页 · {stats.elements} 个对象</strong><span>{stats.text} 文本 · {stats.images} 图片 · {stats.charts} 图表</span></div> },
        { id: 'selected', label: '选中对象', content: <div className="office-ribbon__status-card"><Eye size={16} /><span>{selected ? `${selected.type} · ${selected.id}` : '未选中对象'}</span></div> },
      ],
    },
  ];
  const tabsWithSelection: OfficeRibbonTab[] = selected
    ? tabs.map((tab) => tab.id === 'home' ? { ...tab, groups: [...tab.groups, { id: 'format', label: '对象格式', content: <div className="office-ribbon__controls office-ribbon__controls--font"><input aria-label="对象字号" type="number" min="6" max="120" value={typeof selected.props.fontSize === 'number' ? selected.props.fontSize : 18} onChange={(event) => updateSelected({ fontSize: Number(event.target.value) || 18 })} />{controlButton('左对齐', () => updateSelected({ align: 'left' }), false, selected.props.align === 'left', <AlignLeft size={15} />)}{controlButton('居中对齐', () => updateSelected({ align: 'center' }), false, selected.props.align === 'center', <AlignCenter size={15} />)}{controlButton('右对齐', () => updateSelected({ align: 'right' }), false, selected.props.align === 'right', <AlignRight size={15} />)}</div> }] } : tab)
    : tabs;
  return <OfficeRibbon tabs={tabsWithSelection} activeTab={activeTab} onTabChange={setActiveTab} />;
}
