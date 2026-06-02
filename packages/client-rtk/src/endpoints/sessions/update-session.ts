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

const updateSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateSession: builder.mutation<UpdateSessionResponse, { id: SessionId } & UpdateSessionRequest>({
      queryFn: ({ id, ...body }: { id: SessionId } & UpdateSessionRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).patch(body)),
      async onQueryStarted({ id, ...changes }, { dispatch, queryFulfilled }) {
        const sessionChanges: Partial<Session> = {};
        if (changes.title !== undefined) sessionChanges.title = changes.title;
        if (changes.state !== undefined) sessionChanges.state = changes.state;
        if (changes.archived !== undefined) sessionChanges.archived = changes.archived;
        if (changes.agentId !== undefined) sessionChanges.agentIds = changes.agentId ? [changes.agentId] : [];
        if (changes.origin) sessionChanges.origin = changes.origin;
        const patch = dispatch(
          listSessionsApi.util.updateQueryData(
            'listSessions',
            undefined as ListSessionsQuery | undefined,
            (draft: ListSessionsResult) => {
              sessionAdapter.updateOne(draft.sessions, { id, changes: sessionChanges });
            }
          )
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useUpdateSessionMutation } = updateSessionApi;
