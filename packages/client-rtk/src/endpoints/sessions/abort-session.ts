import type { AbortSessionResponse, TranscriptTargetId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const abortSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    abortSession: builder.mutation<AbortSessionResponse, TranscriptTargetId>({
      queryFn: (id: TranscriptTargetId, api: { extra: unknown }) =>
        runTreaty(() =>
          id.startsWith('prj_')
            ? clientOf(api).treaty.v1.projects({ id }).abort.post()
            : clientOf(api).treaty.v1.sessions({ id }).abort.post()
        )
    })
  })
});

export const { useAbortSessionMutation } = abortSessionApi;
