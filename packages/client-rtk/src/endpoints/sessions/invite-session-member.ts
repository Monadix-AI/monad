import type { InviteSessionMemberRequest, SessionId, WorkplaceProjectSessionMember } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listSessionMembersApi, sessionMemberAdapter } from './list-session-members.ts';

const inviteSessionMemberApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inviteSessionMember: builder.mutation<
      WorkplaceProjectSessionMember,
      { sessionId: SessionId } & InviteSessionMemberRequest
    >({
      queryFn: ({ sessionId, templateId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId }).members.post({ templateId }),
          (raw) => raw.member
        ),
      // Patch the members list as soon as the mutation resolves, rather than waiting for the
      // invalidatesTags-triggered refetch — avoids a visible round-trip before the invited member appears.
      async onQueryStarted({ sessionId }, { dispatch, queryFulfilled }) {
        const { data: member } = await queryFulfilled;
        dispatch(
          listSessionMembersApi.util.updateQueryData('listSessionMembers', sessionId, (draft) => {
            sessionMemberAdapter.setOne(draft, member);
          })
        );
      },
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionMembers', id: sessionId }]
    })
  })
});

export const { useInviteSessionMemberMutation } = inviteSessionMemberApi;
