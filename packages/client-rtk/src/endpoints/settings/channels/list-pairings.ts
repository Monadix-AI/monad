import type { ChannelId, ChannelPairingRequest } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { setChannelCredentialApi } from './set-channel-credential.ts';

export const listChannelPairingsApi = setChannelCredentialApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listChannelPairings: builder.query<ChannelPairingRequest[], ChannelId>({
      queryFn: (id: ChannelId, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings.channels({ id }).pairings.get(),
          (raw) => raw.pairings
        ),
      providesTags: ['Channels']
    })
  })
});

export const { useListChannelPairingsQuery } = listChannelPairingsApi;
