import type { ForgetMemoryFactRequest, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { editMemoryFactApi } from './edit-memory-fact.ts';

export const memoryApi = editMemoryFactApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    forgetMemoryFact: builder.mutation<OkResponse, ForgetMemoryFactRequest>({
      queryFn: ({ id, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.memory.facts({ id }).delete(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { useForgetMemoryFactMutation } = memoryApi;
