/**
 * CategoryTreePanel — 组件库侧边栏的分类树面板。
 *
 * 封装分类管理的全部状态和逻辑，通过 props 与 PersonalizationCenter 通信。
 * 使用 personalizationLib 的通用分类管理工具。
 */
import { useMemo, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Plus, Trash2, Pencil } from 'lucide-react';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  assignToCategory,
  createCategory as createCategoryUtil,
  deleteCategory as deleteCategoryUtil,
  getDefinitionsInCategory,
  readCategories,
  readCategoryMap,
  renameCategory as renameCategoryUtil,
  type Category,
} from './personalizationLib.js';

const COLLAPSED_KEY = (kind: string) => `metis-${kind}-categories-collapsed:v1`;

function readCollapsed(kind: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY(kind));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set(['all']);
  }
}

function writeCollapsed(kind: string, collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY(kind), JSON.stringify([...collapsed]));
  } catch { /* best-effort */ }
}

export interface CategoryTreePanelProps {
  kind: string;
  definitions: readonly PersonalizationDefinition[];
  filtered: readonly PersonalizationDefinition[];
  onFilterChange: (categoryId: string | null) => void;
  onArchive: (definition: PersonalizationDefinition) => void;
  zh: boolean;
}

export default function CategoryTreePanel({
  kind,
  definitions,
  filtered,
  onFilterChange,
  onArchive,
  zh,
}: CategoryTreePanelProps) {
  const [version, setVersion] = useState(0);
  const categories = useMemo(() => readCategories(kind), [kind, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const categoryMap = useMemo(() => readCategoryMap(kind), [kind, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(kind));
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const isUncategorized = activeCategoryId === null;

  const handleSelectCategory = useCallback((categoryId: string | null) => {
    setActiveCategoryId(categoryId);
    onFilterChange(categoryId);
  }, [onFilterChange]);

  const toggleCollapse = useCallback((categoryId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
      writeCollapsed(kind, next);
      return next;
    });
  }, [kind]);

  const handleCreateCategory = useCallback(() => {
    const name = newCategoryName.trim();
    if (!name) return;
    createCategoryUtil(kind, name);
    setNewCategoryName('');
    setNewCategoryOpen(false);
    setVersion((v) => v + 1);
  }, [kind, newCategoryName]);

  const handleRenameCategory = useCallback((categoryId: string, newName: string) => {
    renameCategoryUtil(kind, categoryId, newName);
    setVersion((v) => v + 1);
  }, [kind]);

  const handleDeleteCategory = useCallback((category: Category) => {
    const inCategory = getDefinitionsInCategory(kind, category.id);
    for (const defId of inCategory) {
      const def = definitions.find((d) => d.id === defId);
      if (def) onArchive(def);
    }
    deleteCategoryUtil(kind, category.id);
    if (activeCategoryId === category.id) {
      setActiveCategoryId(null);
      onFilterChange(null);
    }
    setVersion((v) => v + 1);
    setDeletingCategory(null);
  }, [kind, definitions, onArchive, activeCategoryId, onFilterChange]);

  const handleAssignCategory = useCallback((definitionId: string, categoryId: string | null) => {
    assignToCategory(kind, definitionId, categoryId);
    setVersion((v) => v + 1);
  }, [kind]);

  const categoryFiltered = useMemo(() => {
    if (isUncategorized) return filtered.filter((definition) => !categoryMap[definition.id]);
    return filtered.filter((definition) => categoryMap[definition.id] === activeCategoryId);
  }, [filtered, categoryMap, activeCategoryId, isUncategorized]);

  return (
    <div className="personalization-category-panel" role="region" aria-label={zh ? '分组管理' : 'Category management'}>
      <div className="personalization-category-panel__header">
        <span>{zh ? '分组' : 'Categories'}</span>
      </div>
      <div className="personalization-category-tree" role="tree">
        <button
          type="button"
          className={`personalization-category-tree__item ${isUncategorized ? 'active' : ''}`}
          onClick={() => handleSelectCategory(null)}
        >
          <FolderOpen size={13} aria-hidden="true" />
          <span>{zh ? '未分组' : 'Uncategorized'}</span>
          <span className="personalization-category-tree__count">{categoryFiltered.length}</span>
        </button>
        {categories.map((category) => {
          const count = getDefinitionsInCategory(kind, category.id).filter((id) =>
            categoryFiltered.some((d) => d.id === id),
          ).length;
          const isCollapsed = collapsed.has(category.id);
          const isActive = activeCategoryId === category.id;
          return (
            <div key={category.id} className={`personalization-category-tree__group ${isActive ? 'active' : ''}`}>
              <button
                type="button"
                className="personalization-category-tree__item"
                onClick={() => { toggleCollapse(category.id); handleSelectCategory(isActive ? null : category.id); }}
              >
                {isCollapsed
                  ? <ChevronRight size={13} aria-hidden="true" />
                  : <ChevronDown size={13} aria-hidden="true" />}
                {renamingId === category.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renameValue.trim()) { handleRenameCategory(category.id, renameValue.trim()); setRenamingId(null); }
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => setRenamingId(null)}
                    aria-label={zh ? '新名称' : 'New name'}
                  />
                ) : (
                  <span>{category.name}</span>
                )}
                <span className="personalization-category-tree__count">{count}</span>
                <span className="personalization-category-tree__actions">
                  <button
                    type="button"
                    title={zh ? '重命名' : 'Rename'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(category.id);
                      setRenameValue(category.name);
                    }}
                  >
                    <Pencil size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title={zh ? '删除' : 'Delete'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingCategory(category);
                    }}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </span>
              </button>
              {!isCollapsed && (
                <div className="personalization-category-tree__members">
                  {categoryFiltered
                    .filter((d) => categoryMap[d.id] === category.id)
                    .map((definition) => (
                      <button
                        key={definition.id}
                        type="button"
                        className="personalization-category-tree__member"
                        onClick={() => handleAssignCategory(definition.id, null)}
                        title={zh ? '移出分组' : 'Remove from category'}
                      >
                        <span>{definition.name}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          );
        })}
        <button type="button" className="personalization-category-tree__add" onClick={() => setNewCategoryOpen(true)}>
          <Plus size={13} aria-hidden="true" />
          <span>{zh ? '新建分组' : 'New category'}</span>
        </button>
        {newCategoryOpen && (
          <div className="personalization-category-tree__create">
            <input
              autoFocus
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateCategory();
                if (e.key === 'Escape') {
                  setNewCategoryOpen(false);
                  setNewCategoryName('');
                }
              }}
              placeholder={zh ? '分组名称' : 'Category name'}
            />
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={!newCategoryName.trim()}
              onClick={handleCreateCategory}
            >
              {zh ? '创建' : 'Create'}
            </button>
          </div>
        )}
      </div>
      {deletingCategory && (
        <div className="personalization-boundary" role="alert">
          <strong>{zh ? '删除分组' : 'Delete category'}</strong>
          <span>{zh ? `删除分组「${deletingCategory.name}」？其中的定义将移回未分组。` : `Delete category "${deletingCategory.name}"? Definitions will move back to uncategorized.`}</span>
          <div className="personalization-actions">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setDeletingCategory(null)}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => handleDeleteCategory(deletingCategory)}>
              {zh ? '删除' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
