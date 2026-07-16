import type {
  ListSessionsQuery,
  Session,
  SessionId,
  UpdateSessionRequest,
  UpdateSessionResponse
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { type ListSessionsResult, listSessionsApi, sessionAdapter } from './list-sessions.ts';

type QueryEntry = { endpointName?: string; originalArgs?: unknown } | undefined;

export const updateSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateSession: builder.mutation<UpdateSessionResponse, { id: SessionId } & UpdateSessionRequest>({
      queryFn: ({ id, ...body }: { id: SessionId } & UpdateSessionRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).patch(body)),
      async onQueryStarted({ id, ...changes }, { dispatch, getState, queryFulfilled }) {
        const sessionChanges: Partial<Session> = {};
        if (changes.title !== undefined) sessionChanges.title = changes.title;
        if (changes.state !== undefined) sessionChanges.state = changes.state;
        if (changes.archived !== undefined) sessionChanges.archived = changes.archived;
        if (changes.agentId !== undefined) sessionChanges.agentIds = changes.agentId ? [changes.agentId] : [];
        if (changes.origin) sessionChanges.origin = changes.origin;
        const currentState = getState();
        const queryState = currentState as { monadApi: { queries: Record<string, QueryEntry> } };
        const entries = Object.values(queryState.monadApi.queries).filter(
          (entry): entry is NonNullable<QueryEntry> => entry?.endpointName === 'listSessions'
        );
        const sourceSession = entries
          .map((entry) =>
            listSessionsApi.endpoints.listSessions.select(entry.originalArgs as ListSessionsQuery | undefined)(
              currentState
            )
          )
          .map((result) => result.data?.sessions.entities[id])
          .find((session): session is Session => Boolean(session));
        const patches = entries.map((entry) => {
          const args = entry.originalArgs as ListSessionsQuery | undefined;
          return dispatch(
            listSessionsApi.util.updateQueryData('listSessions', args, (draft: ListSessionsResult) => {
              const exists = Boolean(draft.sessions.entities[id]);
              const outsideArchivedScope =
                changes.archived !== undefined && args?.archived !== undefined && args.archived !== changes.archived;
              if (outsideArchivedScope) {
                if (exists) {
                  sessionAdapter.removeOne(draft.sessions, id);
                  draft.total = Math.max(0, draft.total - 1);
                }
                return;
              }
              if (exists) {
                sessionAdapter.updateOne(draft.sessions, { id, changes: sessionChanges });
                return;
              }
              if (sourceSession && changes.archived !== undefined && !args?.query) {
                sessionAdapter.addOne(draft.sessions, { ...sourceSession, ...sessionChanges });
                draft.total += 1;
              }
            })
          );
        });
        try {
          await queryFulfilled;
        } catch {
          for (const patch of patches) patch.undo();
        }
      },
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useUpdateSessionMutation } = updateSessionApi;
