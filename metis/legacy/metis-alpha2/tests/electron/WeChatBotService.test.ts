/**
 * @vitest-environment node
 *
 * WeChatBotService tests — QR login flow, message routing, command handling,
 * numeric menus, busy queueing, cursor persistence, and secure token storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WeChatBotService, cleanForWechat } from '../../electron/WeChatBotService.js';
import type { IlinkClient } from '../../engine/im/IlinkClient.js';
import type {
  GetUpdatesResponse,
  QrCodeResponse,
  QrStatusResponse,
} from '../../engine/im/types.js';

interface FakeClient {
  getBotQrcode: ReturnType<typeof vi.fn<(tokens: string[]) => Promise<QrCodeResponse>>>;
  pollQrStatus: ReturnType<typeof vi.fn<(qr: string, code?: string) => Promise<QrStatusResponse>>>;
  getUpdates: ReturnType<typeof vi.fn<(buf?: string) => Promise<GetUpdatesResponse>>>;
  sendMessage: ReturnType<typeof vi.fn<(to: string, text: string, opts?: unknown) => Promise<{ ret: number }>>>;
  sendTyping: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  notifyStart: ReturnType<typeof vi.fn>;
  notifyStop: ReturnType<typeof vi.fn>;
  setToken: ReturnType<typeof vi.fn>;
  setBaseUrl: ReturnType<typeof vi.fn>;
  currentBaseUrl: string;
}

import { vi } from 'vitest';

function makeFakeClient(): FakeClient {
  return {
    getBotQrcode: vi.fn(async () => ({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/qr/1' })),
    pollQrStatus: vi.fn(async () => ({ status: 'wait' })),
    getUpdates: vi.fn(async () => ({ ret: 0, get_updates_buf: 'cur-1', msgs: [] })),
    sendMessage: vi.fn(async () => ({ ret: 0 })),
    sendTyping: vi.fn(async () => ({ ret: 0 })),
    getConfig: vi.fn(async () => ({ ret: 0, typing_ticket: 'ticket-1' })),
    notifyStart: vi.fn(async () => ({ ret: 0 })),
    notifyStop: vi.fn(async () => ({ ret: 0 })),
    setToken: vi.fn(),
    setBaseUrl: vi.fn(),
    currentBaseUrl: 'https://fake.ilink',
  };
}

function makeService(client: FakeClient, overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-wxbot-'));
  const statePath = path.join(dir, 'bot-state.json');
  const runTurn = vi.fn(async ({ userText }: { userText: string }) => ({
    ok: true,
    answer: `已处理：${userText}`,
  }));
  const service = new WeChatBotService({
    client: client as unknown as IlinkClient,
    store: {
      // Obfuscating cipher: the ciphertext never contains the plaintext, so we
      // can assert plaintext never leaks into the state file.
      encrypt: (plain: string) => `enc:${Buffer.from(plain).toString('base64').split('').reverse().join('')}`,
      decrypt: (cipher: string) => {
        if (!cipher.startsWith('enc:')) return '';
        return Buffer.from(cipher.slice(4).split('').reverse().join(''), 'base64').toString('utf-8');
      },
    },
    statePath,
    mediaDir: path.join(dir, 'media'),
    downloadMedia: async () => ({ buffer: Buffer.from('fake media bytes'), mime: 'application/octet-stream', extension: 'bin', bytes: 15 }),
    runTurn,
    listProjects: () => [
      { id: 'proj-a', title: 'RAG 调研' },
      { id: 'proj-b', title: 'Attention 综述' },
    ],
    getModelName: () => 'glm-5-turbo',
    ...overrides,
  });
  return { service, statePath, runTurn, dir };
}

function userMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    from_user_id: 'wx-user-1',
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: 'ctx-1',
    ...overrides,
  };
}

describe('WeChatBotService', () => {
  let fx: { service: WeChatBotService; statePath: string; runTurn: ReturnType<typeof vi.fn>; dir: string };
  let client: FakeClient;

  beforeEach(() => {
    client = makeFakeClient();
    fx = makeService(client);
  });

  afterEach(async () => {
    await fx.service.stop().catch(() => {});
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  it('walks the QR login flow to bound and persists an encrypted token', async () => {
    client.getBotQrcode.mockResolvedValue({ qrcode: 'qr-x', qrcode_img_content: 'weixin://qr/x' });
    client.pollQrStatus
      .mockResolvedValueOnce({ status: 'wait' })
      .mockResolvedValueOnce({ status: 'scaned' })
      .mockResolvedValueOnce({ status: 'confirmed', bot_token: 'bot-tok-1', ilink_bot_id: 'bot-1', ilink_user_id: 'wx-user-1' });

    const begin = await fx.service.beginLogin();
    expect(begin.ok).toBe(true);
    expect(begin.qrContent).toBe('weixin://qr/x');
    expect(client.getBotQrcode).toHaveBeenCalledWith([]);

    expect((await fx.service.pollLogin()).phase).toBe('login_pending'); // wait
    // Regression: status polls must use the raw QR token, never the rendered
    // image URL — the gateway answers 'expired' for the full URL.
    expect(client.pollQrStatus).toHaveBeenCalledWith('qr-x', undefined);
    expect((await fx.service.pollLogin()).phase).toBe('login_scaned');
    const done = await fx.service.pollLogin();
    expect(done.phase).toBe('bound');
    expect(done.ok).toBe(true);

    const status = fx.service.getStatus();
    expect(status.phase).toBe('bound');
    expect(status.botId).toBe('bot-1');
    expect(status.userId).toBe('wx-user-1');

    // Token is stored encrypted; plaintext never touches the state file.
    const raw = fs.readFileSync(fx.statePath, 'utf-8');
    expect(raw).toContain('enc:');
    expect(raw).not.toContain('bot-tok-1');
    expect(raw).toContain('"tokenCipher"');
  });

  it('restores a bound session on restart using the encrypted token', async () => {
    client.getBotQrcode.mockResolvedValue({ qrcode: 'qr-x', qrcode_img_content: 'weixin://qr/x' });
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 'tok-restore', ilink_bot_id: 'bot-9', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();
    await fx.service.stop();

    const client2 = makeFakeClient();
    const fx2 = makeService(client2, { statePath: fx.statePath });
    fx2.service.start();
    expect(fx2.service.getStatus().phase).toBe('bound');
    expect(client2.setToken).toHaveBeenCalledWith('tok-restore');
    await fx2.service.stop();
    fs.rmSync(fx2.dir, { recursive: true, force: true });
  });

  it('routes user text through runTurn and replies with a cleaned summary', async () => {
    // Bind directly by simulating a completed login.
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    client.getUpdates.mockResolvedValue({
      ret: 0,
      get_updates_buf: 'cur-2',
      msgs: [userMessage('帮我分析一下 RAG 的现状')],
    });
    await fx.service.runOnce();

    expect(fx.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.stringMatching(/^wx:wx-user-1:\d+$/),
      userText: '帮我分析一下 RAG 的现状',
    }));
    expect(client.sendMessage).toHaveBeenCalledWith(
      'wx-user-1',
      '已处理：帮我分析一下 RAG 的现状',
      expect.objectContaining({ contextToken: 'ctx-1' }),
    );
    // Cursor persisted after processing.
    expect(fs.readFileSync(fx.statePath, 'utf-8')).toContain('cur-2');
  });

  it('replies with a busy notice instead of queueing while a turn runs', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    let releaseTurn: () => void = () => {};
    fx.runTurn.mockImplementation(() => new Promise((resolve) => {
      releaseTurn = () => resolve({ ok: true, answer: 'done' });
    }));
    const turnPromise = fx.service.sendTestMessage('第一个任务');
    const busyResult = await fx.service.sendTestMessage('第二个任务');
    expect(busyResult.ok).toBe(false);
    expect(busyResult.error).toBe('busy');
    expect(client.sendMessage).toHaveBeenCalledWith('wx-user-1', expect.stringContaining('正在处理上一条任务'), expect.anything());
    releaseTurn();
    await turnPromise;
  });

  it('handles commands: /状态 /新建 /项目 with numeric menu selection', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    // A normal message creates the persisted session.
    client.getUpdates.mockResolvedValue({ ret: 0, get_updates_buf: 'c', msgs: [userMessage('你好')] });
    await fx.service.runOnce();
    expect(fx.service.getStatus().activeSessionId).toMatch(/^wx:wx-user-1:/);

    // /状态 lists current model + project binding.
    client.getUpdates.mockResolvedValue({ ret: 0, get_updates_buf: 'c', msgs: [userMessage('/状态')] });
    await fx.service.runOnce();
    const statusReply = client.sendMessage.mock.calls.at(-1)![1] as string;
    expect(statusReply).toContain('glm-5-turbo');
    expect(statusReply).toContain('未绑定');

    // /项目 lists a numbered menu.
    client.getUpdates.mockResolvedValue({ ret: 0, get_updates_buf: 'c', msgs: [userMessage('/项目')] });
    await fx.service.runOnce();
    const menuReply = client.sendMessage.mock.calls.at(-1)![1] as string;
    expect(menuReply).toContain('1. RAG 调研');
    expect(menuReply).toContain('2. Attention 综述');

    // Reply "2" selects the second project.
    client.getUpdates.mockResolvedValue({ ret: 0, get_updates_buf: 'c', msgs: [userMessage('2')] });
    await fx.service.runOnce();
    const selectReply = client.sendMessage.mock.calls.at(-1)![1] as string;
    expect(selectReply).toContain('Attention 综述');
    expect(fx.service.getStatus().activeProjectId).toBe('proj-b');

    // /项目 <keyword> switches directly.
    client.getUpdates.mockResolvedValue({ ret: 0, get_updates_buf: 'c', msgs: [userMessage('/项目 rag')] });
    await fx.service.runOnce();
    expect(fx.service.getStatus().activeProjectId).toBe('proj-a');

    // /新建 rotates the session id.
    const before = fx.service.getStatus().activeSessionId;
    client.getUpdates.mockResolvedValue({ ret: 0, get_updates_buf: 'c', msgs: [userMessage('/新建')] });
    await fx.service.runOnce();
    const after = fx.service.getStatus().activeSessionId;
    expect(before).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('resets the cursor on session timeout errcode -14', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    client.getUpdates.mockResolvedValue({ ret: -14, errcode: -14, msgs: [] });
    await fx.service.runOnce();
    expect(fs.readFileSync(fx.statePath, 'utf-8')).toContain('"getUpdatesBuf": ""');
  });

  it('cleans markdown for WeChat display', () => {
    const cleaned = cleanForWechat('# 标题\n\n**重点** 内容\n\n```code\nblock\n```\n\n- 列表项');
    expect(cleaned).toContain('标题');
    expect(cleaned).not.toContain('# ');
    expect(cleaned).not.toContain('```');
    expect(cleaned).toContain('- 列表项');
  });

  it('acknowledges media messages without breaking the flow', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    // Image without downloadable CDN info: polite acknowledgment, no agent turn.
    client.getUpdates.mockResolvedValue({
      ret: 0,
      get_updates_buf: 'c',
      msgs: [userMessage('', {
        item_list: [{ type: 2, image_item: { url: 'x' } }],
      })],
    });
    await fx.service.runOnce();
    expect(fx.runTurn).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith('wx-user-1', expect.stringContaining('图片'), expect.anything());
  });

  it('downloads inbound files, saves them and hands them to the agent', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    client.getUpdates.mockResolvedValue({
      ret: 0,
      get_updates_buf: 'c',
      msgs: [userMessage('', {
        item_list: [{
          type: 4,
          file_item: {
            file_name: 'survey.pdf',
            media: { full_url: 'https://cdn.example/media', aes_key: Buffer.alloc(16, 7).toString('base64') },
          },
        }],
      })],
    });
    await fx.service.runOnce();

    expect(fx.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      userText: '请分析我发送的文件',
      attachments: [
        expect.objectContaining({ name: expect.stringMatching(/survey\.pdf$/), mime: expect.any(String) }),
      ],
    }));
    // The file was actually written to the media dir.
    const attachment = fx.runTurn.mock.calls[0]![0].attachments?.[0] as { path: string };
    expect(fs.existsSync(attachment.path)).toBe(true);
    expect(fs.readFileSync(attachment.path, 'utf-8')).toBe('fake media bytes');
    // Reply flows back after the agent finishes.
    expect(client.sendMessage).toHaveBeenCalledWith('wx-user-1', '已处理：请分析我发送的文件', expect.anything());
  });

  it('saves images locally with a path notice (no agent turn)', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    client.getUpdates.mockResolvedValue({
      ret: 0,
      get_updates_buf: 'c',
      msgs: [userMessage('', {
        item_list: [{
          type: 2,
          image_item: { media: { full_url: 'https://cdn.example/img', aes_key: Buffer.alloc(16, 3).toString('base64') } },
        }],
      })],
    });
    await fx.service.runOnce();

    expect(fx.runTurn).not.toHaveBeenCalled();
    const reply = client.sendMessage.mock.calls.at(-1)![1] as string;
    expect(reply).toContain('已收到图片并保存到本地');
    expect(reply).toMatch(/wechat-media|media/);
  });

  it('hands images to the agent when the provider supports vision', async () => {
    const fxVision = makeService(client, { supportsVision: () => true });
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fxVision.service.beginLogin();
    await fxVision.service.pollLogin();

    client.getUpdates.mockResolvedValue({
      ret: 0,
      get_updates_buf: 'c',
      msgs: [userMessage('', {
        item_list: [{
          type: 2,
          image_item: { media: { full_url: 'https://cdn.example/img', aes_key: Buffer.alloc(16, 3).toString('base64') } },
        }],
      })],
    });
    await fxVision.service.runOnce();

    expect(fxVision.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      userText: '请分析这张图片',
      images: [
        expect.objectContaining({ dataBase64: expect.any(String), mime: expect.any(String) }),
      ],
    }));
    const images = fxVision.runTurn.mock.calls[0]![0].images as Array<{ dataBase64: string }>;
    expect(Buffer.from(images[0]!.dataBase64, 'base64').toString('utf-8')).toBe('fake media bytes');
    await fxVision.service.stop();
    fs.rmSync(fxVision.dir, { recursive: true, force: true });
  });

  it('uses gateway voice transcription when provided', async () => {
    client.pollQrStatus.mockResolvedValue({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'wx-user-1' });
    await fx.service.beginLogin();
    await fx.service.pollLogin();

    client.getUpdates.mockResolvedValue({
      ret: 0,
      get_updates_buf: 'c',
      msgs: [userMessage('', {
        item_list: [{
          type: 3,
          voice_item: { text: '语音转文字内容：请总结这篇论文', media: { full_url: 'u', aes_key: 'k' } },
        }],
      })],
    });
    await fx.service.runOnce();

    expect(fx.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      userText: '语音转文字内容：请总结这篇论文',
    }));
  });
});
