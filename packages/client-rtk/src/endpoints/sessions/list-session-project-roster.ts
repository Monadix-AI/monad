import type { ProjectMember, SessionId } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Every ProjectMember of the session's project, not just this session's live bindings — see
// `listProjectRosterResponseSchema`'s comment in @monad/protocol. This is the correct assignee
// resolution/selection source (the daemon accepts any enabled project member as an assignee,
// regardless of session binding); `useListSessionMembersQuery` only covers active bindings.
export const projectRosterAdapter = createEntityAdapter<ProjectMember, string>({
  selectId: (member) => member.id
});
export const projectRosterSelectors = projectRosterAdapter.getSelectors();

export const listSessionProjectRosterApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listSessionProjectRoster: builder.query<ReturnType<typeof projectRosterAdapter.getInitialState>, SessionId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId })['project-roster'].get(),
          (raw) => projectRosterAdapter.setAll(projectRosterAdapter.getInitialState(), raw.members)
        ),
      // A global tag, not session-scoped: the roster reflects the session's PROJECT membership, and
      // a canonical ProjectMember rename/disable/create (`updateWorkplaceProject`, invite, spawn) can
      // originate from any session or from Project settings — every subscribed roster across every
      // session in that project needs to converge, not just the session that triggered the mutation.
      providesTags: ['ProjectRoster']
    })
  })
});

export const { useListSessionProjectRosterQuery } = listSessionProjectRosterApi;
