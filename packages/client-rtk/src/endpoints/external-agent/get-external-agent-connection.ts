import type { ExternalAgentConnectionSnapshot, SessionId } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getExternalAgentConnectionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentConnection: builder.query<
      ExternalAgentConnectionSnapshot,
      { id: string; transcriptTargetId: SessionId }
    >({
      queryFn: async ({ id, transcriptTargetId }, api: { extra: unknown }) => {
        try {
          return { data: await clientOf(api).externalAgentConnection(id, transcriptTargetId) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useGetExternalAgentConnectionQuery, useLazyGetExternalAgentConnectionQuery } =
  getExternalAgentConnectionApi;
