import type { OkResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getUsageApi } from './get-usage.ts';

// Wipes the global usage ledger (a manual billing restart). Invalidates Usage so the panel refetches.
export const resetUsageApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    resetUsage: builder.mutation<OkResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.usage.reset.post()),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          getUsageApi.util.updateQueryData('getUsage', undefined, (draft) => {
            draft.totalCostUsd = 0;
            draft.totalInputTokens = 0;
            draft.totalOutputTokens = 0;
            draft.entries = [];
            draft.breakdown = [];
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Usage']
    })
  })
});

export const { useResetUsageMutation } = resetUsageApi;
