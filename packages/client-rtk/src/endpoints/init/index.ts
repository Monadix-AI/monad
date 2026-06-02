import type { GetInitStatusResponse, OkResponse, SetInitHomeRequest } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const initApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    initStatus: builder.query<GetInitStatusResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.init.status.get()),
      providesTags: ['InitStatus']
    }),
    setInitHome: builder.mutation<OkResponse, SetInitHomeRequest>({
      queryFn: (args: SetInitHomeRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.init.home.post(args)),
      invalidatesTags: ['InitStatus']
    })
  })
});

export const { useInitStatusQuery, useSetInitHomeMutation } = initApi;
