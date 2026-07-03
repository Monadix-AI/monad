import type { ApprovalMutationResponse, ClearApprovalsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { revokeApprovalApi } from './revoke-approval.ts';

export const approvalsApi = revokeApprovalApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    clearApprovals: builder.mutation<ApprovalMutationResponse, ClearApprovalsRequest | undefined>({
      queryFn: (body: ClearApprovalsRequest | undefined, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.approvals.clear.post(body ?? {})),
      invalidatesTags: ['Approvals']
    })
  })
});

export const { useClearApprovalsMutation } = approvalsApi;
