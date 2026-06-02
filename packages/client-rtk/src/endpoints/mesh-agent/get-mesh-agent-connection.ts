import type { MeshConnectionSnapshot, SessionId } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getMeshAgentConnectionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgentConnection: builder.query<MeshConnectionSnapshot, { id: string; transcriptTargetId: SessionId }>({
      queryFn: async ({ id, transcriptTargetId }, api: { extra: unknown }) => {
        try {
          return { data: await clientOf(api).meshAgentConnection(id, transcriptTargetId) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useGetMeshAgentConnectionQuery, useLazyGetMeshAgentConnectionQuery } = getMeshAgentConnectionApi;
