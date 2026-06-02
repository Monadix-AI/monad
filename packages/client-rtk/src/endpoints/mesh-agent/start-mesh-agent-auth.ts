import type { MeshAgentAuthSessionView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const startMeshAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    startMeshAgentAuth: builder.mutation<MeshAgentAuthSessionView, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.agents({ name }).auth.start.post(),
          (raw) => raw.session
        )
    })
  })
});

export const { useStartMeshAgentAuthMutation } = startMeshAgentAuthApi;
