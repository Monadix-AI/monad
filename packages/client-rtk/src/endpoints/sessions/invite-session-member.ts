import type { InviteSessionMemberRequest, SessionId, SessionMemberBinding } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listSessionMembersApi, sessionMemberAdapter } from './list-session-members.ts';

const inviteSessionMemberApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inviteSessionMember: builder.mutation<SessionMemberBinding, { sessionId: SessionId } & InviteSessionMemberRequest>({
      queryFn: ({ sessionId, templateId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId }).members.post({ templateId }),
          (raw) => raw
        ),
      // Patch the members list as soon as the mutation resolves, rather than waiting for the
      // invalidatesTags-triggered refetch — avoids a visible round-trip before the invited member appears.
      async onQueryStarted({ sessionId }, { dispatch, queryFulfilled }) {
        const { data: entry } = await queryFulfilled;
        dispatch(
          listSessionMembersApi.util.updateQueryData('listSessionMembers', sessionId, (draft) => {
            sessionMemberAdapter.setOne(draft, entry);
          })
        );
      },
      // Also mints/reactivates a canonical ProjectMember — the project-wide roster needs to see it.
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionMembers', id: sessionId }, 'ProjectRoster']
    })
  })
});

export const { useInviteSessionMemberMutation } = inviteSessionMemberApi;
