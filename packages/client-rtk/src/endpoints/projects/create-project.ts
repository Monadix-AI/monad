import type { CreateWorkplaceProjectRequest, CreateWorkplaceProjectResponse, ProjectId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const createWorkplaceProjectApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createWorkplaceProject: builder.mutation<
      CreateWorkplaceProjectResponse['projectId'],
      CreateWorkplaceProjectRequest
    >({
      queryFn: (body, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.workplace.projects.post(body),
          (raw) => raw.projectId as ProjectId
        ),
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useCreateWorkplaceProjectMutation } = createWorkplaceProjectApi;
