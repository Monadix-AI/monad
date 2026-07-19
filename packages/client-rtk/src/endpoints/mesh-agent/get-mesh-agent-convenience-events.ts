import type { MeshConvenienceEventPage, MeshEventPageRequest, SessionId } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface GetMeshAgentConvenienceEventsArg {
  id: string;
  transcriptTargetId: SessionId;
  request: Omit<MeshEventPageRequest, 'view'>;
}

const getMeshAgentConvenienceEventsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgentConvenienceEvents: builder.query<MeshConvenienceEventPage, GetMeshAgentConvenienceEventsArg>({
      queryFn: async ({ id, transcriptTargetId, request }, api: { extra: unknown }) => {
        try {
          return { data: await clientOf(api).meshAgentConvenienceEvents(id, transcriptTargetId, request) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useLazyGetMeshAgentConvenienceEventsQuery } = getMeshAgentConvenienceEventsApi;
