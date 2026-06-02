import type { NetworkSettings, SetNetworkSettingsRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getNetworkApi } from './get-network.ts';

const setNetworkApi = getNetworkApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setNetwork: builder.mutation<NetworkSettings, SetNetworkSettingsRequest>({
      queryFn: (body: SetNetworkSettingsRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.network.put(body)),
      invalidatesTags: ['NetworkSettings', 'Health']
    })
  })
});

export const { useSetNetworkMutation } = setNetworkApi;
