import type { GetWorkplaceProjectResponse, ProjectId, WorkplaceProject } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const getWorkplaceProjectApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getWorkplaceProject: builder.query<WorkplaceProject, ProjectId>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.workplace.projects({ id }).get(),
          (raw: GetWorkplaceProjectResponse) => raw.project as WorkplaceProject
        ),
      providesTags: ['Sessions']
    })
  })
});

export const { useGetWorkplaceProjectQuery } = getWorkplaceProjectApi;
