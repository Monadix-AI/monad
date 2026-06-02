import type { ListSessionsQuery, ListSessionsResponse, Session } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice, type NormalizedPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const sessionAdapter = createEntityAdapter<Session, string>({ selectId: (s) => s.id });
export const sessionSelectors = sessionAdapter.getSelectors();

export type ListSessionsResult = NormalizedPaginateResponse<Session, 'sessions', ListSessionsResponse>;

export const listSessionsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listSessions: builder.query<ListSessionsResult, ListSessionsQuery | undefined>({
      queryFn: (args, api: { extra: unknown }) => {
        const { archived, limit, offset } = args ?? {};
        return runTreaty(
          () => clientOf(api).treaty.v1.sessions.get({ query: { archived, limit, offset } }),
          (raw) => ({
            ...raw,
            sessions: sessionAdapter.setAll(sessionAdapter.getInitialState(), raw.sessions)
          })
        );
      },
      providesTags: ['Sessions']
    })
  })
});

export const { useListSessionsQuery } = listSessionsApi;
