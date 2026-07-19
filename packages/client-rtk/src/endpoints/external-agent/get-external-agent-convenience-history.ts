import type { ExternalAgentConvenienceFrame, ExternalAgentHistoryPageRequest, SessionId } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface GetExternalAgentConvenienceHistoryArg {
  id: string;
  transcriptTargetId: SessionId;
  request: ExternalAgentHistoryPageRequest;
}

const getExternalAgentConvenienceHistoryApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentConvenienceHistory: builder.query<
      ExternalAgentConvenienceFrame[],
      GetExternalAgentConvenienceHistoryArg
    >({
      queryFn: async ({ id, transcriptTargetId, request }, api: { extra: unknown }) => {
        try {
          return { data: await clientOf(api).externalAgentConvenienceHistory(id, transcriptTargetId, request) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useLazyGetExternalAgentConvenienceHistoryQuery } = getExternalAgentConvenienceHistoryApi;
