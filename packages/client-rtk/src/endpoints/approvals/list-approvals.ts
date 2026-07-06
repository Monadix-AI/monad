import type { ApprovalRule, ListApprovalsQuery, ListApprovalsResponse } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { apiSlice, type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const approvalRuleAdapter = createEntityAdapter<ApprovalRule>();
export const approvalRuleSelectors = approvalRuleAdapter.getSelectors();

export type ListApprovalsResult = NormalizedCursorPaginateResponse<ApprovalRule, 'rules', ListApprovalsResponse>;

export const listApprovalsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listApprovals: builder.query<ListApprovalsResult, ListApprovalsQuery | undefined>({
      queryFn: (arg: ListApprovalsQuery | undefined, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api).treaty.v1.approvals.get({
              query: { sessionId: arg?.sessionId, limit: arg?.limit, before: arg?.before }
            }),
          (raw) => ({
            ...raw,
            rules: approvalRuleAdapter.setAll(approvalRuleAdapter.getInitialState(), raw.rules)
          })
        ),
      providesTags: ['Approvals']
    })
  })
});

export const { useListApprovalsQuery } = listApprovalsApi;
