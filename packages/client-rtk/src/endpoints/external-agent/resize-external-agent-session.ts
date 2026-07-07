import type { ExternalAgentResizeRequest, OkResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface ExternalAgentResizeArgs extends ExternalAgentResizeRequest {
  id: string;
  transcriptTargetId: TranscriptTargetId;
}

const resizeExternalAgentSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resizeExternalAgentSession: builder.mutation<OkResponse, ExternalAgentResizeArgs>({
      queryFn: ({ id, transcriptTargetId, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['external-agent-sessions']({ id })
            .resize.post({ cols, rows }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useResizeExternalAgentSessionMutation } = resizeExternalAgentSessionApi;
