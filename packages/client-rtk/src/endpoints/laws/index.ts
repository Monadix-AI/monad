import type { GetLawsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const lawsApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getLaws: builder.query<GetLawsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.memory.laws.get())
    })
  })
});

export const { useGetLawsQuery } = lawsApi;
