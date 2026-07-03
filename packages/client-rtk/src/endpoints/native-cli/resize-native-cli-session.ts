import type { NativeCliResizeRequest, OkResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface NativeCliResizeArgs extends NativeCliResizeRequest {
  id: string;
  transcriptTargetId: TranscriptTargetId;
}

const resizeNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resizeNativeCliSession: builder.mutation<OkResponse, NativeCliResizeArgs>({
      queryFn: ({ id, transcriptTargetId, cols, rows }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['native-cli-sessions']({ id })
            .resize.post({ cols, rows }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useResizeNativeCliSessionMutation } = resizeNativeCliSessionApi;
