import type { AgentId, SessionId } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { collectInlineTurn } from '#/handlers/session/inline-turn.ts';
import { buildSessionOrigin } from '#/handlers/session/origin.ts';

type Handlers = ReturnType<typeof createDaemonHandlers>;

interface RunnerLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Build the `runAgent` bridge the Monadix provider uses: route an inbound network task to a local
 * agent session and return its final text. Sessions are keyed by `taskId` so a multi-turn follow-up
 * continues the same conversation. The origin `client` is `monadix`, which the inbound-approval gate
 * recognises so dispatched high-risk tools follow the configured policy instead of hanging.
 */
export function createMonadixTaskRunner(deps: {
  handlers: Handlers;
  agentId?: string;
  logger: RunnerLogger;
}): (task: { taskId: string; prompt: string }) => Promise<string> {
  const taskSessions = new Map<string, SessionId>();

  return async ({ taskId, prompt }) => {
    let sessionId = taskSessions.get(taskId);
    if (!sessionId) {
      const origin = buildSessionOrigin({ transport: 'http', surface: 'api', client: 'monadix' });
      const created = await deps.handlers.session.create({
        title: 'Monadix task',
        agentId: deps.agentId as AgentId | undefined,
        origin
      });
      sessionId = created.sessionId as SessionId;
      taskSessions.set(taskId, sessionId);
    }

    const { finalText, streamed, errorMessage } = await collectInlineTurn((sink) =>
      deps.handlers.session.sendInline({ sessionId, text: prompt }, sink, { transport: 'http' })
    );
    if (errorMessage) throw new Error(errorMessage);
    return finalText || streamed;
  };
}
