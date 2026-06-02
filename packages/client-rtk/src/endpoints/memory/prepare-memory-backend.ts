import type { OkResponse, SetMemoryBackendRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { setMemoryBackendApi } from './set-memory-backend.ts';

export const prepareMemoryBackendApi = setMemoryBackendApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    prepareMemoryBackend: builder.mutation<OkResponse, SetMemoryBackendRequest>({
      queryFn: (body, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.memory.backend.prepare.post(body)),
      invalidatesTags: ['Memory']
    })
  })
});

export const { usePrepareMemoryBackendMutation } = prepareMemoryBackendApi;
