import type { ClarifyRespondRequest, ClarifyRespondResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Answer a pending clarify.requested with the user's free-text reply, unblocking the agent's tool.
export const clarifyRespondApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    clarifyRespond: builder.mutation<ClarifyRespondResponse, ClarifyRespondRequest>({
      queryFn: (body: ClarifyRespondRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.clarifications.respond.post(body)),
      invalidatesTags: ['Inbox']
    })
  })
});

export const { useClarifyRespondMutation } = clarifyRespondApi;
