import type { ReactNode } from 'react';
import './OfficeRibbon.css';

export type OfficeRibbonGroup = Readonly<{
  id: string;
  label: string;
  content: ReactNode;
}>;

export type OfficeRibbonTab = Readonly<{
  id: string;
  label: string;
  groups: readonly OfficeRibbonGroup[];
}>;

export type OfficeRibbonProps = Readonly<{
  tabs: readonly OfficeRibbonTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  status?: ReactNode;
}>;

export function OfficeRibbonTabButton({ tab, active, onSelect }: { tab: OfficeRibbonTab; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={`office-ribbon-panel-${tab.id}`}
      className={`office-ribbon__tab${active ? ' is-active' : ''}`}
      onClick={onSelect}
    >
      {tab.label}
    </button>
  );
}

export function OfficeRibbon({ tabs, activeTab, onTabChange, leading, trailing, status }: OfficeRibbonProps) {
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  if (!selected) return null;

  return (
    <section className="office-ribbon" aria-label="Office 编辑工具栏">
      <div className="office-ribbon__topline">
        {leading && <div className="office-ribbon__leading">{leading}</div>}
        <div className="office-ribbon__tabs" role="tablist" aria-label="Office 功能区">
          {tabs.map((tab) => (
            <OfficeRibbonTabButton key={tab.id} tab={tab} active={tab.id === selected.id} onSelect={() => onTabChange(tab.id)} />
          ))}
        </div>
        {trailing && <div className="office-ribbon__trailing">{trailing}</div>}
      </div>
      <div className="office-ribbon__panel" id={`office-ribbon-panel-${selected.id}`} role="tabpanel" aria-label={`${selected.label}功能区`}>
        {selected.groups.map((group) => (
            <section className="office-ribbon__group" key={group.id} aria-label={`${group.label}工具组`}>
            <div className="office-ribbon__group-content">{group.content}</div>
            <small>{group.label}</small>
          </section>
        ))}
      </div>
      {status && <div className="office-ribbon__status" role="status">{status}</div>}
    </section>
  );
}
