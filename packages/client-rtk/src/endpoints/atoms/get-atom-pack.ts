import type { GetAtomPackResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const getAtomPackApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAtomPack: builder.query<GetAtomPackResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.atoms({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'Atoms', id: name }]
    })
  })
});

export const { useGetAtomPackQuery } = getAtomPackApi;
