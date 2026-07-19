import type { MeshAgentInputRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface MeshAgentInputArgs extends MeshAgentInputRequest {
  id: string;
  controlToken: string;
}

const inputMeshAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inputMeshAgentAuth: builder.mutation<OkResponse, MeshAgentInputArgs>({
      queryFn: ({ id, controlToken, input }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.mesh['auth-sessions']({ id }).input.post({ input }, { query: { controlToken } })
        )
    })
  })
});

export const { useInputMeshAgentAuthMutation } = inputMeshAgentAuthApi;
