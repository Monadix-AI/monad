import type { MeshAgentResizeRequest, OkResponse, SessionId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface MeshAgentResizeArgs extends MeshAgentResizeRequest {
  id: string;
  transcriptTargetId: SessionId;
}

const resizeMeshSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resizeMeshSession: builder.mutation<OkResponse, MeshAgentResizeArgs>({
      queryFn: ({ id, transcriptTargetId, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.mesh.sessions({ id }).resize.post({ cols, rows }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useResizeMeshSessionMutation } = resizeMeshSessionApi;
