import type { ChannelId, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listChannelPairingsApi } from './list-pairings.ts';

const approveChannelPairingApi = listChannelPairingsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    approveChannelPairing: builder.mutation<OkResponse, { id: ChannelId; code: string }>({
      queryFn: ({ id, code }: { id: ChannelId; code: string }, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings.channels({ id }).pair.post({ code })),
      invalidatesTags: ['Channels']
    })
  })
});

export const { useApproveChannelPairingMutation } = approveChannelPairingApi;
