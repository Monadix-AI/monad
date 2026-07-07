import type { ExternalAgentAuthSessionView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getExternalAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentAuth: builder.query<ExternalAgentAuthSessionView, { id: string; controlToken: string }>({
      queryFn: ({ id, controlToken }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['external-agent-auth-sessions']({ id }).get({ query: { controlToken } }),
          (raw) => raw.session
        ),
      async onCacheEntryAdded({ id, controlToken }, { cacheDataLoaded, cacheEntryRemoved, extra, updateCachedData }) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamExternalAgentAuth(id, controlToken, (session) => {
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

export const { useGetExternalAgentAuthQuery } = getExternalAgentAuthApi;
