import type { ToolApproveRequest, ToolApproveResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const approveToolApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    approveTool: builder.mutation<ToolApproveResponse, ToolApproveRequest>({
      queryFn: (body: ToolApproveRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.tools.approve.post(body))
    })
  })
});

export const { useApproveToolMutation } = approveToolApi;
