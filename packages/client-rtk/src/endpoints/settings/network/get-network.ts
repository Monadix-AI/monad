import type { NetworkSettings } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const getNetworkApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNetwork: builder.query<NetworkSettings, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.settings.network.get()),
      providesTags: ['NetworkSettings']
    })
  })
});

export const { useGetNetworkQuery } = getNetworkApi;
