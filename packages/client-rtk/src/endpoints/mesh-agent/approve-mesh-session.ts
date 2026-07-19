import type { MeshAgentApprovalResolutionRequest, OkResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface MeshAgentApprovalArgs extends MeshAgentApprovalResolutionRequest {
  id: string;
  transcriptTargetId: SessionId;
}

const approveMeshSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    approveMeshSession: builder.mutation<OkResponse, MeshAgentApprovalArgs>({
      queryFn: ({ id, transcriptTargetId, requestId, allow, reason }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1.mesh.sessions({ id })
            .approval.post({ requestId, allow, reason }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useApproveMeshSessionMutation } = approveMeshSessionApi;
