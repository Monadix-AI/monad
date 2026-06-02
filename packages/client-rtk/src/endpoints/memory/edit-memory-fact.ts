import type { EditMemoryFactRequest, MemoryFactResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { addMemoryFactApi } from './add-memory-fact.ts';

export const editMemoryFactApi = addMemoryFactApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    editMemoryFact: builder.mutation<MemoryFactResponse, EditMemoryFactRequest>({
      queryFn: ({ id, ...body }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.memory.facts({ id }).patch(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { useEditMemoryFactMutation } = editMemoryFactApi;
