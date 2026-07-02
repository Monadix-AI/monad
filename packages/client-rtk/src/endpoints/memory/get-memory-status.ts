import type { MemoryStatusResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const getMemoryStatusApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMemoryStatus: builder.query<MemoryStatusResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.status.get()),
      providesTags: ['Memory']
    })
  })
});

export const { useGetMemoryStatusQuery } = getMemoryStatusApi;
