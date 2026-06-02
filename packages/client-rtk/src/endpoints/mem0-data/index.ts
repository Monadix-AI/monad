import type { GetMem0DataResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const mem0DataApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getMem0Data: builder.query<GetMem0DataResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.mem0.get())
    })
  })
});

export const { useGetMem0DataQuery } = mem0DataApi;
