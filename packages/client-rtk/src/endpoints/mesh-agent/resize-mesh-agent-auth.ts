import type { MeshAgentResizeRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface MeshAgentResizeArgs extends MeshAgentResizeRequest {
  id: string;
  controlToken: string;
}

const resizeMeshAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resizeMeshAgentAuth: builder.mutation<OkResponse, MeshAgentResizeArgs>({
      queryFn: ({ id, controlToken, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.mesh['auth-sessions']({ id }).resize.post({ cols, rows }, { query: { controlToken } })
        )
    })
  })
});

export const { useResizeMeshAgentAuthMutation } = resizeMeshAgentAuthApi;
