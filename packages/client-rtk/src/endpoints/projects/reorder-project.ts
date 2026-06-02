import type {
  ListWorkplaceProjectsQuery,
  ReorderWorkplaceProjectRequest,
  ReorderWorkplaceProjectResponse
} from '@monad/protocol';

import { reorderWorkplaceProjectResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { type ListWorkplaceProjectsResult, listWorkplaceProjectsApi } from './list-projects.ts';

type QueryEntry = { endpointName?: string; originalArgs?: unknown } | undefined;

const reorderWorkplaceProjectApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    reorderWorkplaceProject: builder.mutation<ReorderWorkplaceProjectResponse, ReorderWorkplaceProjectRequest>({
      queryFn: (body, api: { extra: unknown }) =>
        runTreaty(
          async () => {
            const response = await clientOf(api).fetch('/v1/workplace/projects/reorder', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            const value: unknown = await response.json();
            return response.ok
              ? { data: value, error: null }
              : { data: null, error: { status: response.status, value } };
          },
          (raw) => reorderWorkplaceProjectResponseSchema.parse(raw)
        ),
      async onQueryStarted(input, { dispatch, getState, queryFulfilled }) {
        const state = getState() as { monadApi: { queries: Record<string, QueryEntry> } };
        const patches = Object.values(state.monadApi.queries)
          .filter((entry): entry is NonNullable<QueryEntry> => entry?.endpointName === 'listWorkplaceProjects')
          .map((entry) =>
            dispatch(
              listWorkplaceProjectsApi.util.updateQueryData(
                'listWorkplaceProjects',
                entry.originalArgs as ListWorkplaceProjectsQuery | undefined,
                (draft: ListWorkplaceProjectsResult) => {
                  const ids = draft.projects.ids.map(String);
                  const sourceIndex = ids.indexOf(input.projectId);
                  if (sourceIndex < 0) return;
                  ids.splice(sourceIndex, 1);
                  const neighborId = input.beforeProjectId ?? input.afterProjectId;
                  if (!neighborId) return;
                  const neighborIndex = ids.indexOf(neighborId);
                  if (neighborIndex < 0) return;
                  ids.splice(input.beforeProjectId ? neighborIndex : neighborIndex + 1, 0, input.projectId);
                  draft.projects.ids = ids;
                  draft.orderRevision = input.expectedRevision + 1;
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
      invalidatesTags: ['Projects']
    })
  })
});

export const { useReorderWorkplaceProjectMutation } = reorderWorkplaceProjectApi;
