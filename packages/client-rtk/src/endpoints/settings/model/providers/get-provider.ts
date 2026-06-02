import type { GetProviderResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../../endpoint-helpers.ts';
import { listProvidersApi } from './list-providers.ts';

const getProviderApi = listProvidersApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getProvider: builder.query<GetProviderResponse, string>({
      queryFn: (id: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.model.providers({ id }).get()),
      providesTags: (_res, _err, id) => [{ type: 'Providers', id }]
    })
  })
});

export const { useGetProviderQuery } = getProviderApi;
