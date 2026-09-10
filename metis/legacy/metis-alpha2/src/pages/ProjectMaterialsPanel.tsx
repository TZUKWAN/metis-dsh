import { useCallback, useEffect, useState } from 'react';
import { FileUp, LayoutGrid, List, Trash2 } from 'lucide-react';
import './ProjectMaterialsPanel.css';

/**
 * 项目参考材料库（2026-09-01 刘总要求）：
 * 科研项目内上传与管理用户自己的参考材料（文献/数据/代码/笔记/模板规范）。
 * 材料以文本形态持久化，场景编译与执行时可作为参考上下文引用；
 * SPSS/Stata/R 数据文件原样存档并给出导出 CSV 的指引。
 */

const CATEGORIES = [
  { id: 'references', label: '文献' },
  { id: 'data', label: '数据' },
  { id: 'code', label: '代码' },
  { id: 'notes', label: '研究笔记' },
  { id: 'template_spec', label: '模板与规范' },
  { id: 'other', label: '其他' },
] as const;

type Category = (typeof CATEGORIES)[number]['id'];

interface MaterialRow {
  id: string;
  name: string;
  category: string;
  charCount: number;
  addedAt: number;
  binaryArchive?: string;
}

export function ProjectMaterialsPanel({ projectId }: { projectId: string | null }) {
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [uploadCategory, setUploadCategory] = useState<Category>('references');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // 列表 / 九宫格卡片两种视图（仅视图状态，不影响数据）。
  const [view, setView] = useState<'list' | 'grid'>('list');

  const refresh = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.projectMaterialList || !projectId) { setMaterials([]); return; }
    try {
      const result = await metis.projectMaterialList(projectId);
      setMaterials(result.ok && result.materials ? result.materials : []);
    } catch { setMaterials([]); }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async () => {
    const metis = window.metis;
    if (!metis?.projectMaterialImportDialog || !projectId || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await metis.projectMaterialImportDialog({ projectId, category: uploadCategory });
      if (!result.ok) {
        if (result.error !== 'cancelled') setNotice(result.error ?? '上传未完成。');
        return;
      }
      const importedCount = result.imported?.length ?? 0;
      const failures = (result.errors ?? []).map((item) => `${item.name}：${item.error}`).join('；');
      await refresh();
      setNotice(importedCount > 0
        ? `已导入 ${importedCount} 份材料。${failures ? `失败：${failures}` : ''}`
        : `没有导入成功。${failures}`);
    } catch {
      setNotice('上传请求未完成。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    const metis = window.metis;
    if (!metis?.projectMaterialDelete || busy) return;
    try {
      const result = await metis.projectMaterialDelete(id);
      if (result.ok) {
        setMaterials((current) => current.filter((item) => item.id !== id));
        setNotice(`已删除「${name}」。`);
      } else setNotice(result.error ?? '删除未完成。');
    } catch { setNotice('删除请求未完成。'); }
  };

  const changeCategory = async (id: string, category: Category) => {
    const metis = window.metis;
    if (!metis?.projectMaterialSetCategory) return;
    try {
      const result = await metis.projectMaterialSetCategory({ id, category });
      if (result.ok) setMaterials((current) => current.map((item) => (item.id === id ? { ...item, category } : item)));
    } catch { /* 列表刷新时自愈 */ }
  };

  const visible = filter === 'all' ? materials : materials.filter((item) => item.category === filter);
  const labelOf = (category: string) => CATEGORIES.find((entry) => entry.id === category)?.label ?? '其他';

  return (
    <section className="project-materials" aria-label="项目参考材料">
      <header className="project-materials__head">
        <div className="project-materials__intro">
          <h3>项目参考材料</h3>
          <p>上传你自己的研究资料（访谈记录、问卷数据、分析脚本、参考文献、申报书模板…），场景执行与 AI 对话可作为参考上下文读取。SPSS(.sav) / Stata(.dta) / R(.rds) 数据文件原样存档（导出 CSV 后可让 AI 读取内容）。</p>
          {/* 支持的格式列表收成一行小字，完整内容见 title 悬浮提示 */}
          <p className="project-materials__formats" title="txt / md / csv / json / docx / pdf / pptx / xlsx / py / R / do / sav / dta / rds">
            支持格式：txt / md / csv / json / docx / pdf / pptx / xlsx / py / R / do / sav / dta / rds
          </p>
        </div>
        <div className="project-materials__upload">
          <select
            aria-label="选择材料大类"
            value={uploadCategory}
            onChange={(event) => setUploadCategory(event.target.value as Category)}
          >
            {CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <button type="button" className="btn-sm btn-secondary" onClick={() => void upload()} disabled={busy || !projectId}>
            <FileUp size={13} />{busy ? '上传中…' : '上传资料'}
          </button>
        </div>
      </header>

      <div className="project-materials__filter" role="tablist" aria-label="按大类筛选">
        <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {materials.length}</button>
        {CATEGORIES.map((entry) => {
          const count = materials.filter((item) => item.category === entry.id).length;
          return (
            <button key={entry.id} type="button" className={filter === entry.id ? 'active' : ''} onClick={() => setFilter(entry.id)}>
              {entry.label} {count}
            </button>
          );
        })}
        <span className="project-materials__view" role="group" aria-label="切换展示方式">
          <button
            type="button"
            className={view === 'list' ? 'active' : ''}
            onClick={() => setView('list')}
            aria-label="列表展示"
            title="列表展示"
            data-testid="materials-view-list"
          >
            <List size={13} />
          </button>
          <button
            type="button"
            className={view === 'grid' ? 'active' : ''}
            onClick={() => setView('grid')}
            aria-label="九宫格卡片展示"
            title="九宫格卡片展示"
            data-testid="materials-view-grid"
          >
            <LayoutGrid size={13} />
          </button>
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="project-materials__empty">还没有材料。点击右上角「上传资料」添加你自己的研究文件。</p>
      ) : view === 'grid' ? (
        <ul className="project-materials__grid" data-testid="materials-grid">
          {visible.map((item) => (
            <li key={item.id} className={item.binaryArchive ? 'binary' : ''}>
              <span className="project-materials__name" title={item.name}>{item.name}</span>
              <span className="project-materials__badge">{labelOf(item.category)}</span>
              <span className="project-materials__meta">
                {item.binaryArchive ? '数据存档 · 未解析' : `${item.charCount.toLocaleString()} 字`}
                {' · '}{new Date(item.addedAt).toLocaleDateString('zh-CN')}
              </span>
              <span className="project-materials__card-actions">
                <select
                  aria-label={`修改 ${item.name} 的分类`}
                  value={item.category}
                  onChange={(event) => void changeCategory(item.id, event.target.value as Category)}
                >
                  {CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
                <button
                  type="button"
                  onClick={() => void remove(item.id, item.name)}
                  aria-label={`删除 ${item.name}`}
                  title="删除该材料"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="project-materials__list">
          {visible.map((item) => (
            <li key={item.id} className={item.binaryArchive ? 'binary' : ''}>
              <span className="project-materials__name" title={item.name}>{item.name}</span>
              <span className="project-materials__badge">{labelOf(item.category)}</span>
              <span className="project-materials__meta">
                {item.binaryArchive ? '数据存档 · 未解析' : `${item.charCount.toLocaleString()} 字`}
                {' · '}{new Date(item.addedAt).toLocaleDateString('zh-CN')}
              </span>
              <select
                aria-label={`修改 ${item.name} 的分类`}
                value={item.category}
                onChange={(event) => void changeCategory(item.id, event.target.value as Category)}
              >
                {CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
              <button
                type="button"
                onClick={() => void remove(item.id, item.name)}
                aria-label={`删除 ${item.name}`}
                title="删除该材料"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {notice && <p className="project-materials__notice" role="status">{notice}</p>}
    </section>
  );
}
