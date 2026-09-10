/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatPage from '../../src/pages/ChatPage';

const metisMethods = () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue({ success: true, sessionId: 'session-a' }),
  getMessages: vi.fn().mockResolvedValue({ items: [], sessionId: 'session-a' }),
  appendMessage: vi.fn().mockResolvedValue(1),
  listArtifacts: vi.fn().mockResolvedValue([]),
  listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
  listSkills: vi.fn().mockResolvedValue([]),
  listProjects: vi.fn().mockResolvedValue({ success: true, projects: [] }),
});

function renderChat(overrides: Record<string, unknown> = {}) {
  const mocks = { ...metisMethods(), ...overrides };
  (window as unknown as { metis: unknown }).metis = mocks;
  return render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="normal" />);
}

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
});

describe('ChatPage slash keyboard navigation', () => {
  it('opens a listbox after typing / and selects with ArrowDown + Enter', async () => {
    renderChat();
    const input = await screen.findByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '/s' } });

    const listbox = await screen.findByRole('listbox', { name: /斜杠命令建议/ });
    const options = within(listbox).getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(within(listbox).getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true'));

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect((screen.getByPlaceholderText('提出一个研究问题...') as HTMLTextAreaElement).value).toMatch(/^\/s[a-z]* /));
  });

  it('closes with Escape and typing a space dismisses the suggestions', async () => {
    renderChat();
    const input = await screen.findByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '/go' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(input, { target: { value: '/go 分析' } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps Shift+Enter as a newline when the listbox is open', async () => {
    renderChat();
    const input = await screen.findByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '/go' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect((input as HTMLTextAreaElement).value).toBe('/go');
  });

  it('launches /autonomous with the active project id', async () => {
    const { researchWorkspaceStore } = await import('../../src/research/researchWorkspaceStore');
    researchWorkspaceStore.setState({ activeProjectId: 'project-x' });
    const autonomousStart = vi.fn().mockResolvedValue({ ok: true, sessionId: 'auto-1' });
    renderChat({ autonomousStart });

    const input = await screen.findByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '/autonomous 调研注意力机制' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(autonomousStart).toHaveBeenCalledWith(expect.objectContaining({ goal: '调研注意力机制', projectId: 'project-x' })));
  });
});
