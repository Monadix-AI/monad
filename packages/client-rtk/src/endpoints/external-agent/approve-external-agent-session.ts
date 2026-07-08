import type { ExternalAgentApprovalResolutionRequest, OkResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface ExternalAgentApprovalArgs extends ExternalAgentApprovalResolutionRequest {
  id: string;
  transcriptTargetId: SessionId;
}

const approveExternalAgentSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    approveExternalAgentSession: builder.mutation<OkResponse, ExternalAgentApprovalArgs>({
      queryFn: ({ id, transcriptTargetId, requestId, allow, reason }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['external-agent-sessions']({ id })
            .approval.post({ requestId, allow, reason }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useApproveExternalAgentSessionMutation } = approveExternalAgentSessionApi;
