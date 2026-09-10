/**
 * @vitest-environment node
 *
 * METIS-WX-2 — provider vision serialization tests: inline images become
 * OpenAI image_url content blocks only when the model declares vision.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';

function startCompletionServer(): Promise<{
  port: number;
  bodies: Array<Record<string, unknown>>;
  close: () => void;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let bodyText = '';
    req.on('data', (chunk) => { bodyText += chunk.toString(); });
    req.on('end', () => {
      bodies.push(JSON.parse(bodyText || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ port: address.port, bodies, close: () => server.close() });
    });
  });
}

describe('provider vision serialization', () => {
  let server: Awaited<ReturnType<typeof startCompletionServer>>;

  afterEach(() => {
    server?.close();
  });

  it('serializes inline images as OpenAI image_url content blocks when vision is declared', async () => {
    server = await startCompletionServer();
    const provider = new OpenAICompatProvider({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'sk-test',
      model: 'glm-5v-turbo',
      vision: true,
    });
    const result = await provider.complete(
      [{
        role: 'user',
        content: '分析这张图片',
        images: [{ mime: 'image/jpeg', dataBase64: 'aGVsbG8=' }],
      }],
      undefined,
      {},
    );
    expect(result.content).toBe('ok');
    const message = server.bodies[0]!.messages as Array<{ content: unknown }>;
    const content = message[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: '分析这张图片' });
    expect(content[1]!.type).toBe('image_url');
    expect(content[1]!.image_url!.url).toBe('data:image/jpeg;base64,aGVsbG8=');
  });

  it('drops image content when the model does not declare vision', async () => {
    server = await startCompletionServer();
    const provider = new OpenAICompatProvider({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      vision: false,
    });
    await provider.complete(
      [{
        role: 'user',
        content: '纯文本',
        images: [{ mime: 'image/png', dataBase64: 'eA==' }],
      }],
      undefined,
      {},
    );
    const message = server.bodies[0]!.messages as Array<{ content: unknown }>;
    expect(message[0]!.content).toBe('纯文本');
  });
});
