import type { MeshSessionId, MeshSessionView, SessionId } from '@monad/protocol';

import { meshSessionViewSchema } from '@monad/protocol';
import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const meshSessionAdapter = createEntityAdapter<MeshSessionView, MeshSessionId>({
  selectId: (session) => session.id
});
export const meshSessionSelectors = meshSessionAdapter.getSelectors();

export const listMeshSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMeshSessions: builder.query<EntityState<MeshSessionView, MeshSessionId>, SessionId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.sessions.get({ query: { transcriptTargetId: sessionId } }),
          (raw) =>
            meshSessionAdapter.setAll(
              meshSessionAdapter.getInitialState(),
              raw.sessions.map((session) => meshSessionViewSchema.parse(session))
            )
        ),
      providesTags: (_result, _error, sessionId) => ['MeshSessions', { type: 'MeshSessions', id: sessionId }]
    })
  })
});

export const { useListMeshSessionsQuery } = listMeshSessionsApi;
