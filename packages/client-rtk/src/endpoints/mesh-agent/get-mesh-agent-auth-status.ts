import type { MeshAgentAuthStatusResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getMeshAgentAuthStatusApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgentAuthStatus: builder.query<MeshAgentAuthStatusResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.mesh.agents({ name }).auth.status.get())
    })
  })
});

export const { useLazyGetMeshAgentAuthStatusQuery } = getMeshAgentAuthStatusApi;
