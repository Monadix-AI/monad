import type { ResetSessionResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const resetSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resetSession: builder.mutation<ResetSessionResponse, SessionId>({
      queryFn: (id: SessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).reset.post()),
      invalidatesTags: ['Messages', 'Sessions']
    })
  })
});

export const { useResetSessionMutation } = resetSessionApi;
