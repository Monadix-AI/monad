import type { InviteSessionMemberRequest, SessionId, WorkplaceProjectSessionMember } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

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
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionMembers', id: sessionId }]
    })
  })
});

export const { useInviteSessionMemberMutation } = inviteSessionMemberApi;
