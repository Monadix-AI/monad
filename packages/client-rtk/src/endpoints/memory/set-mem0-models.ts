import type { OkResponse, SetMem0ModelsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { setMemoryBackendApi } from './set-memory-backend.ts';

export const setMem0ModelsApi = setMemoryBackendApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setMem0Models: builder.mutation<OkResponse, SetMem0ModelsRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.mem0.models.put(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { useSetMem0ModelsMutation } = setMem0ModelsApi;
