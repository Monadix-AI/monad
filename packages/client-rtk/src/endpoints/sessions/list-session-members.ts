import type { SessionId, WorkplaceProjectSessionMember } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const sessionMemberAdapter = createEntityAdapter<WorkplaceProjectSessionMember, string>({
  selectId: (m) => m.id
});
export const sessionMemberSelectors = sessionMemberAdapter.getSelectors();

export const listSessionMembersApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listSessionMembers: builder.query<ReturnType<typeof sessionMemberAdapter.getInitialState>, SessionId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId }).members.get(),
          (raw) => sessionMemberAdapter.setAll(sessionMemberAdapter.getInitialState(), raw.members)
        ),
      providesTags: (_result, _error, sessionId) => [{ type: 'SessionMembers', id: sessionId }]
    })
  })
});

export const { useListSessionMembersQuery } = listSessionMembersApi;
