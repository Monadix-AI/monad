import type { Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { AgentId, SessionId } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { InlineTurnResult } from '#/handlers/session/inline-turn.ts';

import { Role, TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';

import { collectInlineTurn } from '#/handlers/session/inline-turn.ts';
import { buildOperationSource } from '#/handlers/session/origin.ts';

type Handlers = ReturnType<typeof createDaemonHandlers>;

/** Concatenate the text parts of an inbound A2A message. Non-text parts (files/data) are ignored
 *  for the v1 text-only surface. */
function messageText(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === 'text')
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}

function agentMessage(reqCtx: RequestContext, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain'
      }
    ],
    taskId: reqCtx.taskId,
    contextId: reqCtx.contextId,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

function statusUpdate(reqCtx: RequestContext, state: TaskState, text = ''): TaskStatusUpdateEvent {
  return {
    taskId: reqCtx.taskId,
    contextId: reqCtx.contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: text ? agentMessage(reqCtx, text) : undefined
    },
    metadata: undefined
  };
}

/** An A2A AgentExecutor bound to one monad agent. It maps an A2A `contextId` to a monad session
 *  (creating one on first contact so a multi-turn A2A conversation continues the same session),
 *  runs the turn through `session.sendInline`, and republishes the loop's token/message/error
 *  events as A2A task status-updates. Text-only for v1. */
export function createA2aExecutor(agentId: AgentId, handlers: Handlers): AgentExecutor {
  const contextSessions = new Map<string, SessionId>();
  const taskSessions = new Map<string, SessionId>();
  const cancelledTasks = new Set<string>();

  async function resolveSession(contextId: string): Promise<SessionId> {
    const existing = contextSessions.get(contextId);
    if (existing) return existing;
    const origin = buildOperationSource({ transport: 'http', surface: 'api', client: 'a2a' });
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
      // both SendMessage (aggregate → Task result) and SendStreamingMessage (incremental) have a context.
      const initialTask: Task = {
        id: reqCtx.taskId,
        contextId: reqCtx.contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          timestamp: new Date().toISOString(),
          message: undefined
        },
        artifacts: [],
        history: [reqCtx.userMessage],
        metadata: undefined
      };
      eventBus.publish(AgentEvent.task(initialTask));

      let result: InlineTurnResult = { finalText: '', streamed: '' };
      try {
        result = await collectInlineTurn(
          (sink) => handlers.session.sendInline({ sessionId, text }, sink, { transport: 'http' }),
          (streamed) =>
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(reqCtx, TaskState.TASK_STATE_WORKING, streamed)))
        );
      } catch (err) {
        result.errorMessage = result.errorMessage ?? (err instanceof Error ? err.message : 'agent run failed');
      }

      if (cancelledTasks.has(reqCtx.taskId)) {
        eventBus.publish(AgentEvent.statusUpdate(statusUpdate(reqCtx, TaskState.TASK_STATE_CANCELED)));
      } else if (result.errorMessage) {
        eventBus.publish(
          AgentEvent.statusUpdate(statusUpdate(reqCtx, TaskState.TASK_STATE_FAILED, result.errorMessage))
        );
      } else {
        eventBus.publish(
          AgentEvent.statusUpdate(
            statusUpdate(reqCtx, TaskState.TASK_STATE_COMPLETED, result.finalText || result.streamed)
          )
        );
      }
      cancelledTasks.delete(reqCtx.taskId);
      eventBus.finished();
    },

    async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
      cancelledTasks.add(taskId);
      const sessionId = taskSessions.get(taskId);
      if (sessionId) await handlers.session.abort({ id: sessionId }).catch(() => {});
    }
  };
}
