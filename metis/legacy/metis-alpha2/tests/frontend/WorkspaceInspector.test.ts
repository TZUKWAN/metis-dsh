/**
 * METIS-503 / METIS-504 — WorkspaceHost state preservation + ResearchInspector resolution.
 *
 * METIS-503: mode switch preserves scroll/selection/draft per object.
 * METIS-504: inspector tab follows the center selection; pinning overrides.
 */

import { describe, it, expect } from 'vitest';
import { createWorkspaceStateStore } from '../../src/shell/WorkspaceHost.js';
import { resolveInspectorTab, canAskMetisAbout, type SelectionContext } from '../../src/shell/ResearchInspector.js';
import type { InspectorTab } from '../../src/shell/ProjectShell.js';

describe('METIS-503 WorkspaceHost — state preserved across mode switches', () => {
  it('saves and loads per-mode, per-object state', () => {
    const ws = createWorkspaceStateStore();
    ws.save('read', 'pdf-1', { scrollTop: 1200, selectionId: 'para-3', draftText: '' });
    const s = ws.load('read', 'pdf-1')!;
    expect(s.scrollTop).toBe(1200);
    expect(s.selectionId).toBe('para-3');
  });

  it('does not cross-contaminate modes (read scroll stays out of write)', () => {
    const ws = createWorkspaceStateStore();
    ws.save('read', 'pdf-1', { scrollTop: 500 });
    ws.save('write', 'pdf-1', { scrollTop: 999 });
    expect(ws.load('read', 'pdf-1')?.scrollTop).toBe(500);
    expect(ws.load('write', 'pdf-1')?.scrollTop).toBe(999);
  });

  it('preserves a draft when the user leaves and returns to the same object+mode', () => {
    const ws = createWorkspaceStateStore();
    ws.save('write', 'ms-1', { draftText: '未完成的段落…' });
    // user switches to read mode, comes back
    ws.save('read', 'pdf-2', { scrollTop: 100 });
    expect(ws.load('write', 'ms-1')?.draftText).toBe('未完成的段落…');
  });

  it('tracks visited objects per mode', () => {
    const ws = createWorkspaceStateStore();
    ws.save('read', 'a', { scrollTop: 0 });
    ws.save('read', 'b', { scrollTop: 0 });
    expect(ws.visited('read').sort()).toEqual(['a', 'b']);
    expect(ws.visited('write')).toEqual([]);
  });

  it('clear resets a mode', () => {
    const ws = createWorkspaceStateStore();
    ws.save('read', 'a', { scrollTop: 1 });
    ws.clear('read');
    expect(ws.visited('read')).toEqual([]);
  });
});

describe('METIS-504 ResearchInspector — tab follows selection', () => {
  const cases: Array<{ sel: SelectionContext; expectTab: InspectorTab }> = [
    { sel: { kind: 'pdf_paragraph', id: 'p1' }, expectTab: 'evidence' },
    { sel: { kind: 'chart_datapoint', id: 'd1' }, expectTab: 'evidence' },
    { sel: { kind: 'claim', id: 'c1' }, expectTab: 'properties' },
    { sel: { kind: 'manuscript_paragraph', id: 'm1' }, expectTab: 'properties' },
    { sel: { kind: 'source', id: 's1' }, expectTab: 'properties' },
    { sel: { kind: 'none', id: null }, expectTab: 'metis' },
  ];
  for (const c of cases) {
    it(`selecting ${c.sel.kind} surfaces the ${c.expectTab} tab`, () => {
      expect(resolveInspectorTab(c.sel, null).tab).toBe(c.expectTab);
    });
  }

  it('pinned tab overrides selection (until unpinned)', () => {
    const r = resolveInspectorTab({ kind: 'claim', id: 'c1' }, 'plan');
    expect(r.tab).toBe('plan');
    expect(r.pinned).toBe(true);
  });

  it('unpinning lets selection take over again', () => {
    expect(resolveInspectorTab({ kind: 'claim', id: 'c1' }, null).tab).toBe('properties');
  });

  it('canAskMetisAbout is true for any concrete selection, false for none', () => {
    expect(canAskMetisAbout({ kind: 'pdf_paragraph', id: 'p1' })).toBe(true);
    expect(canAskMetisAbout({ kind: 'none', id: null })).toBe(false);
  });
});
