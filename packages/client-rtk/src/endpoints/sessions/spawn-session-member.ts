import type { SessionId, SpawnSessionMemberRequest, WorkplaceProjectSessionMember } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

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
      invalidatesTags: (_result, _error, { sessionId }) => [{ type: 'SessionMembers', id: sessionId }]
    })
  })
});

export const { useSpawnSessionMemberMutation } = spawnSessionMemberApi;
