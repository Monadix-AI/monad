import type { NativeCliUsageResponse } from '@monad/protocol';

import { nativeCliUsageResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getNativeCliUsageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliUsage: builder.query<NativeCliUsageResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-agents']({ name }).usage.get(),
          (raw) => nativeCliUsageResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetNativeCliUsageQuery, useLazyGetNativeCliUsageQuery } = getNativeCliUsageApi;
