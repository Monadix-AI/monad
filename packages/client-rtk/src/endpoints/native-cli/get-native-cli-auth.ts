import type { NativeCliAuthSessionView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getNativeCliAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliAuth: builder.query<NativeCliAuthSessionView, string>({
      queryFn: (id, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-auth-sessions']({ id }).get(),
          (raw) => raw.session
        ),
      async onCacheEntryAdded(id, { cacheDataLoaded, cacheEntryRemoved, extra, updateCachedData }) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamNativeCliAuth(id, (session) => {
            updateCachedData(() => session);
          });
        } catch {
          // Initial snapshot failures are surfaced by queryFn; cache removal still cleans up below.
        }
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useGetNativeCliAuthQuery } = getNativeCliAuthApi;
