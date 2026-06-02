import type { OkResponse, PutMemoryCoreRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getMemoryCoreApi } from './get-memory-core.ts';

export const putMemoryCoreApi = getMemoryCoreApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    putMemoryCore: builder.mutation<OkResponse, PutMemoryCoreRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.core.put(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { usePutMemoryCoreMutation } = putMemoryCoreApi;
