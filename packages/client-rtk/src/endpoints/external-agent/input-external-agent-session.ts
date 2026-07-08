import type { ExternalAgentInputRequest, OkResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface ExternalAgentInputArgs extends ExternalAgentInputRequest {
  id: string;
  transcriptTargetId: SessionId;
}

const inputExternalAgentSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inputExternalAgentSession: builder.mutation<OkResponse, ExternalAgentInputArgs>({
      queryFn: ({ id, transcriptTargetId, input }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['external-agent-sessions']({ id })
            .input.post({ input }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useInputExternalAgentSessionMutation } = inputExternalAgentSessionApi;
