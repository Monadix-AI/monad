import type { RestoreSessionRequest, RestoreSessionResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const restoreSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    restoreSession: builder.mutation<RestoreSessionResponse, { id: SessionId } & RestoreSessionRequest>({
      queryFn: ({ id, toMessageId }: { id: SessionId } & RestoreSessionRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).restore.post({ toMessageId })),
      invalidatesTags: (_result, _error, { id }: { id: SessionId } & RestoreSessionRequest) => [
        { type: 'Messages', id }
      ]
    })
  })
});

export const { useRestoreSessionMutation } = restoreSessionApi;
