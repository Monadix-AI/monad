import type { MeshEventPageRequest, MeshRawEventPage, SessionId } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface GetMeshAgentRawEventsArg {
  id: string;
  transcriptTargetId: SessionId;
  request: Omit<MeshEventPageRequest, 'view'>;
}

const getMeshAgentRawEventsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgentRawEvents: builder.query<MeshRawEventPage, GetMeshAgentRawEventsArg>({
      queryFn: async ({ id, transcriptTargetId, request }, api: { extra: unknown }) => {
        try {
          return { data: await clientOf(api).meshAgentRawEvents(id, transcriptTargetId, request) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useLazyGetMeshAgentRawEventsQuery } = getMeshAgentRawEventsApi;
