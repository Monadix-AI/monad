import type { BranchSessionRequest, BranchSessionResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Fork a session into a child at an optional message checkpoint. The control stream pushes the new
// session, so invalidating Sessions keeps the list live for clients not subscribed to it.
export const branchSessionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    branchSession: builder.mutation<BranchSessionResponse, { id: SessionId } & BranchSessionRequest>({
      queryFn: ({ id, ...body }: { id: SessionId } & BranchSessionRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id }).branch.post(body)),
      invalidatesTags: ['Sessions']
    })
  })
});

export const { useBranchSessionMutation } = branchSessionApi;
