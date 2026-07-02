import type { NativeCliSessionView } from '@monad/protocol';

import { nativeCliSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliSession: builder.query<NativeCliSessionView, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-sessions']({ id }).get(),
          (raw) => nativeCliSessionViewSchema.parse(raw.session)
        )
    })
  })
});

export const { useGetNativeCliSessionQuery } = getNativeCliSessionApi;
