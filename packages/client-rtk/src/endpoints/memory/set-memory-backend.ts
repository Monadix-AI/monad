import type { OkResponse, SetMemoryBackendRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getMemoryStatusApi } from './get-memory-status.ts';

export const setMemoryBackendApi = getMemoryStatusApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setMemoryBackend: builder.mutation<OkResponse, SetMemoryBackendRequest>({
      queryFn: (body, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.backend.put(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { useSetMemoryBackendMutation } = setMemoryBackendApi;
