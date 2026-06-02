import type { ProjectId, UpdateWorkplaceProjectRequest, WorkplaceProject } from '@monad/protocol';

import { updateWorkplaceProjectResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const updateWorkplaceProjectApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateWorkplaceProject: builder.mutation<WorkplaceProject, { id: ProjectId } & UpdateWorkplaceProjectRequest>({
      queryFn: ({ id, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.workplace.projects({ id }).patch(body),
          (raw) => updateWorkplaceProjectResponseSchema.parse(raw).project
        ),
      // Project settings and the reusable project roster share this mutation surface.
      invalidatesTags: ['Projects', 'ProjectRoster']
    })
  })
});

export const { useUpdateWorkplaceProjectMutation } = updateWorkplaceProjectApi;
