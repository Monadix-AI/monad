import type { NativeCliAuthStatusResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getNativeCliAuthStatusApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliAuthStatus: builder.query<NativeCliAuthStatusResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1['native-cli-agents']({ name }).auth.status.get())
    })
  })
});

export const { useGetNativeCliAuthStatusQuery, useLazyGetNativeCliAuthStatusQuery } = getNativeCliAuthStatusApi;
