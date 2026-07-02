import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const stopNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    stopNativeCliSession: builder.mutation<OkResponse, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-sessions']({ id }).stop.post()),
      invalidatesTags: ['NativeCliSessions']
    })
  })
});

export const { useStopNativeCliSessionMutation } = stopNativeCliSessionApi;
