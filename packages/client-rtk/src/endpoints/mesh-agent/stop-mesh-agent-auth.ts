import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const stopMeshAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    stopMeshAgentAuth: builder.mutation<OkResponse, { id: string; controlToken: string }>({
      queryFn: ({ id, controlToken }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.mesh['auth-sessions']({ id }).stop.post(undefined, {
            query: { controlToken }
          })
        )
    })
  })
});

export const { useStopMeshAgentAuthMutation } = stopMeshAgentAuthApi;
