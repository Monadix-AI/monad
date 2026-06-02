import type { ListAtomPacksResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const listAtomPacksApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAtomPacks: builder.query<ListAtomPacksResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.atoms.get()),
      providesTags: ['Atoms']
    })
  })
});

export const { useListAtomPacksQuery } = listAtomPacksApi;
