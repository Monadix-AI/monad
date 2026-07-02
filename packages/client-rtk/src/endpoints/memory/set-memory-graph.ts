import type { OkResponse, SetMemoryGraphRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { setMem0ModelsApi } from './set-mem0-models.ts';

export const setMemoryGraphApi = setMem0ModelsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setMemoryGraph: builder.mutation<OkResponse, SetMemoryGraphRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.graph.put(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { useSetMemoryGraphMutation } = setMemoryGraphApi;
