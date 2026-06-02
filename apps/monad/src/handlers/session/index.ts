import type {
  ChatMessage,
  ResolveUiMessagesRequest,
  ResolveUiMessagesResponse,
  SessionId,
  UIMessageItem
} from '@monad/protocol';
import type { SessionDeps } from '#/handlers/session/context.ts';
import type { MessagingCommandDeps } from '#/handlers/session/handlers/messaging/index.ts';

import { createSessionContext } from '#/handlers/session/context.ts';
import { createLifecycleHandlers } from '#/handlers/session/handlers/lifecycle/index.ts';
import { createMessagingHandlers } from '#/handlers/session/handlers/messaging/index.ts';
import { createSearchHandlers } from '#/handlers/session/handlers/search.ts';
import { createSessionAttentionHandlers } from '#/handlers/session/handlers/session-attention.ts';
import { createSessionPlanHandlers } from '#/handlers/session/handlers/session-plan.ts';
import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';

function projectLookupMessage(message: ChatMessage, t: SessionDeps['localeService']): UIMessageItem | undefined {
  const projector = new SessionUiProjector(t ? { t: t.t } : {});
  projector.hydrateMessages([message]);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') return undefined;
  return snapshot.items.find((item): item is UIMessageItem => item.kind === 'message');
}

function projectLookupMessages(messages: ChatMessage[], t: SessionDeps['localeService']): UIMessageItem[] {
  return messages.flatMap((message) => {
    const item = projectLookupMessage(message, t);
    return item ? [item] : [];
  });
}

export function createSessionModule(deps: SessionDeps) {
  const ctx = createSessionContext(deps);
  const messageLookup = deps.messageLookup;
  if (!messageLookup) throw new Error('session message lookup is required');
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

  return Object.assign(lifecycle, createMessagingHandlers(ctx, cmd), createSearchHandlers(ctx), {
    ...createSessionAttentionHandlers(ctx),
    ...createSessionPlanHandlers(ctx),
    applyManagedAgentLoopEvent: (
      input: {
        sessionId: string;
        meshSessionId: string;
        memberId: string;
      } & (
        | { kind: 'output'; event: Parameters<typeof ctx.managedAgentSessions.applyOutputEvent>[0]['event'] }
        | { kind: 'runtime'; snapshot: Parameters<typeof ctx.managedAgentSessions.applyRuntimeSnapshot>[0]['snapshot'] }
      )
    ) => {
      const identity = { sessionId: input.sessionId as `ses_${string}`, memberId: input.memberId };
      return input.kind === 'output'
        ? ctx.managedAgentSessions.applyOutputEvent({ ...identity, event: input.event })
        : ctx.managedAgentSessions.applyRuntimeSnapshot({
            ...identity,
            runtimeId: input.meshSessionId as `mesh_${string}`,
            snapshot: input.snapshot
          });
    },
    async resolveUiMessages({
      id,
      messageIds
    }: { id: SessionId } & ResolveUiMessagesRequest): Promise<ResolveUiMessagesResponse> {
      ctx.requireSession(id);
      return {
        items: projectLookupMessages(
          messageLookup.getMany({ transcriptTargetId: id, messageIds, actor: { kind: 'user-client' } }),
          deps.localeService
        )
      };
    }
  });
}

export type { EventSink, SessionDeps } from '#/handlers/session/context.ts';
