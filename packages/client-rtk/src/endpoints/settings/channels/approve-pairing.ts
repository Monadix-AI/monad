import type { ApproveChannelPairingRequest, ChannelId, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listChannelPairingsApi } from './list-pairings.ts';

const approveChannelPairingApi = listChannelPairingsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    approveChannelPairing: builder.mutation<OkResponse, { id: ChannelId } & ApproveChannelPairingRequest>({
      queryFn: ({ id, code }: { id: ChannelId } & ApproveChannelPairingRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id }).pair.post({ code })),
      invalidatesTags: ['Channels']
    })
  })
});

export const { useApproveChannelPairingMutation } = approveChannelPairingApi;
