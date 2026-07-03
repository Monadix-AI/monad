import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const heartbeatNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    heartbeatNativeCliAuth: builder.mutation<OkResponse, { id: string; controlToken: string }>({
      queryFn: ({ id, controlToken }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).heartbeat.post(undefined, {
            query: { controlToken }
          })
        )
    })
  })
});

export const { useHeartbeatNativeCliAuthMutation } = heartbeatNativeCliAuthApi;
