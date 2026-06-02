import type { ApprovalRule } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Remembered approval rules (allow/deny across session/agent/global). Backs the settings "authorized"
// panel: list shows persisted + the active session's rules; revoke/clear mutate and re-fetch.
export const approvalsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listApprovals: builder.query<ApprovalRule[], { sessionId?: string } | undefined>({
      queryFn: (arg: { sessionId?: string } | undefined, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.approvals.get({ query: { sessionId: arg?.sessionId } }),
          (raw) => raw.rules
        ),
      providesTags: ['Approvals']
    }),
    revokeApproval: builder.mutation<{ ok: boolean; removed?: number }, { id: string }>({
      queryFn: (body: { id: string }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.approvals.revoke.post(body)),
      invalidatesTags: ['Approvals']
    }),
    clearApprovals: builder.mutation<
      { ok: boolean; removed?: number },
      { scope?: 'session' | 'agent' | 'global'; agentId?: string } | undefined
    >({
      queryFn: (
        body: { scope?: 'session' | 'agent' | 'global'; agentId?: string } | undefined,
        api: { extra: unknown }
      ) => runTreaty(() => clientOf(api).treaty.v1.approvals.clear.post(body ?? {})),
      invalidatesTags: ['Approvals']
    })
  })
});

export const { useListApprovalsQuery, useRevokeApprovalMutation, useClearApprovalsMutation } = approvalsApi;
