import type { TranscriptTargetId, WorkspaceGit, WorkspaceMeta } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Best-effort workspace metadata for a session's working folder. Tagged on Sessions so changing the
// folder (an update-session mutation) refetches the metadata slices.
const workspaceMetaApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    workspaceMeta: builder.query<WorkspaceMeta, TranscriptTargetId>({
      queryFn: (id: TranscriptTargetId, api: { extra: unknown }) =>
        runTreaty(() =>
          id.startsWith('prj_')
            ? clientOf(api).treaty.v1.projects({ id })['workspace-meta'].get()
            : clientOf(api).treaty.v1.sessions({ id })['workspace-meta'].get()
        ),
      providesTags: ['Sessions']
    }),
    workspaceGit: builder.query<WorkspaceGit, TranscriptTargetId>({
      queryFn: async (id: TranscriptTargetId, api: { extra: unknown }) => {
        const result = await runTreaty(() =>
          id.startsWith('prj_')
            ? clientOf(api).treaty.v1.projects({ id })['workspace-meta'].get()
            : clientOf(api).treaty.v1.sessions({ id })['workspace-meta'].get()
        );
        if ('error' in result) return result;
        return { data: result.data.git };
      },
      providesTags: ['Sessions']
    })
  })
});

export const { useWorkspaceGitQuery, useWorkspaceMetaQuery } = workspaceMetaApi;
