import type { ConsumeSessionAttentionRequest, ConsumeSessionAttentionResponse, SessionId } from '@monad/protocol';

import { consumeSessionAttentionResponseSchema } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type ConsumeSessionAttentionArgs = { sessionId: SessionId } & ConsumeSessionAttentionRequest;

const consumeSessionAttentionApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    consumeSessionAttention: builder.mutation<ConsumeSessionAttentionResponse, ConsumeSessionAttentionArgs>({
      queryFn: ({ sessionId, ...body }, api: { extra: unknown }) =>
        runTreaty(
          async () => {
            const response = await clientOf(api).fetch(
              `/v1/sessions/${encodeURIComponent(sessionId)}/attention/consume`,
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            );
            const value: unknown = await response.json();
            return response.ok
              ? { data: value, error: null }
              : { data: null, error: { status: response.status, value } };
          },
          (raw) => consumeSessionAttentionResponseSchema.parse(raw)
        ),
      invalidatesTags: ['SessionAttention']
    })
  })
});

export const { useConsumeSessionAttentionMutation } = consumeSessionAttentionApi;
