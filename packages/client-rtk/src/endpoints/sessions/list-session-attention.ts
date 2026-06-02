import type { ListSessionAttentionQuery, ListSessionAttentionResponse } from '@monad/protocol';

import { listSessionAttentionResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const listSessionAttentionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listSessionAttention: builder.query<ListSessionAttentionResponse, ListSessionAttentionQuery>({
      queryFn: (args, api: { extra: unknown }) =>
        runTreaty(
          async () => {
            const query = new URLSearchParams();
            for (const sessionId of args.sessionIds) query.append('sessionIds', sessionId);
            const response = await clientOf(api).fetch(`/v1/sessions/attention?${query}`);
            const value: unknown = await response.json();
            return response.ok
              ? { data: value, error: null }
              : { data: null, error: { status: response.status, value } };
          },
          (raw) => listSessionAttentionResponseSchema.parse(raw)
        ),
      providesTags: ['SessionAttention']
    })
  })
});

export const { useListSessionAttentionQuery } = listSessionAttentionApi;
