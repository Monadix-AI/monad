import type { NativeCliInputRequest, OkResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface NativeCliInputArgs extends NativeCliInputRequest {
  id: string;
  transcriptTargetId: TranscriptTargetId;
}

const inputNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    inputNativeCliSession: builder.mutation<OkResponse, NativeCliInputArgs>({
      queryFn: ({ id, transcriptTargetId, input }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api)
            .treaty.v1['native-cli-sessions']({ id })
            .input.post({ input }, { query: { transcriptTargetId } })
        )
    })
  })
});

export const { useInputNativeCliSessionMutation } = inputNativeCliSessionApi;
