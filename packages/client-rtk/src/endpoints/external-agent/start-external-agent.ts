import type { ExternalAgentSessionView, SessionId, StartExternalAgentRequest } from '@monad/protocol';

import { externalAgentSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { externalAgentSessionAdapter, listExternalAgentSessionsApi } from './list-external-agent-sessions.ts';

interface StartExternalAgentArgs extends StartExternalAgentRequest {
  sessionId: SessionId;
}

const startExternalAgentApi = listExternalAgentSessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startExternalAgent: builder.mutation<ExternalAgentSessionView, StartExternalAgentArgs>({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.sessions({ id: sessionId })['external-agents'].start.post(body),
          (raw) => externalAgentSessionViewSchema.parse(raw.session)
        ),
      async onQueryStarted({ sessionId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            listExternalAgentSessionsApi.util.updateQueryData('listExternalAgentSessions', sessionId, (draft) => {
              externalAgentSessionAdapter.upsertOne(draft, data);
            })
          );
        } catch {}
      },
      invalidatesTags: (_result, _error, { sessionId }) => [
        'Sessions',
        'ExternalAgentSessions',
        { type: 'ExternalAgentSessions', id: sessionId }
      ]
    })
  })
});

export const { useStartExternalAgentMutation } = startExternalAgentApi;
