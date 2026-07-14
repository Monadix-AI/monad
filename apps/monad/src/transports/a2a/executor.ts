import type { Message, Task, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { AgentId, SessionId } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { InlineTurnResult } from '#/handlers/session/inline-turn.ts';

import { collectInlineTurn } from '#/handlers/session/inline-turn.ts';
import { buildSessionOrigin } from '#/handlers/session/origin.ts';

type Handlers = ReturnType<typeof createDaemonHandlers>;

/** Concatenate the text parts of an inbound A2A message. Non-text parts (files/data) are ignored
 *  for the v1 text-only surface. */
function messageText(message: Message): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

function agentMessage(reqCtx: RequestContext, text: string): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'agent',
    parts: [{ kind: 'text', text }],
    taskId: reqCtx.taskId,
    contextId: reqCtx.contextId
  };
}

function statusUpdate(reqCtx: RequestContext, state: TaskState, text: string, final: boolean): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: reqCtx.taskId,
    contextId: reqCtx.contextId,
    final,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: text ? agentMessage(reqCtx, text) : undefined
    }
  };
}

/** An A2A AgentExecutor bound to one monad agent. It maps an A2A `contextId` to a monad session
 *  (creating one on first contact so a multi-turn A2A conversation continues the same session),
 *  runs the turn through `session.sendInline`, and republishes the loop's token/message/error
 *  events as A2A task status-updates. Text-only for v1. */
export function createA2aExecutor(agentId: AgentId, handlers: Handlers): AgentExecutor {
  const contextSessions = new Map<string, SessionId>();
  const taskSessions = new Map<string, SessionId>();

  async function resolveSession(contextId: string): Promise<SessionId> {
    const existing = contextSessions.get(contextId);
    if (existing) return existing;
    const origin = buildSessionOrigin({ transport: 'http', surface: 'api', client: 'a2a' });
    const { sessionId } = await handlers.session.create({ title: 'A2A session', agentId, origin });
    contextSessions.set(contextId, sessionId as SessionId);
    return sessionId as SessionId;
  }

  return {
    async execute(reqCtx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const text = messageText(reqCtx.userMessage);
      const sessionId = await resolveSession(reqCtx.contextId);
      taskSessions.set(reqCtx.taskId, sessionId);

      // Register the task with the SDK's event bus before any status-update references its id, so
      // both message/send (aggregate → Task result) and message/stream (incremental) have a context.
      const initialTask: Task = {
        kind: 'task',
        id: reqCtx.taskId,
        contextId: reqCtx.contextId,
        status: { state: 'working', timestamp: new Date().toISOString() },
        history: [reqCtx.userMessage]
      };
      eventBus.publish(initialTask);

      let result: InlineTurnResult = { finalText: '', streamed: '' };
      try {
        result = await collectInlineTurn(
          (sink) => handlers.session.sendInline({ sessionId, text }, sink, { transport: 'http' }),
          (streamed) => eventBus.publish(statusUpdate(reqCtx, 'working', streamed, false))
        );
      } catch (err) {
        result.errorMessage = result.errorMessage ?? (err instanceof Error ? err.message : 'agent run failed');
      }

      if (result.errorMessage) {
        eventBus.publish(statusUpdate(reqCtx, 'failed', result.errorMessage, true));
      } else {
        eventBus.publish(statusUpdate(reqCtx, 'completed', result.finalText || result.streamed, true));
      }
      eventBus.finished();
    },

    async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
      const sessionId = taskSessions.get(taskId);
      if (sessionId) await handlers.session.abort({ id: sessionId }).catch(() => {});
    }
  };
}
