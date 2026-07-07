import type { ExternalAgentInputRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface ExternalAgentInputArgs extends ExternalAgentInputRequest {
  id: string;
  controlToken: string;
}

const inputExternalAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inputExternalAgentAuth: builder.mutation<OkResponse, ExternalAgentInputArgs>({
      queryFn: ({ id, controlToken, input }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['external-agent-auth-sessions']({ id })
            .input.post({ input }, { query: { controlToken } })
        )
    })
  })
});

export const { useInputExternalAgentAuthMutation } = inputExternalAgentAuthApi;
