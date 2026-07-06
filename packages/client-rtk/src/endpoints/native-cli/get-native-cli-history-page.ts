import type { NativeCliHistoryPageRequest, NativeCliHistoryPageResponse, TranscriptTargetId } from '@monad/protocol';

import { nativeCliHistoryPageRequestSchema, nativeCliHistoryPageResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

type GetNativeCliHistoryPageArg = Partial<NativeCliHistoryPageRequest> & {
  before?: string | null;
  id: string;
  transcriptTargetId: TranscriptTargetId;
};

function normalizeNativeCliHistoryPageQuery({
  before,
  id,
  itemsView,
  limit,
  sortDirection,
  transcriptTargetId
}: GetNativeCliHistoryPageArg): {
  id: string;
  query: NativeCliHistoryPageRequest & { transcriptTargetId: TranscriptTargetId };
} {
  const request = nativeCliHistoryPageRequestSchema.parse({
    ...(before ? { before } : {}),
    itemsView: itemsView ?? 'full',
    limit,
    sortDirection
  });
  return { id, query: { ...request, transcriptTargetId } };
}

const getNativeCliHistoryPageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliHistoryPage: builder.query<NativeCliHistoryPageResponse, GetNativeCliHistoryPageArg>({
      queryFn: (args, api: { extra: unknown }) => {
        const { id, query } = normalizeNativeCliHistoryPageQuery(args);
        return runTreaty(
          () =>
            clientOf(api).treaty.v1['native-cli-sessions']({ id })['history-page'].get({
              query
            }),
          (raw) => nativeCliHistoryPageResponseSchema.parse(raw)
        );
      }
    })
  })
});

export const { useLazyGetNativeCliHistoryPageQuery } = getNativeCliHistoryPageApi;
