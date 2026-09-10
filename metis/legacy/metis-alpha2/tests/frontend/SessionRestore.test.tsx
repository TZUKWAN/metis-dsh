/**
 * Session restore: the app remembers the last navigation location and active
 * project in localStorage, and restores them on the next launch.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within, screen } from '@testing-library/react';
import App from '../../src/App';
import { useMetisStore } from '../../src/store';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

const SESSION_KEY = 'metis-session';

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    locale: 'zh',
    theme: 'light',
    isHydrated: true,
  });
  researchWorkspaceStore.setState({ activeProjectId: null });
}

/** The navigation button whose aria-current marks the active entry. */
function activeNavButton() {
  const nav = screen.getByRole('navigation', { name: 'Metis' });
  return within(nav).getAllByRole('button').find((button) => button.getAttribute('aria-current') === 'page');
}

describe('App session restore', () => {
  beforeEach(() => {
    resetStore();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('restores the saved navigation entry on launch', async () => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ entry: 'settings', mode: 'converse', projectId: null }));
    render(<App />);
    await waitFor(() => {
      expect(activeNavButton()?.getAttribute('data-nav-id')).toBe('settings');
      expect(document.querySelector('.settings-page, .settings-group')).toBeTruthy();
    });
  });

  it('migrates legacy browser/library entries to the projects entry', async () => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ entry: 'library', mode: 'converse', projectId: null }));
    render(<App />);
    // 迁移后落在科研项目入口（协同对话一级已取消，2026-09-05 刘总规格）。
    await waitFor(() => {
      expect(activeNavButton()?.getAttribute('data-nav-id')).toBe('projects');
      expect(document.querySelector('.library-page')).toBeNull();
    });
  });

  it('saves navigation changes back to localStorage', async () => {
    render(<App />);
    await waitFor(() => {
      expect(activeNavButton()?.getAttribute('data-nav-id')).toBe('projects');
    });

    const settingsNav = within(screen.getByRole('navigation', { name: 'Metis' }))
      .getAllByRole('button')
      .find((button) => button.getAttribute('data-nav-id') === 'settings')!;
    fireEvent.click(settingsNav);

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(SESSION_KEY) ?? 'null') as
        { entry?: unknown; mode?: unknown; projectId?: unknown };
      expect(saved.entry).toBe('settings');
      expect(saved.mode).toBe('projects');
      // No project is active yet, so projectId is persisted as null.
      expect(saved.projectId).toBeNull();
    });
  });

  it('seeds the active project id for the workspace store', async () => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ entry: 'projects', mode: 'projects', projectId: 'p-restored' }));
    render(<App />);
    await waitFor(() => {
      expect(activeNavButton()?.getAttribute('data-nav-id')).toBe('projects');
    });
    expect(researchWorkspaceStore.getState().activeProjectId).toBe('p-restored');
  });

  it('ignores corrupt session data without breaking the app', async () => {
    window.localStorage.setItem(SESSION_KEY, '{not valid json');
    render(<App />);
    await waitFor(() => {
      // Falls back to the default projects entry and stays functional.
      expect(activeNavButton()?.getAttribute('data-nav-id')).toBe('projects');
    });
    expect(researchWorkspaceStore.getState().activeProjectId).toBeNull();
  });

  it('ignores sessions with unknown entries', async () => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ entry: 'hacked', mode: 'projects', projectId: null }));
    render(<App />);
    await waitFor(() => {
      expect(activeNavButton()?.getAttribute('data-nav-id')).toBe('projects');
    });
  });
});
