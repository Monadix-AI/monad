import type { ListSessionPlanResponse, SessionId } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const listSessionPlanApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listSessionPlan: builder.query<ListSessionPlanResponse, SessionId>({
      queryFn: (sessionId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.sessions({ id: sessionId }).plan.get()),
      providesTags: (_result, _error, sessionId) => [{ type: 'SessionPlan', id: sessionId }]
    })
  })
});

export const { useListSessionPlanQuery } = listSessionPlanApi;
