import type { TranscriptTargetId, WorkspaceActionRequest, WorkspaceActionResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const workspaceActionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    workspaceAction: builder.mutation<WorkspaceActionResponse, { id: TranscriptTargetId } & WorkspaceActionRequest>({
      queryFn: ({ id, action }, api: { extra: unknown }) =>
        runTreaty(() =>
          id.startsWith('prj_')
            ? clientOf(api).treaty.v1.projects({ id })['workspace-action'].post({ action })
            : clientOf(api).treaty.v1.sessions({ id })['workspace-action'].post({ action })
        )
    })
  })
});

export const { useWorkspaceActionMutation } = workspaceActionApi;
