import type { ExternalAgentResizeRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface ExternalAgentResizeArgs extends ExternalAgentResizeRequest {
  id: string;
  controlToken: string;
}

const resizeExternalAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resizeExternalAgentAuth: builder.mutation<OkResponse, ExternalAgentResizeArgs>({
      queryFn: ({ id, controlToken, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['external-agent-auth-sessions']({ id })
            .resize.post({ cols, rows }, { query: { controlToken } })
        )
    })
  })
});

export const { useResizeExternalAgentAuthMutation } = resizeExternalAgentAuthApi;
