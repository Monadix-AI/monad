import type { ListWorkplaceProjectsQuery, ListWorkplaceProjectsResponse, WorkplaceProject } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice, type NormalizedPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const workplaceProjectAdapter = createEntityAdapter<WorkplaceProject, string>({ selectId: (p) => p.id });
export const workplaceProjectSelectors = workplaceProjectAdapter.getSelectors();

export type ListWorkplaceProjectsResult = NormalizedPaginateResponse<
  WorkplaceProject,
  'projects',
  ListWorkplaceProjectsResponse
>;

export const listWorkplaceProjectsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listWorkplaceProjects: builder.query<ListWorkplaceProjectsResult, ListWorkplaceProjectsQuery | undefined>({
      queryFn: (args, api: { extra: unknown }) => {
        const { archived, state, limit, offset } = args ?? {};
        return runTreaty(
          () => clientOf(api).treaty.v1.workplace.projects.get({ query: { archived, state, limit, offset } }),
          (raw) => {
            const projects = raw.projects as unknown as WorkplaceProject[];
            return {
              ...raw,
              projects: workplaceProjectAdapter.setAll(workplaceProjectAdapter.getInitialState(), projects)
            } as ListWorkplaceProjectsResult;
          }
        );
      },
      providesTags: ['Sessions']
    })
  })
});

export const { useListWorkplaceProjectsQuery } = listWorkplaceProjectsApi;
