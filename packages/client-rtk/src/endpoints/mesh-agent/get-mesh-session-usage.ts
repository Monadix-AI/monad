import type { MeshAgentSessionUsage, SessionId } from '@monad/protocol';

import { meshAgentSessionUsageSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface MeshSessionUsageArgs {
  id: string;
  transcriptTargetId: SessionId;
}

const getMeshSessionUsageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshSessionUsage: builder.query<MeshAgentSessionUsage | null, MeshSessionUsageArgs>({
      keepUnusedDataFor: 0,
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.sessions({ id }).usage.get({ query: { transcriptTargetId } }),
          (raw) => meshAgentSessionUsageSchema.nullable().parse(raw.usage)
        ),
      async onCacheEntryAdded(
        { id, transcriptTargetId },
        { cacheDataLoaded, cacheEntryRemoved, updateCachedData, extra }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamMeshAgentSessionUsage(id, transcriptTargetId, (usage) =>
            updateCachedData(() => usage)
          );
        } catch {}
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useGetMeshSessionUsageQuery } = getMeshSessionUsageApi;
