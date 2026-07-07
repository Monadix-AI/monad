import type { OkResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const stopExternalAgentSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    stopExternalAgentSession: builder.mutation<OkResponse, { id: string; transcriptTargetId: TranscriptTargetId }>({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['external-agent-sessions']({ id })
            .stop.post(undefined, { query: { transcriptTargetId } })
        ),
      invalidatesTags: ['ExternalAgentSessions']
    })
  })
});

export const { useStopExternalAgentSessionMutation } = stopExternalAgentSessionApi;
