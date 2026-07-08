import type { SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const removeSessionMemberApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    removeSessionMember: builder.mutation<{ deleted: true }, { sessionId: SessionId; memberId: string }>({
      queryFn: ({ sessionId, memberId }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id: sessionId }).members({ memberId }).delete()),
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionMembers', id: sessionId }]
    })
  })
});

export const { useRemoveSessionMemberMutation } = removeSessionMemberApi;
