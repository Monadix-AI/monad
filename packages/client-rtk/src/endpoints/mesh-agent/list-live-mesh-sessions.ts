import type {
  ListMeshAgentRuntimesQuery,
  ListMeshAgentRuntimesResponse,
  MeshSessionId,
  MeshSessionView
} from '@monad/protocol';

import { meshSessionViewSchema } from '@monad/protocol';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { meshSessionAdapter } from './list-mesh-sessions.ts';

type ListLiveMeshSessionsResult = NormalizedCursorPaginateResponse<
  MeshSessionView,
  'sessions',
  ListMeshAgentRuntimesResponse,
  MeshSessionId
>;

// Daemon-wide list of every LIVE (starting/running) MeshAgent/agent-adapter runtime across all
// projects. `streamControl` invalidates this cache from mesh.started/exited notifications, so
// callers do not need their own interval polling.
const listLiveMeshSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listLiveMeshSessions: builder.query<ListLiveMeshSessionsResult, ListMeshAgentRuntimesQuery | undefined>({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.runtimes.get({ query: arg ?? {} }),
          (raw) => ({
            ...raw,
            sessions: meshSessionAdapter.setAll(
              meshSessionAdapter.getInitialState(),
              raw.sessions.map((session) => meshSessionViewSchema.parse(session))
            )
          })
        ),
      providesTags: ['MeshSessions']
    })
  })
});

export const { useListLiveMeshSessionsQuery } = listLiveMeshSessionsApi;
