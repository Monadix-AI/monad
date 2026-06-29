import type { SessionId, WorkspaceGit } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Best-effort git summary of a session's working folder for the workplace header. Tagged on Sessions
// so changing the folder (an update-session mutation) refetches the branch/dirty state.
const workspaceGitApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    workspaceGit: builder.query<WorkspaceGit, SessionId>({
      queryFn: (id: SessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id })['workspace-git'].get()),
      providesTags: ['Sessions']
    })
  })
});

export const { useWorkspaceGitQuery } = workspaceGitApi;
