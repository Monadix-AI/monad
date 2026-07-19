import type { Event } from '@monad/protocol';

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
          dispose = client.subscribeControl((event: Event) => {
            if (SESSION_LIST_EVENTS.has(event.type)) {
              dispatch(apiSlice.util.invalidateTags(['Sessions']));
            }
            if (MESH_SESSION_EVENTS.has(event.type)) {
              dispatch(apiSlice.util.invalidateTags(['MeshSessions', { type: 'MeshSessions', id: event.sessionId }]));
            }
            if (MCP_STATUS_EVENTS.has(event.type)) {
              dispatch(apiSlice.util.invalidateTags(['McpServers']));
            }
          });
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
