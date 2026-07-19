import type { ExternalAgentHistoryPageRequest, ExternalAgentRawHistoryPage, SessionId } from '@monad/protocol';

import { clientOf, toError } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface GetExternalAgentRawHistoryArg {
  id: string;
  transcriptTargetId: SessionId;
  request: ExternalAgentHistoryPageRequest;
}

const getExternalAgentRawHistoryApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentRawHistory: builder.query<ExternalAgentRawHistoryPage, GetExternalAgentRawHistoryArg>({
      queryFn: async ({ id, transcriptTargetId, request }, api: { extra: unknown }) => {
        try {
          return { data: await clientOf(api).externalAgentRawHistory(id, transcriptTargetId, request) };
        } catch (err) {
          return { error: toError(err) };
        }
      }
    })
  })
});

export const { useLazyGetExternalAgentRawHistoryQuery } = getExternalAgentRawHistoryApi;
