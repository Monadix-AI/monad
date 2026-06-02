import type { ListProjectSessionsQuery, ListProjectSessionsResponse, ProjectId, Session } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice, type NormalizedPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const projectSessionAdapter = createEntityAdapter<Session, string>({ selectId: (s) => s.id });
export const projectSessionSelectors = projectSessionAdapter.getSelectors();

export type ListProjectSessionsArgs = { projectId: ProjectId } & ListProjectSessionsQuery;
export type ListProjectSessionsResult = NormalizedPaginateResponse<Session, 'sessions', ListProjectSessionsResponse>;

export const listProjectSessionsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listProjectSessions: builder.query<ListProjectSessionsResult, ListProjectSessionsArgs>({
      queryFn: (args, api: { extra: unknown }) => {
        const { limit, offset, projectId } = args;
        return runTreaty(
          () => clientOf(api).treaty.v1.projects({ id: projectId }).sessions.get({ query: { limit, offset } }),
          (raw) => ({
            ...raw,
            sessions: projectSessionAdapter.setAll(projectSessionAdapter.getInitialState(), raw.sessions)
          })
        );
      },
      providesTags: (_result, _error, { projectId }) => [{ type: 'Sessions', id: projectId }]
    })
  })
});

export const { useListProjectSessionsQuery } = listProjectSessionsApi;
