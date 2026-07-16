import type { SessionDeps } from '#/handlers/session/context.ts';
import type { MessagingCommandDeps } from '#/handlers/session/handlers/messaging/index.ts';

import { createSessionContext } from '#/handlers/session/context.ts';
import { createLifecycleHandlers } from '#/handlers/session/handlers/lifecycle/index.ts';
import { createMessagingHandlers } from '#/handlers/session/handlers/messaging/index.ts';
import { createSearchHandlers } from '#/handlers/session/handlers/search.ts';

export function createSessionModule(deps: SessionDeps) {
  const ctx = createSessionContext(deps);
  // Lifecycle is assembled first so the messaging chokepoint can reuse create/reset/list to back
  // slash commands (lifecycle has no dependency on messaging — this breaks the would-be cycle).
  const lifecycle = createLifecycleHandlers(ctx);

  const cmd: MessagingCommandDeps | undefined = deps.commands
    ? {
        commands: deps.commands,
        lifecycle: {
          create: (a) => lifecycle.create(a),
          reset: (a) => lifecycle.reset(a),
          update: (a) => lifecycle.update(a),
          list: (a) => lifecycle.list(a),
          setWorkspace: (a) => lifecycle.setWorkspace(a)
        }
      }
    : undefined;

  return Object.assign(lifecycle, createMessagingHandlers(ctx, cmd), createSearchHandlers(ctx));
}

export type { EventSink, SessionDeps } from '#/handlers/session/context.ts';
