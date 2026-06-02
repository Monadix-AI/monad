import type { DeleteSessionResponse, ListSessionsQuery, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { type ListSessionsResult, listSessionsApi, sessionAdapter } from './list-sessions.ts';

type QueryEntry = { endpointName?: string; originalArgs?: unknown; status?: string } | undefined;

const deleteSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteSession: builder.mutation<DeleteSessionResponse, SessionId>({
      queryFn: (id: SessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).delete()),
      async onQueryStarted(id, { dispatch, queryFulfilled, getState }) {
        // Update every cached listSessions variant (e.g. archived=true, archived=false, default).
        // Scoping to args=undefined would miss views with non-default query params.
        const state = getState() as { monadApi: { queries: Record<string, QueryEntry> } };
        const patches = Object.values(state.monadApi.queries)
          .filter((e): e is NonNullable<QueryEntry> => e?.endpointName === 'listSessions')
          .map((entry) =>
            dispatch(
              listSessionsApi.util.updateQueryData(
                'listSessions',
                entry.originalArgs as ListSessionsQuery | undefined,
                (draft: ListSessionsResult) => {
                  sessionAdapter.removeOne(draft.sessions, id);
                }
              )
            )
          );
        try {
          await queryFulfilled;
        } catch {
          for (const p of patches) p.undo();
        }
      },
      // streamControl invalidates Sessions on session.deleted for cross-client sync;
      // keep local invalidation so a server-side failure still reconciles the view.
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useDeleteSessionMutation } = deleteSessionApi;
