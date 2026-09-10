/**
 * Regression guard: LLM planning must succeed over a real OpenAI-compatible
 * SSE stream (terminated by [DONE]). A previous stub served plain JSON without
 * [DONE]; after network-interruption hardening the provider correctly rejects
 * that, which silently degraded every plan to the template fallback.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { GoalEngine } from '../../engine/goal/GoalEngine.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';

const workflow = {
  id: 'wf_test_plan', name: 'Test plan',
  steps: [{ id: 's1', name: 'S1', prompt: 'do the step', inputFrom: [] as string[], tools: [] as string[], maxTurns: 2 }],
  dependencies: {} as Record<string, string[]>,
};

let server: http.Server;
let port = 0;
let planningHits = 0;
let sawDone = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const systemText = (body.messages ?? []).filter((m: { role?: string }) => m?.role === 'system').map((m: { content?: unknown }) => String(m.content ?? '')).join('\n');
      if (!systemText.includes('planning assistant')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'e1', object: 'chat.completion', created: 1, model: 'stub', choices: [{ index: 0, message: { role: 'assistant', content: 'step output' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
        return;
      }
      planningHits += 1;
      expect(body.stream).toBe(true);
      const chunk = (delta: unknown, finish: string | null = null) => JSON.stringify({ id: 'p1', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${chunk({ role: 'assistant', content: '' })}\n\n`);
      res.write(`data: ${chunk({ content: JSON.stringify(workflow) })}\n\n`);
      res.write(`data: ${chunk({}, 'stop')}\n\n`);
      res.write('data: [DONE]\n\n');
      sawDone = true;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('LLM planning over strict SSE stream', () => {
  it('uses the agent plan instead of the template fallback when [DONE] terminates the stream', async () => {
    const provider = new OpenAICompatProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-stub', model: 'stub-model', timeout: 15_000, maxRetries: 1, retryBackoffSeconds: 0 });
    const engine = new GoalEngine(new AgentLoop({ provider, registry: new ToolRegistry() }));
    const goal = engine.createGoal('repro planning continuity', '');
    const result = await engine.generatePlan(goal.id);
    expect(planningHits).toBeGreaterThan(0);
    expect(sawDone).toBe(true);
    expect(result.reasoning).toContain('LLM');
    expect(result.workflow.steps.length).toBeGreaterThan(0);
    expect(result.workflow.id).not.toMatch(/^wf_(lit|analysis|write|exp|generic)_/);
    void port;
  });
});
