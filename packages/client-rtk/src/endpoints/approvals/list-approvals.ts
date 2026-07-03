import type { ApprovalRule, ListApprovalsQuery } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const approvalRuleAdapter = createEntityAdapter<ApprovalRule>();
export const approvalRuleSelectors = approvalRuleAdapter.getSelectors();

export const listApprovalsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listApprovals: builder.query<EntityState<ApprovalRule, string>, ListApprovalsQuery | undefined>({
      queryFn: (arg: ListApprovalsQuery | undefined, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.approvals.get({ query: { sessionId: arg?.sessionId } }),
          (raw) => approvalRuleAdapter.setAll(approvalRuleAdapter.getInitialState(), raw.rules)
        ),
      providesTags: ['Approvals']
    })
  })
});

export const { useListApprovalsQuery } = listApprovalsApi;
