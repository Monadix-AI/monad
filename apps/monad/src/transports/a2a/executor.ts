import type { Message, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { AgentId, Event, SessionId } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { parseEventPayload } from '@monad/protocol';

import { buildSessionOrigin } from '@/handlers/session/origin.ts';

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

      let streamed = '';
      let finalText = '';
      let errorMessage: string | undefined;

      const sink = (event: Event): void => {
        if (event.type === 'agent.token') {
          streamed += parseEventPayload('agent.token', event.payload).delta;
          eventBus.publish(statusUpdate(reqCtx, 'working', streamed, false));
        } else if (event.type === 'agent.message') {
          finalText = parseEventPayload('agent.message', event.payload).text;
        } else if (event.type === 'agent.error') {
          errorMessage = parseEventPayload('agent.error', event.payload).message;
        }
      };

      try {
        await handlers.session.sendInline({ sessionId, text }, sink, { transport: 'http' });
      } catch (err) {
        errorMessage = errorMessage ?? (err instanceof Error ? err.message : 'agent run failed');
      }

      if (errorMessage) {
        eventBus.publish(statusUpdate(reqCtx, 'failed', errorMessage, true));
      } else {
        eventBus.publish(statusUpdate(reqCtx, 'completed', finalText || streamed, true));
      }
      eventBus.finished();
    },

    async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
      const sessionId = taskSessions.get(taskId);
      if (sessionId) await handlers.session.abort({ id: sessionId }).catch(() => {});
    }
  };
}
