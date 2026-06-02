import type { PickDirectoryRequest, PickDirectoryResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// Open the host's native folder picker and resolve to the chosen absolute path (path:null on cancel).
const pickDirectoryApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    pickDirectory: builder.mutation<PickDirectoryResponse, PickDirectoryRequest>({
      queryFn: (body: PickDirectoryRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.system['pick-directory'].post(body))
    })
  })
});

export const { usePickDirectoryMutation } = pickDirectoryApi;
