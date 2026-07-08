import type { ProjectId, Session } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const projectSessionAdapter = createEntityAdapter<Session, string>({ selectId: (s) => s.id });
export const projectSessionSelectors = projectSessionAdapter.getSelectors();

const listProjectSessionsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listProjectSessions: builder.query<ReturnType<typeof projectSessionAdapter.getInitialState>, ProjectId>({
      queryFn: (projectId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.projects({ id: projectId }).sessions.get(),
          (raw) => projectSessionAdapter.setAll(projectSessionAdapter.getInitialState(), raw.sessions)
        ),
      providesTags: (_result, _error, projectId) => [{ type: 'Sessions', id: projectId }]
    })
  })
});

export const { useListProjectSessionsQuery } = listProjectSessionsApi;
