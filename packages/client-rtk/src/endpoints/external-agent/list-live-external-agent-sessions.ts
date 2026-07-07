import type {
  ExternalAgentSessionView,
  ListExternalAgentRuntimesQuery,
  ListExternalAgentRuntimesResponse
} from '@monad/protocol';

import { externalAgentSessionViewSchema } from '@monad/protocol';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';
import { externalAgentSessionAdapter } from './list-external-agent-sessions.ts';

type ListLiveExternalAgentSessionsResult = NormalizedCursorPaginateResponse<
  ExternalAgentSessionView,
  'sessions',
  ListExternalAgentRuntimesResponse
>;

// Daemon-wide list of every LIVE (starting/running) external agent/agent-adapter runtime across all
// projects. `streamControl` invalidates this cache from external_agent.started/exited notifications, so
// callers do not need their own interval polling.
const listLiveExternalAgentSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listLiveExternalAgentSessions: builder.query<
      ListLiveExternalAgentSessionsResult,
      ListExternalAgentRuntimesQuery | undefined
    >({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['external-agent-runtimes'].get({ query: arg ?? {} }),
          (raw) => ({
            ...raw,
            sessions: externalAgentSessionAdapter.setAll(
              externalAgentSessionAdapter.getInitialState(),
              raw.sessions.map((session) => externalAgentSessionViewSchema.parse(session))
            )
          })
        ),
      providesTags: ['ExternalAgentSessions']
    })
  })
});

export const { useListLiveExternalAgentSessionsQuery } = listLiveExternalAgentSessionsApi;
