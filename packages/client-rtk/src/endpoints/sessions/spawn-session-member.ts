import type { SessionId, SpawnSessionMemberRequest, WorkplaceProjectSessionMember } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listSessionMembersApi, sessionMemberAdapter } from './list-session-members.ts';

const spawnSessionMemberApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    spawnSessionMember: builder.mutation<
      WorkplaceProjectSessionMember,
      { sessionId: SessionId } & SpawnSessionMemberRequest
    >({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId }).members.post(body),
          (raw) => raw.member
        ),
      // Patch the members list as soon as the mutation resolves, rather than waiting for the
      // invalidatesTags-triggered refetch — avoids a visible round-trip before the spawned member appears.
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

export const { useSpawnSessionMemberMutation } = spawnSessionMemberApi;
