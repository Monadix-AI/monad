import type { NativeCliApprovalResolutionRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

interface NativeCliApprovalArgs extends NativeCliApprovalResolutionRequest {
  id: string;
}

export const approveNativeCliSessionApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    approveNativeCliSession: builder.mutation<OkResponse, NativeCliApprovalArgs>({
      queryFn: ({ id, requestId, allow, reason }, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1['native-cli-sessions']({ id }).approval.post({ requestId, allow, reason })
        )
    })
  })
});

export const { useApproveNativeCliSessionMutation } = approveNativeCliSessionApi;
