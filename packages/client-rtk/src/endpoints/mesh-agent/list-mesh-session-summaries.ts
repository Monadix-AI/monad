import type {
  ListMeshAgentRuntimesQuery,
  ListMeshAgentRuntimesResponse,
  MeshSessionId,
  MeshSessionView
} from '@monad/protocol';

import { listMeshAgentRuntimesResponseSchema } from '@monad/protocol';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { meshSessionAdapter } from './list-mesh-sessions.ts';

type ListMeshSessionSummariesResult = NormalizedCursorPaginateResponse<
  MeshSessionView,
  'sessions',
  ListMeshAgentRuntimesResponse,
  MeshSessionId
>;

const listMeshSessionSummariesApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMeshSessionSummaries: builder.query<ListMeshSessionSummariesResult, ListMeshAgentRuntimesQuery | undefined>({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh['session-summaries'].get({ query: arg ?? {} }),
          (raw) => {
            const parsed = listMeshAgentRuntimesResponseSchema.parse(raw);
            return {
              ...parsed,
              sessions: meshSessionAdapter.setAll(meshSessionAdapter.getInitialState(), parsed.sessions)
            };
          }
        ),
      providesTags: ['MeshSessions']
    })
  })
});

export const { useListMeshSessionSummariesQuery } = listMeshSessionSummariesApi;
