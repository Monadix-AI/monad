import type { DeleteWorkplaceProjectResponse, ListWorkplaceProjectsQuery, ProjectId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import {
  type ListWorkplaceProjectsResult,
  listWorkplaceProjectsApi,
  workplaceProjectAdapter
} from './list-projects.ts';

type QueryEntry = { endpointName?: string; originalArgs?: unknown } | undefined;

const deleteWorkplaceProjectApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteWorkplaceProject: builder.mutation<DeleteWorkplaceProjectResponse, ProjectId>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.workplace.projects({ id }).delete(),
          (raw) => raw
        ),
      async onQueryStarted(id, { dispatch, queryFulfilled, getState }) {
        const state = getState() as { monadApi: { queries: Record<string, QueryEntry> } };
        const patches = Object.values(state.monadApi.queries)
          .filter((entry): entry is NonNullable<QueryEntry> => entry?.endpointName === 'listWorkplaceProjects')
          .map((entry) =>
            dispatch(
              listWorkplaceProjectsApi.util.updateQueryData(
                'listWorkplaceProjects',
                entry.originalArgs as ListWorkplaceProjectsQuery | undefined,
                (draft: ListWorkplaceProjectsResult) => {
                  workplaceProjectAdapter.removeOne(draft.projects, id);
                }
              )
            )
          );
        try {
          await queryFulfilled;
        } catch {
          for (const patch of patches) patch.undo();
        }
      },
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useDeleteWorkplaceProjectMutation } = deleteWorkplaceProjectApi;
