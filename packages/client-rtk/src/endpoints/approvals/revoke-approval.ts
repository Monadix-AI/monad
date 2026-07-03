import type { ApprovalMutationResponse, RevokeApprovalRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listApprovalsApi } from './list-approvals.ts';

export const revokeApprovalApi = listApprovalsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    revokeApproval: builder.mutation<ApprovalMutationResponse, RevokeApprovalRequest>({
      queryFn: (body: RevokeApprovalRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.approvals.revoke.post(body)),
      invalidatesTags: ['Approvals']
    })
  })
});

export const { useRevokeApprovalMutation } = revokeApprovalApi;
