import type { NativeCliSessionView, TranscriptTargetId } from '@monad/protocol';

import { nativeCliSessionViewSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliSession: builder.query<NativeCliSessionView, { id: string; transcriptTargetId: TranscriptTargetId }>({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-cli-sessions']({ id }).get({ query: { transcriptTargetId } }),
          (raw) => nativeCliSessionViewSchema.parse(raw.session)
        )
    })
  })
});

export const { useGetNativeCliSessionQuery } = getNativeCliSessionApi;
