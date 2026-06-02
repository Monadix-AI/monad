import type { ObscuraStatusResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getObscuraApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getObscura: builder.query<ObscuraStatusResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.obscura.get()),
      providesTags: ['Obscura']
    })
  })
});

export const { useGetObscuraQuery } = getObscuraApi;
