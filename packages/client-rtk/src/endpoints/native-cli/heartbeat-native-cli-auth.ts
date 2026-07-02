import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const heartbeatNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    heartbeatNativeCliAuth: builder.mutation<OkResponse, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).heartbeat.post())
    })
  })
});

export const { useHeartbeatNativeCliAuthMutation } = heartbeatNativeCliAuthApi;
