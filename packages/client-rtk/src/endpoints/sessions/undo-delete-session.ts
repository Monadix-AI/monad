import type { SessionId, UndoDeleteSessionResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const undoDeleteSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    undoDeleteSession: builder.mutation<UndoDeleteSessionResponse, SessionId>({
      queryFn: (id: SessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id })['undo-delete'].post()),
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useUndoDeleteSessionMutation } = undoDeleteSessionApi;
