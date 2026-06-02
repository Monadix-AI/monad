import type { SessionId, SessionMemberBinding } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// The cache stores the canonical `{ member, binding }` join, keyed by the stable projectMemberId. Any
// legacy flat view-model is composed in the experience/web layer, never here.
export const sessionMemberAdapter = createEntityAdapter<SessionMemberBinding, string>({
  selectId: (entry) => entry.member.id
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
