import type { ProbeNetworkRequest, ProbeNetworkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { getNetworkApi } from './get-network.ts';

const probeNetworkApi = getNetworkApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    probeNetwork: builder.mutation<ProbeNetworkResponse, ProbeNetworkRequest>({
      queryFn: (body: ProbeNetworkRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.network.probe.post(body))
    })
  })
});

export const { useProbeNetworkMutation } = probeNetworkApi;
