import type { OkResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const stopNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    stopNativeCliSession: builder.mutation<OkResponse, { id: string; transcriptTargetId: TranscriptTargetId }>({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1['native-cli-sessions']({ id }).stop.post(undefined, { query: { transcriptTargetId } })
        ),
      invalidatesTags: ['NativeCliSessions']
    })
  })
});

export const { useStopNativeCliSessionMutation } = stopNativeCliSessionApi;
