import type { AddMemoryFactRequest, MemoryFactResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { putMemoryCoreApi } from './put-memory-core.ts';

export const addMemoryFactApi = putMemoryCoreApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    addMemoryFact: builder.mutation<MemoryFactResponse, AddMemoryFactRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.facts.post(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { useAddMemoryFactMutation } = addMemoryFactApi;
