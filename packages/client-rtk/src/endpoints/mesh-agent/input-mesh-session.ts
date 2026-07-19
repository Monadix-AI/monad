import type { MeshAgentInputRequest, OkResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface MeshAgentInputArgs extends MeshAgentInputRequest {
  id: string;
  transcriptTargetId: SessionId;
}

const inputMeshSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inputMeshSession: builder.mutation<OkResponse, MeshAgentInputArgs>({
      queryFn: ({ id, transcriptTargetId, input }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.mesh.sessions({ id }).input.post({ input }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useInputMeshSessionMutation } = inputMeshSessionApi;
