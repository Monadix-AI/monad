import type { GetHealthResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const getHealthApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getHealth: builder.query<GetHealthResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.health.get()),
      providesTags: ['Health']
    })
  })
});

export const { useGetHealthQuery } = getHealthApi;
