import type { MeshAgentAuthSessionView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getMeshAgentAuthApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgentAuth: builder.query<MeshAgentAuthSessionView, { id: string; controlToken: string }>({
      queryFn: ({ id, controlToken }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh['auth-sessions']({ id }).get({ query: { controlToken } }),
          (raw) => raw.session
        ),
      async onCacheEntryAdded({ id, controlToken }, { cacheDataLoaded, cacheEntryRemoved, extra, updateCachedData }) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamMeshAgentAuth(id, controlToken, (session) => {
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

export const { useGetMeshAgentAuthQuery } = getMeshAgentAuthApi;
