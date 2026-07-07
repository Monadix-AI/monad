import type {
  ExternalAgentSessionView,
  ListExternalAgentRuntimesQuery,
  ListExternalAgentRuntimesResponse
} from '@monad/protocol';

import { listExternalAgentRuntimesResponseSchema } from '@monad/protocol';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { externalAgentSessionAdapter } from './list-external-agent-sessions.ts';

type ListExternalAgentSessionSummariesResult = NormalizedCursorPaginateResponse<
  ExternalAgentSessionView,
  'sessions',
  ListExternalAgentRuntimesResponse
>;

const listExternalAgentSessionSummariesApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listExternalAgentSessionSummaries: builder.query<
      ListExternalAgentSessionSummariesResult,
      ListExternalAgentRuntimesQuery | undefined
    >({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['external-agent-session-summaries'].get({ query: arg ?? {} }),
          (raw) => {
            const parsed = listExternalAgentRuntimesResponseSchema.parse(raw);
            return {
              ...parsed,
              sessions: externalAgentSessionAdapter.setAll(
                externalAgentSessionAdapter.getInitialState(),
                parsed.sessions
              )
            };
          }
        ),
      providesTags: ['ExternalAgentSessions']
    })
  })
});

export const { useListExternalAgentSessionSummariesQuery } = listExternalAgentSessionSummariesApi;
