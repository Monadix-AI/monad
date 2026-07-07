import type {
  ExternalAgentHistoryPageRequest,
  ExternalAgentHistoryPageResponse,
  TranscriptTargetId
} from '@monad/protocol';

import { externalAgentHistoryPageRequestSchema, externalAgentHistoryPageResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

type GetExternalAgentHistoryPageArg = Partial<ExternalAgentHistoryPageRequest> & {
  before?: string | null;
  id: string;
  transcriptTargetId: TranscriptTargetId;
};

function normalizeExternalAgentHistoryPageQuery({
  before,
  id,
  itemsView,
  limit,
  sortDirection,
  transcriptTargetId
}: GetExternalAgentHistoryPageArg): {
  id: string;
  query: ExternalAgentHistoryPageRequest & { transcriptTargetId: TranscriptTargetId };
} {
  const request = externalAgentHistoryPageRequestSchema.parse({
    ...(before ? { before } : {}),
    itemsView: itemsView ?? 'full',
    limit,
    sortDirection
  });
  return { id, query: { ...request, transcriptTargetId } };
}

const getExternalAgentHistoryPageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentHistoryPage: builder.query<ExternalAgentHistoryPageResponse, GetExternalAgentHistoryPageArg>({
      queryFn: (args, api: { extra: unknown }) => {
        const { id, query } = normalizeExternalAgentHistoryPageQuery(args);
        return runTreaty(
          () =>
            clientOf(api).treaty.v1['external-agent-sessions']({ id })['history-page'].get({
              query
            }),
          (raw) => externalAgentHistoryPageResponseSchema.parse(raw)
        );
      }
    })
  })
});

export const { useLazyGetExternalAgentHistoryPageQuery } = getExternalAgentHistoryPageApi;
