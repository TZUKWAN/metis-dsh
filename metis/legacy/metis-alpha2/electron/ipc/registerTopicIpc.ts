/**
 * Topic (选题) domain IPC registrar — Task 3 §4.
 *
 * Migrated verbatim from `electron/main.ts` (channel names, request schemas,
 * recovery shapes and the `topic:stream-chunk` forwarding contract are
 * unchanged; this file only relocates registration and receives former module
 * state through {@link DomainIpcContext}). Conversation streaming internals
 * are NOT modified — `topic:chat` keeps its hook-based token forwarding.
 */

import { z } from 'zod';
import {
  TopicChatRequestSchema,
  TopicSessionCreateRequestSchema,
  TopicSessionUpdatePatchSchema,
  TopicCandidateUpsertSchema,
  type TopicCandidateDto,
} from '../../engine/runtime/TopicRuntimeContract.js';
import { trackEphemeralOperation } from '../RuntimeShutdownCoordinator.js';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerTopicIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, runtimeShutdown, ensureTopicService } = ctx;
  const agentLoop = (): ReturnType<DomainIpcContext['agentLoop']> => ctx.agentLoop();
  const topic = ctx.registry.domain('topic', ['topic:']);

  topic.handle('topic:sessions:create', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = TopicSessionCreateRequestSchema.safeParse(raw ?? {});
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      const session = ensureTopicService().createSession(parsed.data);
      return { ok: true as const, session };
    } catch (error) {
      return { ok: false as const, code: error instanceof Error && error.message === 'topic_persistence_unavailable' ? 'persistence_unavailable' : 'create_failed' };
    }
  });
  topic.handle('topic:sessions:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return ensureTopicService().listSessions();
    } catch { return []; }
  });
  topic.handle('topic:sessions:get', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().getSessionDetail(parsed.data.sessionId);
    } catch { return null; }
  });
  topic.handle('topic:sessions:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160), patch: TopicSessionUpdatePatchSchema }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().updateSession(parsed.data.sessionId, parsed.data.patch);
    } catch { return null; }
  });
  topic.handle('topic:sessions:delete', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return false;
      return ensureTopicService().deleteSession(parsed.data.sessionId);
    } catch { return false; }
  });
  topic.handle('topic:candidates:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        sessionId: z.string().min(1).max(160),
        candidateId: z.string().min(1).max(160),
        patch: TopicCandidateUpsertSchema.partial(),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().updateCandidate(parsed.data.sessionId, parsed.data.candidateId, parsed.data.patch as Partial<TopicCandidateDto>);
    } catch { return null; }
  });
  topic.handle('topic:select', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160), candidateId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      return ensureTopicService().selectCandidate(parsed.data.sessionId, parsed.data.candidateId);
    } catch (error) {
      return { ok: false as const, code: error instanceof Error && error.message === 'topic_persistence_unavailable' ? 'persistence_unavailable' : 'select_failed' };
    }
  });
  topic.handle('topic:markConverted', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        candidateId: z.string().min(1).max(160),
        projectId: z.string().max(160).optional(),
        scenarioId: z.string().max(160).optional(),
      }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().markConverted(parsed.data.candidateId, parsed.data);
    } catch { return null; }
  });
  topic.handle('topic:brief', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ sessionId: z.string().min(1).max(160) }).safeParse(raw);
      if (!parsed.success) return null;
      return ensureTopicService().getBrief(parsed.data.sessionId);
    } catch { return null; }
  });
  topic.handle('topic:chat', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = TopicChatRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      if (!agentLoop()) return { ok: false as const, code: 'agent_unavailable', message: 'AI 运行时尚未就绪,请稍后重试。' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `topic:chat:${parsed.data.sessionId}:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      // token 级流式转发(按 topic 会话 id 隔离,防跨会话泄漏)。
      const topicStreamHookName = `topic-stream-forward:${parsed.data.sessionId}`;
      const forwardTopicStream = (hookCtx: import('../../engine/core/HookBus.js').HookContext): import('../../engine/core/HookBus.js').HookContext => {
        const payload = hookCtx as unknown as { sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown };
        if (payload.sessionId !== `topic_${parsed.data.sessionId}`) return hookCtx;
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('topic:stream-chunk', {
              sessionId: parsed.data.sessionId,
              content: typeof payload.content === 'string' ? payload.content : '',
              reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
              isFinished: payload.isFinished === true,
            });
          }
        } catch { /* 流转发绝不中断对话 */ }
        return hookCtx;
      };
      agentLoop()!.registerHook('model.stream_chunk', forwardTopicStream, { name: topicStreamHookName });
      try {
        return await ensureTopicService().chat({
          sessionId: parsed.data.sessionId,
          message: parsed.data.message,
          signal: tracked.signal,
        });
      } finally {
        agentLoop()!.unregisterHook('model.stream_chunk', topicStreamHookName);
      }
    } catch (error) {
      return { ok: false as const, code: error instanceof Error && error.message === 'topic_persistence_unavailable' ? 'persistence_unavailable' : 'chat_failed', message: error instanceof Error ? error.message.slice(0, 300) : undefined };
    }
  });

  return () => {
    // Removes every topic:* handler from ipcMain and the registry ledger.
    topic.dispose();
  };
}
