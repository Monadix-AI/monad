import type { ExternalAgentSessionView, TranscriptTargetId } from '@monad/protocol';

import { externalAgentSessionViewSchema } from '@monad/protocol';
import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const externalAgentSessionAdapter = createEntityAdapter<ExternalAgentSessionView>();
export const externalAgentSessionSelectors = externalAgentSessionAdapter.getSelectors();

export const listExternalAgentSessionsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listExternalAgentSessions: builder.query<EntityState<ExternalAgentSessionView, string>, TranscriptTargetId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(
          () =>
            sessionId.startsWith('prj_')
              ? clientOf(api).treaty.v1.projects({ id: sessionId })['external-agent-sessions'].get()
              : clientOf(api).treaty.v1.sessions({ id: sessionId })['external-agent-sessions'].get(),
          (raw) =>
            externalAgentSessionAdapter.setAll(
              externalAgentSessionAdapter.getInitialState(),
              raw.sessions.map((session) => externalAgentSessionViewSchema.parse(session))
            )
        ),
      providesTags: (_result, _error, sessionId) => [
        'ExternalAgentSessions',
        { type: 'ExternalAgentSessions', id: sessionId }
      ]
    })
  })
});

export const { useListExternalAgentSessionsQuery } = listExternalAgentSessionsApi;
