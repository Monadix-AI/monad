import type { Event } from '@monad/protocol';

import { meshCatalogUpdatedPayloadSchema, sessionUpdatedPayloadSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf } from '../../endpoint-helpers.ts';

// List-level deltas that should re-fetch (and thus re-sort) the session list. `sessions.updated`
// fires on every turn, so a session bubbles to the top the moment it sees activity — including
// turns from another client or a channel (Telegram, …).
const SESSION_LIST_EVENTS: ReadonlySet<Event['type']> = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.restored'
] as const satisfies ReadonlyArray<Event['type']>);

const MESH_SESSION_EVENTS: ReadonlySet<Event['type']> = new Set([
  'mesh.started',
  'mesh.exited'
] as const satisfies ReadonlyArray<Event['type']>);

const MCP_STATUS_EVENTS: ReadonlySet<Event['type']> = new Set(['mcp.status_updated'] as const satisfies ReadonlyArray<
  Event['type']
>);

const INBOX_EVENTS: ReadonlySet<Event['type']> = new Set([
  'session.message.created',
  'tool.approval_requested',
  'tool.approval_resolved',
  'mesh.approval_requested',
  'mesh.approval_resolved',
  'clarify.requested',
  'clarify.resolved'
] as const satisfies ReadonlyArray<Event['type']>);

const ATTENTION_EVENTS: ReadonlySet<Event['type']> = new Set([
  'session.attention.updated',
  'session.run.started',
  'session.run.completed',
  'session.run.failed',
  'session.run.cancelled',
  'session.message.created',
  'session.message.completed',
  'session.message.failed'
] as const satisfies ReadonlyArray<Event['type']>);

// Durable SessionPlan mutations (P0-C) publish these on the control plane so every subscribed
// client — another Web tab, the CLI, TUI, or an MCP-driven agent — converges on the same plan,
// not just the client that made the change. `event.sessionId` is the envelope's own field (every
// event carries it), not something read out of the payload.
const SESSION_PLAN_EVENTS: ReadonlySet<Event['type']> = new Set([
  'session.plan.todo_upserted',
  'session.plan.todo_removed'
] as const satisfies ReadonlyArray<Event['type']>);

/**
 * Subscribes to the cross-session control stream for the lifetime of the cache entry. There is no
 * data to read — mount it once (e.g. `useStreamControlQuery()`) and it keeps the session list live.
 */
export const streamControlApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamControl: builder.query<null, void>({
      queryFn: () => ({ data: null }),
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, dispatch, extra }) {
        const client = clientOf({ extra });
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = client.subscribeControl(
            (event: Event) => {
              // `agent.session.changed` is a legacy loop/connection lifecycle signal. b1 deliberately does
              // NOT couple it to the canonical SessionMembers cache: the wire no longer carries loop state,
              // so a refetch would churn the network/DB for a byte-identical `{ member, binding }`. Deriving
              // online/current from real binding/runtime lifecycle events is b2's job.
              if (SESSION_LIST_EVENTS.has(event.type)) {
                dispatch(apiSlice.util.invalidateTags(['Sessions']));
              }
              if (MESH_SESSION_EVENTS.has(event.type)) {
                dispatch(apiSlice.util.invalidateTags(['MeshSessions', { type: 'MeshSessions', id: event.sessionId }]));
              }
              if (MCP_STATUS_EVENTS.has(event.type)) {
                dispatch(apiSlice.util.invalidateTags(['McpServers']));
              }
              if (event.type === 'mesh.catalog.updated') {
                const resources = new Set(meshCatalogUpdatedPayloadSchema.parse(event.payload).resources);
                dispatch(
                  apiSlice.util.invalidateTags([
                    ...(resources.has('agents') ? (['MeshAgents'] as const) : []),
                    ...(resources.has('presets') ? (['MeshAgentPresets'] as const) : []),
                    ...(resources.has('invitable-agents') ? (['InvitableMeshAgents'] as const) : [])
                  ])
                );
              }
              if (INBOX_EVENTS.has(event.type)) {
                dispatch(apiSlice.util.invalidateTags(['Inbox']));
              }
              if (
                event.type === 'session.deleted' ||
                (event.type === 'session.updated' &&
                  sessionUpdatedPayloadSchema.parse(event.payload).archived !== undefined)
              ) {
                dispatch(apiSlice.util.invalidateTags(['Inbox']));
              }
              if (ATTENTION_EVENTS.has(event.type)) {
                dispatch(apiSlice.util.invalidateTags(['SessionAttention', 'Inbox']));
              }
              if (event.type === 'workplace.project.order_updated') {
                dispatch(apiSlice.util.invalidateTags(['Projects']));
              }
              if (SESSION_PLAN_EVENTS.has(event.type)) {
                dispatch(apiSlice.util.invalidateTags([{ type: 'SessionPlan', id: event.sessionId }]));
              }
            },
            {
              onOpen: () => dispatch(apiSlice.util.invalidateTags(['Sessions', 'SessionAttention', 'Inbox']))
            }
          );
        } catch {
          // cacheDataLoaded rejects when the entry is removed before it loads
        }
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamControlQuery } = streamControlApi;
