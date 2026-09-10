/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OfficeRibbon, type OfficeRibbonTab } from '../../src/components/OfficeRibbon';

const tabs: OfficeRibbonTab[] = [
  { id: 'home', label: '开始', groups: [{ id: 'home-group', label: '开始组', content: <button type="button">粘贴</button> }] },
  { id: 'insert', label: '插入', groups: [{ id: 'insert-group', label: '插入组', content: <button type="button">表格</button> }] },
];

describe('OfficeRibbon', () => {
  it('renders the selected GenOffice-style tab and switches tabs', () => {
    const onTabChange = vi.fn();
    render(<OfficeRibbon tabs={tabs} activeTab="home" onTabChange={onTabChange} />);

    expect(screen.getByRole('tab', { name: '开始' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('开始组')).toBeTruthy();
    expect(screen.queryByText('插入组')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '插入' }));
    expect(onTabChange).toHaveBeenCalledWith('insert');
  });

  it('keeps the panel linked to the selected tab for keyboard users', () => {
    render(<OfficeRibbon tabs={tabs} activeTab="insert" onTabChange={vi.fn()} />);
    const tab = screen.getByRole('tab', { name: '插入' });
    expect(tab.getAttribute('aria-controls')).toBe('office-ribbon-panel-insert');
    expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('office-ribbon-panel-insert');
    expect(screen.getByRole('tabpanel').textContent).toContain('插入组');
  });
});
