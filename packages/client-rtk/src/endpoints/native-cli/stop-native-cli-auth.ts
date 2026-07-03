import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const stopNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    stopNativeCliAuth: builder.mutation<OkResponse, { id: string; controlToken: string }>({
      queryFn: ({ id, controlToken }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).stop.post(undefined, {
            query: { controlToken }
          })
        )
    })
  })
});

export const { useStopNativeCliAuthMutation } = stopNativeCliAuthApi;
