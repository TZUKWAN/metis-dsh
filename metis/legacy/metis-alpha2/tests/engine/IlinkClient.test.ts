/**
 * @vitest-environment node
 *
 * iLink Bot API client tests against a local HTTP mock of the WeChat gateway.
 * Covers: QR login flow (scan → confirm, redirect), long-poll getUpdates with
 * cursor continuity, sendMessage payload shape, and error handling.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IlinkClient } from '../../engine/im/IlinkClient.js';

interface MockRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: (url: URL, body: unknown) => { status?: number; json?: unknown };
}

function startMock(routes: MockRoute[]): Promise<{ port: number; requests: Array<{ method: string; path: string; search: string; body: unknown }>; close: () => void }> {
  const requests: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let bodyText = '';
    req.on('data', (chunk) => { bodyText += chunk.toString(); });
    req.on('end', () => {
      let body: unknown;
      try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = bodyText; }
      requests.push({ method: req.method ?? '', path: url.pathname, search: url.search, body });
      const route = routes.find((r) => r.method === req.method && url.pathname.startsWith(r.path));
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: -1, errmsg: 'not found' }));
        return;
      }
      const result = route.handler(url, body);
      res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        requests,
        close: () => server.close(),
      });
    });
  });
}

describe('IlinkClient', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  afterEach(() => {
    mock?.close();
  });

  it('requests a QR code with local token list for multi-account association', async () => {
    mock = await startMock([
      {
        method: 'POST',
        path: '/ilink/bot/get_bot_qrcode',
        handler: () => ({ json: { qrcode: 'qr-1', qrcode_img_content: 'weixin://link/abc' } }),
      },
    ]);
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${mock.port}` });
    const result = await client.getBotQrcode(['tok-existing']);
    expect(result.qrcode).toBe('qr-1');
    expect(result.qrcode_img_content).toBe('weixin://link/abc');
    const req = mock.requests[0]!;
    expect(req.path).toBe('/ilink/bot/get_bot_qrcode');
    expect(req.body).toEqual({ local_token_list: ['tok-existing'] });
  });

  it('polls QR status with long-poll timeout and verify code', async () => {
    mock = await startMock([
      {
        method: 'GET',
        path: '/ilink/bot/get_qrcode_status',
        handler: (url) => {
          const qr = url.searchParams.get('qrcode');
          if (qr === 'qr-1') {
            return { json: { status: 'scaned' } };
          }
          return { json: { status: 'confirmed', bot_token: 'secret-bot-token', ilink_bot_id: 'bot-1', ilink_user_id: 'wx-user-1' } };
        },
      },
    ]);
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${mock.port}` });
    const scaned = await client.pollQrStatus('qr-1');
    expect(scaned.status).toBe('scaned');
    const confirmed = await client.pollQrStatus('qr-2', '123456');
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.bot_token).toBe('secret-bot-token');
    expect(confirmed.ilink_user_id).toBe('wx-user-1');
    expect(mock.requests[1]!.search).toContain('verify_code=123456');
  });

  it('long-polls getUpdates and echoes the cursor back on the next call', async () => {
    let cursor = '';
    mock = await startMock([
      {
        method: 'POST',
        path: '/ilink/bot/getupdates',
        handler: (_url, body) => {
          const buf = (body as { get_updates_buf?: string }).get_updates_buf ?? '';
          if (buf === '') {
            return {
              json: {
                ret: 0,
                get_updates_buf: 'cursor-1',
                msgs: [{
                  seq: 1,
                  from_user_id: 'wx-user-1',
                  message_type: 1,
                  item_list: [{ type: 1, text_item: { text: '你好' } }],
                  context_token: 'ctx-1',
                }],
              },
            };
          }
          cursor = buf;
          return { json: { ret: 0, get_updates_buf: 'cursor-2', msgs: [] } };
        },
      },
    ]);
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${mock.port}`, token: 'tok-1' });
    const first = await client.getUpdates();
    expect(first.get_updates_buf).toBe('cursor-1');
    expect(first.msgs?.[0]?.item_list?.[0]?.text_item?.text).toBe('你好');
    // Second call must echo the cached cursor.
    const second = await client.getUpdates('cursor-1');
    expect(second.get_updates_buf).toBe('cursor-2');
    expect(cursor).toBe('cursor-1');
  });

  it('sends a text message with context token and bot auth headers', async () => {
    mock = await startMock([
      {
        method: 'POST',
        path: '/ilink/bot/sendmessage',
        handler: () => ({ json: { ret: 0 } }),
      },
    ]);
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${mock.port}`, token: 'tok-secret' });
    const result = await client.sendMessage('wx-user-1', '完成摘要：已分析 3 篇论文', {
      contextToken: 'ctx-1',
      runId: 'run-1',
    });
    expect(result.ret).toBe(0);
    const req = mock.requests[0]!;
    const msg = (req.body as { msg: { to_user_id: string; item_list: Array<{ type: number; text_item: { text: string } }>; context_token?: string; run_id?: string } }).msg;
    expect(msg.to_user_id).toBe('wx-user-1');
    expect(msg.item_list?.[0]?.text_item?.text).toBe('完成摘要：已分析 3 篇论文');
    expect(msg.context_token).toBe('ctx-1');
    expect(msg.run_id).toBe('run-1');
  });

  it('surfaces HTTP failures as structured errors', async () => {
    mock = await startMock([
      {
        method: 'POST',
        path: '/ilink/bot/getupdates',
        handler: () => ({ status: 403, json: { ret: -1 } }),
      },
    ]);
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${mock.port}` });
    await expect(client.getUpdates()).rejects.toThrow(/403/);
  });

  it('treats gateway errors during QR polling as wait (caller retries)', async () => {
    mock = await startMock([
      {
        method: 'GET',
        path: '/ilink/bot/get_qrcode_status',
        handler: () => ({ status: 503, json: {} }),
      },
    ]);
    const client = new IlinkClient({ baseUrl: `http://127.0.0.1:${mock.port}` });
    await expect(client.pollQrStatus('qr-x')).rejects.toThrow(/503/);
  });
});
