import type { RemoveSessionMemberResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listSessionMembersApi, sessionMemberAdapter } from './list-session-members.ts';

const removeSessionMemberApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    removeSessionMember: builder.mutation<RemoveSessionMemberResponse, { sessionId: SessionId; memberId: string }>({
      queryFn: ({ sessionId, memberId }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id: sessionId }).members({ memberId }).delete()),
      // Remove from the cached list immediately so the confirm popover's own removal doesn't wait on
      // the invalidatesTags-triggered refetch; roll back if the request fails.
      async onQueryStarted({ sessionId, memberId }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listSessionMembersApi.util.updateQueryData('listSessionMembers', sessionId, (draft) => {
            sessionMemberAdapter.removeOne(draft, memberId);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionMembers', id: sessionId }]
    })
  })
});

export const { useRemoveSessionMemberMutation } = removeSessionMemberApi;
