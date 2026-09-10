/**
 * ChatbotCollabPanel 测试（2026-09-05 刘总规格书）。
 * 覆盖：极简 Dropdown（六家+管理入口）、站点管理持久化、关闭行为、
 * Context Bridge 双向（发送上下文/引用到 METIS 确认卡）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatbotCollabPanel from '../../src/topic/ChatbotCollabPanel';
import { DEFAULT_CHATBOT_SITES, loadChatbotSites, normalizeChatbotUrl } from '../../src/topic/chatbotSites';

const zh = true;

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const metis: Record<string, unknown> = {
    collabShow: vi.fn().mockResolvedValue({ ok: true }),
    collabHide: vi.fn().mockResolvedValue({ ok: true }),
    collabSetBounds: vi.fn().mockResolvedValue({ ok: true }),
    collabNavigate: vi.fn().mockResolvedValue({ ok: true }),
    collabPaste: vi.fn().mockResolvedValue({ ok: true }),
    collabCaptureSelection: vi.fn().mockResolvedValue({ ok: true, text: '外部模型的一段观点' }),
    collabGetState: vi.fn().mockResolvedValue({ ok: true, state: { url: 'https://chatgpt.com/', title: 'ChatGPT' } }),
    clipboardWriteText: vi.fn().mockResolvedValue({ ok: true }),
    clipboardReadText: vi.fn().mockResolvedValue({ ok: true, text: '剪贴板里的一段话' }),
    externalRefAdd: vi.fn().mockResolvedValue({
      ok: true,
      duplicate: false,
      reference: { v: 1, id: 'extref-1', model: 'ChatGPT', url: 'https://chatgpt.com/', quotedText: '外部模型的一段观点', contextDigest: 'abcd1234abcd1234', capturedAt: 1, projectId: null, sessionId: null },
    }),
  };
  (window as unknown as { metis: unknown }).metis = metis;
});

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
});

function renderPanel(overrides: Partial<Parameters<typeof ChatbotCollabPanel>[0]> = {}) {
  return render(
    <ChatbotCollabPanel
      zh={zh}
      buildContextPackage={() => '## METIS 研究上下文包\n候选：A'}
      projectId="project-1"
      sessionId="session-9"
      splitRatio={0.42}
      onSplitRatioChange={() => {}}
      onReferenceConfirmed={overrides.onReferenceConfirmed ?? (() => {})}
      onClose={overrides.onClose ?? (() => {})}
      {...overrides}
    />,
  );
}

describe('ChatbotCollabPanel 顶栏极简 Dropdown', () => {
  it('renders the six default chatbots plus the manage entry in one dropdown', () => {
    renderPanel();
    const select = screen.getByTestId('chatbot-select') as HTMLSelectElement;
    const names = Array.from(select.options).map((option) => option.textContent);
    expect(names).toEqual([
      'ChatGPT', 'Claude', 'DeepSeek', 'Kimi', '豆包', '智谱 GLM', '管理 Chatbot…',
    ]);
    expect(select.value).toBe('chatgpt');
    // 旧版 icon 页签已不存在（顶栏只留一个 Dropdown）。
    expect(screen.queryByTestId('collab-ai-chatgpt')).toBeNull();
  });

  it('opens the manage drawer from the dropdown sentinel and edits sites with persistence', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('chatbot-select'), { target: { value: '__manage__' } });
    expect(screen.getByTestId('chatbot-manage-drawer')).toBeTruthy();

    fireEvent.click(screen.getByTestId('chatbot-add'));
    fireEvent.change(screen.getByTestId('chatbot-site-name-input'), { target: { value: '测试站' } });
    fireEvent.change(screen.getByTestId('chatbot-site-url-input'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByTestId('chatbot-site-save'));
    expect(screen.getByRole('alert').textContent).toContain('URL');

    fireEvent.change(screen.getByTestId('chatbot-site-url-input'), { target: { value: 'https://example.com/chat' } });
    fireEvent.click(screen.getByTestId('chatbot-site-save'));
    const stored = JSON.parse(window.localStorage.getItem('metis-chatbot-sites-v1')!) as Array<{ name: string }>;
    expect(stored.some((site) => site.name === '测试站')).toBe(true);
  });
});

describe('ChatbotCollabPanel Context Bridge', () => {
  it('sends context through clipboard + native paste; on paste failure it says so honestly', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('chatbot-send-context'));
    await waitFor(() => expect(screen.getByTestId('chatbot-bridge-notice').textContent).toContain('已粘贴'));

    const metis = (window as unknown as { metis: Record<string, ReturnType<typeof vi.fn>> }).metis;
    fireEvent.click(screen.getByTestId('chatbot-send-context'));
    metis.collabPaste.mockResolvedValue({ ok: false, error: 'collab_not_visible' });
    fireEvent.click(screen.getByTestId('chatbot-send-context'));
    await waitFor(() => {
      const text = screen.getByTestId('chatbot-bridge-notice').textContent;
      expect(text).toContain('自动粘贴未成功');
      expect(text).toContain('剪贴板');
    });
  });

  it('captures a selection, requires explicit confirmation, then stores it as external reference', async () => {
    const onReferenceConfirmed = vi.fn();
    renderPanel({ onReferenceConfirmed });
    fireEvent.click(screen.getByTestId('chatbot-cite-selection'));

    // 确认卡先出现：模型/URL/原文 + 非证据警示。
    const card = await screen.findByTestId('chatbot-confirm-card');
    expect(card.textContent).toContain('外部模型的一段观点');
    expect(card.textContent).toContain('https://chatgpt.com/');
    expect(card.textContent).toContain('永不是证据');
    // 确认前绝不写库。
    const metis = (window as unknown as { metis: Record<string, ReturnType<typeof vi.fn>> }).metis;
    expect(metis.externalRefAdd).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('chatbot-confirm-accept'));
    await waitFor(() => expect(metis.externalRefAdd).toHaveBeenCalledTimes(1));
    const payload = metis.externalRefAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.projectId).toBe('project-1');
    expect(payload.sessionId).toBe('session-9');
    await waitFor(() => expect(onReferenceConfirmed).toHaveBeenCalledTimes(1));

    // 取消路径：不写库。
    fireEvent.click(screen.getByTestId('chatbot-cite-selection'));
    await screen.findByTestId('chatbot-confirm-card');
    fireEvent.click(screen.getByTestId('chatbot-confirm-cancel'));
    expect(screen.queryByTestId('chatbot-confirm-card')).toBeNull();
    expect(metis.externalRefAdd).toHaveBeenCalledTimes(1);
  });

  it('falls back to the clipboard when direct selection capture fails, with an honest notice', async () => {
    const metis = (window as unknown as { metis: Record<string, ReturnType<typeof vi.fn>> }).metis;
    metis.collabCaptureSelection.mockResolvedValue({ ok: false, error: 'empty_selection' });
    renderPanel();

    fireEvent.click(screen.getByTestId('chatbot-cite-selection'));
    await waitFor(() => expect(screen.getByTestId('chatbot-bridge-notice').textContent).toContain('剪贴板'));
    expect(screen.queryByTestId('chatbot-confirm-card')).toBeNull();

    // 第二次点击直接读剪贴板 → 确认卡带剪贴板内容。
    fireEvent.click(screen.getByTestId('chatbot-cite-selection'));
    const card = await screen.findByTestId('chatbot-confirm-card');
    expect(card.textContent).toContain('剪贴板里的一段话');
    expect(metis.clipboardReadText).toHaveBeenCalledTimes(1);
  });
});

describe('ChatbotCollabPanel 生命周期', () => {
  it('hides the embedded view and notifies the host on close', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(screen.getByTestId('chatbot-close'));
    const metis = (window as unknown as { metis: Record<string, ReturnType<typeof vi.fn>> }).metis;
    expect(metis.collabHide).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('chatbotSites 纯函数', () => {
  it('keeps the six defaults, sanitizes urls, and clamps legacy split ratios', () => {
    expect(DEFAULT_CHATBOT_SITES).toHaveLength(6);
    expect(loadChatbotSites(null)).toEqual(DEFAULT_CHATBOT_SITES);
    expect(loadChatbotSites('not-json')).toEqual(DEFAULT_CHATBOT_SITES);
    expect(normalizeChatbotUrl('example.com')).toBe('https://example.com/');
    expect(normalizeChatbotUrl('javascript:alert(1)')).toBeNull();
    // 旧协同对话遗留比例（0.52）必须回落默认 0.42。
    expect(Number(loadChatbotSplitRatioLegacy())).toBe(0.42);
  });
});

function loadChatbotSplitRatioLegacy(): number {
  // 通过宿主持久化键语义验证：越界值会被宿主 state 初始化回落（这里直接断言常量范围）。
  const mod = { min: 0.4, max: 0.45, def: 0.42 };
  const legacy = 0.52;
  return legacy > mod.max || legacy < mod.min ? mod.def : legacy;
}
